"use strict";

/**
 * Simple JSON-backed storage for users and threads.
 * Author: Saifullah Al Neoaz (https://github.com/lazyneoaz)
 */

const fs = require("fs");
const path = require("path");
const { GitHubSync } = require("./githubSync");

class Store {
	constructor(file, defaults, onWrite) {
		this.file = file;
		this.defaults = defaults;
		this.onWrite = typeof onWrite === "function" ? onWrite : null; // called after every local save (GitHub push hook)
		this.data = {};
		this._writeTimer = null;
		this._load();
	}

	_load() {
		try {
			if (fs.existsSync(this.file))
				this.data = JSON.parse(fs.readFileSync(this.file, "utf8")) || {};
		}
		catch (error) {
			this.data = {};
		}
	}

	_schedule() {
		if (this._writeTimer) return;
		this._writeTimer = setTimeout(() => {
			this._writeTimer = null;
			this.flush();
		}, 250);
		if (this._writeTimer.unref) this._writeTimer.unref();
	}

	flush() {
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			// Write to a temp file and rename so a crash mid-write cannot leave a
			// truncated/corrupt database behind on a long-running bot.
			const tmp = this.file + ".tmp";
			fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
			fs.renameSync(tmp, this.file);
			if (this.onWrite) this.onWrite();
		}
		catch (error) {
			// Never swallow this: a read-only disk or a full volume would otherwise
			// lose every stored user/thread silently for the life of the process.
			require("./logger").warn("DATABASE", `Could not save ${path.basename(this.file)}: ${error.message}`);
		}
	}

	get(id) {
		return this.data[id] || null;
	}

	set(id, patch) {
		const current = this.data[id] || JSON.parse(JSON.stringify(this.defaults));
		const next = Object.assign({}, current, patch);
		this.data[id] = next;
		this._schedule();
		return next;
	}

	ensure(id, patch = {}) {
		if (!this.data[id]) {
			this.data[id] = Object.assign(JSON.parse(JSON.stringify(this.defaults)), patch);
			this._schedule();
		}
		return this.data[id];
	}

	update(id, patch) {
		const current = this.data[id];
		if (!current) return null;
		Object.assign(current, patch);
		this._schedule();
		return current;
	}

	all() {
		return Object.values(this.data);
	}

	count() {
		return Object.keys(this.data).length;
	}
}

function createDatabase(config) {
	const dir = path.join(path.resolve(__dirname, ".."), config.database.dir);
	fs.mkdirSync(dir, { recursive: true });

	// ---- GitHub storage (instead of a hosted database) -------------------
	const gh = (config.database && config.database.github) || {};
	const log = require("./logger");
	const sync = new GitHubSync({
		token: process.env.GITHUB_TOKEN || gh.token,
		repo: process.env.GITHUB_REPO || gh.repo,
		branch: process.env.GITHUB_BRANCH || gh.branch,
		path: process.env.GITHUB_PATH || gh.path,
		pushDelayMs: gh.pushDelayMs,
		log: { info: (t, m) => log.info(t, m), warn: (t, m) => log.warn(t, m) }
	});
	const root = path.resolve(__dirname, "..");
	sync.register("users.json", path.join(dir, "users.json"));
	sync.register("threads.json", path.join(dir, "threads.json"));
	// Extra files that commands write on their own (relative to the project root).
	const extra = Array.isArray(gh.extraFiles) ? gh.extraFiles : ["commands/cache/autoreact.json"];
	for (const rel of extra) sync.register(rel, path.join(root, rel));

	const users = new Store(path.join(dir, "users.json"), {
		userID: null,
		name: null,
		username: null,
		firstSeen: Date.now(),
		banned: { status: false, reason: null, date: null },
		settings: {},
		data: {}
	}, () => sync.markDirty("users.json"));

	const threads = new Store(path.join(dir, "threads.json"), {
		threadID: null,
		name: null,
		isGroup: false,
		// True once the thread's type has been confirmed against the API, so we
		// do not re-fetch getThreadInfo on every message.
		groupKnown: false,
		members: [],
		adminIDs: [],
		settings: {},
		data: {}
	}, () => sync.markDirty("threads.json"));

	return {
		dir,
		users,
		threads,
		sync,
		/** Call once before commands load: pulls saved data from GitHub. */
		async init() {
			if (!sync.enabled) {
				log.warn("GITHUB", "GitHub storage is OFF (set GITHUB_TOKEN and GITHUB_REPO=owner/repo). Data is only saved on local disk.");
				return;
			}
			await sync.hydrate();
			users._load();
			threads._load();
			sync.watchFiles(extra);
			log.info("GITHUB", `storage ON -> ${sync.repo}@${sync.branch}/${sync.prefix}`);
		},
		flush() {
			users.flush();
			threads.flush();
		},
		/** Shutdown: save locally, then push everything to GitHub. */
		async flushRemote() {
			users.flush();
			threads.flush();
			await sync.flushAll();
		}
	};
}

module.exports = { Store, createDatabase };
