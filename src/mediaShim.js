"use strict";

/**
 * Direct-mode media shim.
 *
 * In server mode auth.js provides sendImage / sendVideo / sendAudio / sendMusic /
 * musicSearch. The local @lazyneoaz/ig-chat-api package (direct mode) does not, so
 * every GoatBot-style command that sends media failed with
 * "api.sendImage is not a function". This adds the missing methods, with the SAME
 * signatures auth.js exposes, on top of sendMessage({ attachment }):
 *
 *   sendImage(src, threadID, caption, cb, reply)
 *   sendVideo(src, threadID, [caption,] cb, reply)
 *   sendAudio(src, threadID, cb, reply)
 *
 * src = URL | path | Buffer | stream | { buffer|stream|path|url, filename, contentType }
 * Methods that already exist on the api are never replaced.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const log = require("./logger");

const TMP = path.join(os.tmpdir(), "instabot-media");
try { fs.mkdirSync(TMP, { recursive: true }); } catch (_) { /* ignore */ }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_EXT = { image: ".jpg", video: ".mp4", audio: ".m4a" };
const MIME_EXT = {
	"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
	"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
	"audio/mp4": ".m4a", "audio/aac": ".aac", "audio/mpeg": ".mp3", "audio/ogg": ".ogg", "audio/webm": ".webm"
};

const rand = () => Math.random().toString(36).slice(2, 12);
const isStream = v => v && typeof v === "object" && typeof v.pipe === "function" && typeof v.on === "function";

function extFor(kind, { filename, contentType, url } = {}) {
	const byName = filename && path.extname(String(filename)).toLowerCase();
	if (byName) return byName;
	const byMime = contentType && MIME_EXT[String(contentType).split(";")[0].trim().toLowerCase()];
	if (byMime) return byMime;
	if (url) {
		try {
			const e = path.extname(new URL(url).pathname).toLowerCase();
			if (e && e.length <= 5) return e;
		}
		catch (_) { /* ignore */ }
	}
	return DEFAULT_EXT[kind];
}

function drain(stream) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on("data", c => chunks.push(c));
		stream.on("end", () => resolve(Buffer.concat(chunks)));
		stream.on("error", reject);
	});
}

async function fetchBuffer(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 90000);
	try {
		const headers = { "User-Agent": UA, "Accept": "*/*" };
		try { if (new URL(url).hostname.includes("tiktok")) headers.Referer = "https://www.tiktok.com/"; } catch (_) { /* ignore */ }
		const res = await fetch(url, { headers, redirect: "follow", signal: controller.signal });
		if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
		const buffer = Buffer.from(await res.arrayBuffer());
		if (!buffer.length) throw new Error("download was empty");
		return { buffer, contentType: res.headers.get("content-type") || "" };
	}
	finally { clearTimeout(timer); }
}

/** Put whatever we were given on disk. Returns { file, temp }. */
async function toFile(src, kind) {
	if (Array.isArray(src)) src = src[0];
	if (src == null) throw new Error("no media source given");

	let opts = {};
	if (typeof src === "object" && !Buffer.isBuffer(src) && !isStream(src)) {
		opts = { filename: src.filename || src.fileName, contentType: src.contentType || src.mimetype || src.mimeType };
		const inner = src.buffer || src.stream || src.path || src.url;
		if (inner == null) throw new Error("media object has no buffer/stream/path/url");
		src = inner;
	}

	if (Buffer.isBuffer(src)) {
		const file = path.join(TMP, `${rand()}${extFor(kind, opts)}`);
		fs.writeFileSync(file, src);
		return { file, temp: true };
	}
	if (isStream(src)) {
		const ext = src.path ? path.extname(String(src.path)).toLowerCase() : "";
		const file = path.join(TMP, `${rand()}${ext || extFor(kind, opts)}`);
		fs.writeFileSync(file, await drain(src));
		return { file, temp: true };
	}
	src = String(src);
	if (/^https?:\/\//i.test(src)) {
		const { buffer, contentType } = await fetchBuffer(src);
		const file = path.join(TMP, `${rand()}${extFor(kind, { ...opts, contentType: opts.contentType || contentType, url: src })}`);
		fs.writeFileSync(file, buffer);
		return { file, temp: true };
	}
	if (fs.existsSync(src)) return { file: src, temp: false };
	throw new Error(`media not found: ${src.slice(0, 80)}`);
}

/** Split (src, threadID, ...rest) into caption / callback / reply target. */
function parseArgs(args) {
	const [src, threadID, ...rest] = args;
	const cbIndex = rest.findIndex(v => typeof v === "function");
	const cb = cbIndex >= 0 ? rest[cbIndex] : null;
	const caption = cbIndex > 0 && typeof rest[0] === "string" ? rest[0] : (cbIndex < 0 && typeof rest[0] === "string" ? rest[0] : "");
	const reply = cbIndex >= 0 ? rest[cbIndex + 1] : rest[1];
	return { src, threadID, caption, cb, reply: typeof reply === "string" && reply ? reply : undefined };
}

function install(api) {
	if (!api || typeof api.sendMessage !== "function") return api;

	const sendRaw = (form, threadID, reply) => new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("Instagram send timed out")); } }, 120000);
		const cb = (error, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			error ? reject(error) : resolve(result);
		};
		try {
			const ret = api.sendMessage(form, threadID, cb, reply);
			if (ret && typeof ret.then === "function") ret.then(r => cb(null, r), cb);
		}
		catch (error) { cb(error); }
	});

	function make(kind) {
		return function (...args) {
			const { src, threadID, caption, cb, reply } = parseArgs(args);
			const job = (async () => {
				const { file, temp } = await toFile(src, kind);
				try {
					const size = fs.statSync(file).size;
					log.info("MEDIA", `send ${kind} (${Math.round(size / 1024)} KB) -> ${threadID}`);
					const result = await sendRaw({ body: "", attachment: fs.createReadStream(file) }, threadID, reply);
					if (caption) await sendRaw({ body: String(caption) }, threadID, undefined).catch(() => { });
					return result;
				}
				finally { if (temp) fs.unlink(file, () => { }); }
			})();
			if (cb) {
				// Callback style: never hand back a rejecting promise (it would be unhandled).
				job.then(r => cb(null, r), e => {
					log.error("MEDIA", `send ${kind} failed: ${e && e.message || e}`);
					cb(e);
				});
				return Promise.resolve();
			}
			return job;
		};
	}

	const added = [];
	for (const [name, kind] of [["sendImage", "image"], ["sendVideo", "video"], ["sendAudio", "audio"]]) {
		if (typeof api[name] !== "function") { api[name] = make(kind); api[name]._shim = true; added.push(name); }
	}

	// Safe fallbacks for server-only extras so commands degrade instead of throwing.
	const plain = (text, threadID, cb, reply) => {
		const p = sendRaw({ body: String(text) }, threadID, reply);
		if (typeof cb === "function") { p.then(r => cb(null, r), cb); return Promise.resolve(); }
		return p;
	};
	if (typeof api.sendTextEffect !== "function") {
		api.sendTextEffect = (text, threadID, effect, cb) => plain(text, threadID, cb); added.push("sendTextEffect");
	}
	if (typeof api.sendAvatarTextEffect !== "function") {
		api.sendAvatarTextEffect = (text, threadID, effect, cb) => plain(text, threadID, cb); added.push("sendAvatarTextEffect");
	}
	// Different ig-chat-api builds name these differently; alias whatever exists.
	const alias = (target, candidates) => {
		if (typeof api[target] === "function") return;
		const found = candidates.find(n => typeof api[n] === "function");
		if (found) { api[target] = (...a) => api[found](...a); added.push(`${target}<-${found}`); }
	};
	alias("unsendMessage", ["unsend", "deleteMessage", "removeMessage", "unsendMsg", "deleteMessageForEveryone"]);
	alias("sendTypingIndicator", ["sendTyping", "setTyping", "typing", "startTyping", "indicateTyping"]);
	alias("setMessageReaction", ["react", "reactToMessage", "sendReaction"]);
	// unsendMessage must work both as `await api.unsendMessage(id, threadID)` and with a
	// node-style callback, whichever way the underlying package implements it.
	if (typeof api.unsendMessage === "function" && !api.unsendMessage._wrapped) {
		const original = api.unsendMessage.bind(api);
		const wrapped = (messageID, threadID, cb) => {
			const p = new Promise((resolve, reject) => {
				let done = false;
				const timer = setTimeout(() => fin(new Error("unsend timed out")), 20000);
				const fin = (error, result) => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					error ? reject(error) : resolve(result);
				};
				try {
					const ret = original(messageID, threadID, fin);
					if (ret && typeof ret.then === "function") ret.then(r => fin(null, r), fin);
				}
				catch (error) { fin(error); }
			});
			if (typeof cb === "function") { p.then(r => cb(null, r), e => cb(e)); return Promise.resolve(); }
			return p;
		};
		wrapped._wrapped = true;
		api.unsendMessage = wrapped;
	}
	else if (typeof api.unsendMessage !== "function") {
		log.warn("MEDIA", "this ig-chat-api build has no unsend method; unsend commands cannot work");
	}
	if (typeof api.sendTypingIndicator !== "function") {
		api.sendTypingIndicator = (threadID, cb) => { if (typeof cb === "function") cb(null); return () => { }; };
		api.sendTypingIndicator._noop = true;
		added.push("sendTypingIndicator(noop)");
	}
	if (typeof api.musicSearch !== "function") {
		api.musicSearch = (query, cb) => {
			const error = new Error("Instagram music search is not available in direct mode. Set music.apiUrl in config.json to a song API.");
			if (typeof cb === "function") { cb(error); return Promise.resolve(); }
			return Promise.reject(error);
		};
		added.push("musicSearch");
	}

	if (added.length) log.info("MEDIA", `Direct-mode shim added: ${added.join(", ")}`);
	try {
		const names = new Set();
		for (let o = api; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
			for (const k of Object.getOwnPropertyNames(o)) if (typeof api[k] === "function") names.add(k);
		log.info("MEDIA", `api methods: ${[...names].sort().join(", ")}`);
	}
	catch (_) { /* diagnostics only */ }
	return api;
}

module.exports = { install };
