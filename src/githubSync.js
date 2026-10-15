"use strict";

/**
 * GitHub-backed persistence (replaces a MongoDB-style hosted database).
 *
 * Why: hosts like Render / free containers wipe the local disk on every
 * redeploy, so data/users.json and data/threads.json would be lost. This keeps
 * a copy of those files in a GitHub repo through the Contents API:
 *
 *   - on boot   : pull the files from GitHub into the local data folder
 *   - on change : push the changed files back (debounced, so GitHub is not
 *                 hit on every message and the commit history stays small)
 *   - on stop   : push everything immediately
 *
 * Needs Node 18+ (built-in fetch). No extra npm package.
 *
 * Settings (environment wins over config.json -> database.github):
 *   GITHUB_TOKEN   personal access token (repo contents: read & write)
 *   GITHUB_REPO    "owner/repo"  (use a PRIVATE repo: user data lives there)
 *   GITHUB_BRANCH  default "main"
 *   GITHUB_PATH    folder inside the repo, default "bot-data"
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = "https://api.github.com";

function sha1Blob(buf) {
	// Same hash GitHub uses for a blob, lets us skip pushes when nothing changed.
	return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

class GitHubSync {
	constructor(options = {}) {
		this.token = options.token || "";
		this.repo = options.repo || "";
		this.branch = options.branch || "main";
		this.prefix = String(options.path || "bot-data").replace(/^\/+|\/+$/g, "");
		this.pushDelay = Number(options.pushDelayMs) || 20000;
		this.log = options.log || { info() { }, warn() { } };
		this.shas = new Map();      // remote name -> last known blob sha
		this.files = new Map();     // remote name -> absolute local path
		this.dirty = new Set();     // remote names waiting to be pushed
		this.timer = null;
		this.running = Promise.resolve();
	}

	get enabled() {
		return !!(this.token && /^[^/\s]+\/[^/\s]+$/.test(this.repo));
	}

	_headers() {
		return {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "instabot-github-sync"
		};
	}

	_url(name) {
		const rel = `${this.prefix ? this.prefix + "/" : ""}${name}`;
		return `${API}/repos/${this.repo}/contents/${rel.split("/").map(encodeURIComponent).join("/")}`;
	}

	register(name, localFile) {
		this.files.set(name, localFile);
	}

	/** Download one file. Returns the Buffer, or null when it does not exist yet. */
	async pull(name) {
		const res = await fetch(`${this._url(name)}?ref=${encodeURIComponent(this.branch)}`, { headers: this._headers() });
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`GitHub GET ${name} -> ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
		const json = await res.json();
		this.shas.set(name, json.sha);
		if (json.content && json.encoding === "base64") return Buffer.from(json.content, "base64");
		// Files over 1 MB come back without inline content: use the raw media type.
		const raw = await fetch(`${this._url(name)}?ref=${encodeURIComponent(this.branch)}`, {
			headers: { ...this._headers(), Accept: "application/vnd.github.raw+json" }
		});
		if (!raw.ok) throw new Error(`GitHub GET(raw) ${name} -> ${raw.status}`);
		return Buffer.from(await raw.arrayBuffer());
	}

	async _put(name, buf) {
		for (let attempt = 0; attempt < 3; attempt++) {
			const body = {
				message: `bot data: ${name} @ ${new Date().toISOString()}`,
				content: buf.toString("base64"),
				branch: this.branch
			};
			if (this.shas.get(name)) body.sha = this.shas.get(name);
			const res = await fetch(this._url(name), {
				method: "PUT",
				headers: { ...this._headers(), "Content-Type": "application/json" },
				body: JSON.stringify(body)
			});
			if (res.ok) {
				const json = await res.json();
				this.shas.set(name, json.content && json.content.sha);
				return true;
			}
			// 409/422 = our sha is stale (or file appeared meanwhile): refresh and retry.
			if (res.status === 409 || res.status === 422) {
				const probe = await fetch(`${this._url(name)}?ref=${encodeURIComponent(this.branch)}`, { headers: this._headers() });
				if (probe.ok) this.shas.set(name, (await probe.json()).sha);
				else if (probe.status === 404) this.shas.delete(name);
				continue;
			}
			throw new Error(`GitHub PUT ${name} -> ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
		}
		throw new Error(`GitHub PUT ${name} kept conflicting`);
	}

	/**
	 * Boot step: for each registered file, GitHub is the source of truth.
	 * If GitHub has it, write it locally. If not, upload the local copy (first run).
	 */
	async hydrate() {
		if (!this.enabled) return false;
		for (const [name, file] of this.files) {
			try {
				const remote = await this.pull(name);
				if (remote) {
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, remote);
					this.log.info("GITHUB", `loaded ${name} (${remote.length} bytes)`);
				}
				else if (fs.existsSync(file)) {
					await this._put(name, fs.readFileSync(file));
					this.log.info("GITHUB", `created ${name} on GitHub from local copy`);
				}
			}
			catch (error) {
				this.log.warn("GITHUB", `could not load ${name}: ${error.message}`);
			}
		}
		return true;
	}

	/** Mark a file as changed; it is pushed after a short quiet period. */
	markDirty(name) {
		if (!this.enabled) return;
		this.dirty.add(name);
		if (this.timer) return;
		this.timer = setTimeout(() => { this.timer = null; this.pushDirty(); }, this.pushDelay);
		if (this.timer.unref) this.timer.unref();
	}

	/** Push every file that changed. Serialised so two pushes never race on the same sha. */
	pushDirty() {
		if (!this.enabled) return Promise.resolve();
		this.running = this.running.then(async () => {
			const names = Array.from(this.dirty);
			this.dirty.clear();
			for (const name of names) {
				const file = this.files.get(name);
				try {
					if (!file || !fs.existsSync(file)) continue;
					const buf = fs.readFileSync(file);
					if (this.shas.get(name) && sha1Blob(buf) === this.shas.get(name)) continue;
					await this._put(name, buf);
				}
				catch (error) {
					this.dirty.add(name); // try again next round
					this.log.warn("GITHUB", `could not save ${name}: ${error.message}`);
				}
			}
			if (this.dirty.size && !this.timer) {
				this.timer = setTimeout(() => { this.timer = null; this.pushDirty(); }, this.pushDelay * 3);
				if (this.timer.unref) this.timer.unref();
			}
		}).catch(() => { });
		return this.running;
	}

	/** Shutdown: push everything now. */
	async flushAll() {
		if (!this.enabled) return;
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
		for (const name of this.files.keys()) this.dirty.add(name);
		await this.pushDirty();
	}

	/** Watch plain files that commands write themselves (e.g. autoreact.json). */
	watchFiles(names, intervalMs = 60000) {
		if (!this.enabled || !names.length) return;
		const last = new Map();
		const timer = setInterval(() => {
			for (const name of names) {
				const file = this.files.get(name);
				try {
					if (!file || !fs.existsSync(file)) continue;
					const h = sha1Blob(fs.readFileSync(file));
					if (last.has(name) && last.get(name) !== h) this.markDirty(name);
					last.set(name, h);
				}
				catch (_) { /* ignore */ }
			}
		}, intervalMs);
		if (timer.unref) timer.unref();
	}
}

module.exports = { GitHubSync };
