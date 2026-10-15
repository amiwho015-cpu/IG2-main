"use strict";

/**
 * GoatBot (Facebook Messenger) -> Instagram compatibility layer.
 *
 * Lets commands written for GoatBot run on InstaBOT unchanged:
 *   - config.countDown / guide / langs / getLang
 *   - onStart / onReply / onReaction / onChat / onLoad
 *   - global.GoatBot, global.utils, global.client, global.db
 *   - promise-style api.* helpers, usersData / threadsData adapters
 * Messenger-only calls (theme, cover, nickname, friend requests …) reject with
 * a clear "not supported on Instagram" error instead of crashing the bot.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const log = require("./logger");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(os.tmpdir(), "instabot-goat");
try { fs.mkdirSync(TMP, { recursive: true }); } catch (_) { /* ignore */ }

const state = { api: null, dispatcher: null, registry: null, config: null, database: null };

const UNSUPPORTED = new Set([
	"changeThreadColor", "changeThreadEmoji", "changeNickname", "changeGroupImage", "changeAvatar",
	"changeCover", "createThemeAI", "metaTheme", "getFriendsList", "handleMessageRequest", "handleFriendRequest",
	"setPostReaction", "searchUsers", "httpPost", "httpGet", "markAsRead", "changeAdminStatus",
	"createPoll", "shareContact", "forwardAttachment", "resolvePhotoUrl", "changeBio"
]);

function unsupported(name) {
	return function () {
		const error = new Error(`"${name}" is a Messenger-only feature and is not available on Instagram.`);
		const cb = [...arguments].reverse().find(a => typeof a === "function");
		if (cb) return cb(error);
		return Promise.reject(error);
	};
}

/* ------------------------------------------------------------------ utils */

function extFromUrl(url, contentType) {
	try {
		const clean = new URL(url).pathname;
		const ext = path.extname(clean).replace(".", "").toLowerCase();
		if (ext && ext.length <= 5) return ext;
	}
	catch (_) { /* fall through */ }
	const type = String(contentType || "").toLowerCase();
	if (type.includes("mp4")) return "mp4";
	if (type.includes("video")) return "mp4";
	if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
	if (type.includes("audio")) return "m4a";
	if (type.includes("png")) return "png";
	if (type.includes("gif")) return "gif";
	if (type.includes("webp")) return "webp";
	return "jpg";
}

/**
 * GoatBot signature: randomString(length, onlyOnce, possible).
 *   possible  characters to draw from (default: letters + digits)
 *   onlyOnce  true => every character appears at most once (needed by games
 *             such as guessnumber, which wants 4 DIFFERENT digits)
 * The old compat version took (length, onlyLower) and ignored the 3rd argument,
 * so guessnumber's answer was random letters+digits and could never be guessed.
 */
function randomString(length = 10, onlyOnce = false, possible) {
	let chars = typeof possible === "string" && possible.length ? possible : "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	if (onlyOnce === true) chars = Array.from(new Set(chars.split(""))).join("");
	let pool = chars.split("");
	let out = "";
	for (let i = 0; i < length; i++) {
		if (!pool.length) pool = chars.split(""); // asked for more than there are unique characters
		const at = Math.floor(Math.random() * pool.length);
		out += pool[at];
		if (onlyOnce === true) pool.splice(at, 1);
	}
	return out;
}

/** GoatBot convertTime: 3725000 -> "1h 2m 5s". */
function convertTime(ms, hours = "h", minutes = "m", seconds = "s", millis = "ms") {
	ms = Math.max(0, Number(ms) || 0);
	const h = Math.floor(ms / 3600000);
	const m = Math.floor((ms % 3600000) / 60000);
	const sec = Math.floor((ms % 60000) / 1000);
	const milli = Math.floor(ms % 1000);
	const parts = [];
	if (h) parts.push(h + hours);
	if (m) parts.push(m + minutes);
	if (sec) parts.push(sec + seconds);
	if (!parts.length) parts.push(milli + millis);
	return parts.join(" ");
}

async function downloadToTmp(url, hintExt) {
	const axios = require("axios");
	const response = await axios.get(url, {
		responseType: "arraybuffer",
		timeout: 60000,
		maxRedirects: 5,
		headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" }
	});
	const ext = hintExt || extFromUrl(url, response.headers && response.headers["content-type"]);
	const file = path.join(TMP, `${randomString(12)}.${ext}`);
	fs.writeFileSync(file, Buffer.from(response.data));
	const cleanup = setTimeout(() => fs.unlink(file, () => { }), 5 * 60 * 1000);
	if (cleanup.unref) cleanup.unref();
	return file;
}

async function getStreamFromURL(url, pathName) {
	const ext = pathName ? path.extname(String(pathName)).replace(".", "") : "";
	const file = await downloadToTmp(url, ext || undefined);
	return fs.createReadStream(file);
}

async function getStreamsFromAttachment(attachments) {
	const out = [];
	for (const att of attachments || []) {
		const url = att && (att.url || att.previewUrl || att.largePreviewUrl);
		if (!url) continue;
		try { out.push(await getStreamFromURL(url)); }
		catch (_) { /* skip a failed attachment */ }
	}
	return out;
}

function splitPage(arr, limit) {
	const allPage = [];
	for (let i = 0; i < arr.length; i += limit) allPage.push(arr.slice(i, i + limit));
	return { totalPage: allPage.length || 1, allPage: allPage.length ? allPage : [[]] };
}

const MONO = {};
"abcdefghijklmnopqrstuvwxyz".split("").forEach((c, i) => { MONO[c] = String.fromCodePoint(0x1D68A + i); MONO[c.toUpperCase()] = String.fromCodePoint(0x1D670 + i); });
"0123456789".split("").forEach((c, i) => { MONO[c] = String.fromCodePoint(0x1D7F6 + i); });
function monospace(text) { return String(text).split("").map(c => MONO[c] || c).join(""); }

function getTime(format) {
	try { return require("moment-timezone")().tz("Asia/Dhaka").format(format || "DD/MM/YYYY HH:mm:ss"); }
	catch (_) { return new Date().toISOString(); }
}

async function downloadFile(filePath, url) {
	const axios = require("axios");
	const response = await axios.get(url, { responseType: "arraybuffer", timeout: 60000 });
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, Buffer.from(response.data));
	return filePath;
}

/** Node-style callback adapter that can never crash the process: a callback that throws is logged, not rethrown. */
function cbify(run, cb) {
	const safe = fn => { try { return fn(); } catch (error) { log.warn("GOAT", `callback threw: ${error && error.message}`); } };
	return run.then(r => safe(() => cb(null, r)), e => safe(() => cb(e)));
}

const goatUtils = {
	getStreamFromURL, getStreamsFromAttachment, randomString, convertTime, splitPage, monospace, getTime, downloadFile,
	getPrefix: () => state.config && state.config.prefix || "/",
	realMention: (text) => String(text || ""),
	findUid: async (link) => { const m = String(link).match(/instagram\.com\/([A-Za-z0-9._]+)/); return m ? m[1] : null; },
	getText: (...a) => a.join(" "),
	log: { info: (...a) => log.info("GOAT", a.join(" ")), warn: (...a) => log.warn("GOAT", a.join(" ")), err: (...a) => log.error("GOAT", a.join(" ")), error: (...a) => log.error("GOAT", a.join(" ")) },
	sleep: ms => new Promise(r => setTimeout(r, ms))
};

/* ------------------------------------------------------- reply / reaction */

// A message that carries text AND an image is two Instagram messages; players
// reply to either. send results expose `messageIDs` (see message.js); remember
// which ids belong together and which thread they were sent to, so a handler
// armed on one id also answers replies to its siblings.
const siblings = new Map(); // messageID -> [other ids sent together with it]
const messageThread = new Map(); // messageID -> threadID
const mediaMessages = new Set(); // ids of messages that are / belong to an image post (see dispatcher fallback)
const REMEMBER_MAX = 4000;

function remember(map, key, value) {
	map.set(key, value);
	if (map.size > REMEMBER_MAX) map.delete(map.keys().next().value);
}

class BridgeMap extends Map {
	constructor(kind) { super(); this.kind = kind; }

	set(messageID, data) {
		const id = String(messageID);
		super.set(id, data);
		const registry = state.registry;
		const dispatcher = state.dispatcher;
		if (!registry || !dispatcher || !data) return this;
		const name = String(data.commandName || "").toLowerCase();
		const script = registry.resolve(name);
		if (!script || !script.__goat) return this;
		const goat = script.__goat;
		const method = this.kind === "reply" ? goat.onReply : goat.onReaction;
		if (typeof method !== "function") return this;

		const handler = async (ctx) => {
			const built = buildContext(script, ctx);
			if (this.kind === "reply") built.Reply = data;
			else built.Reaction = data;
			await method.call(script, built);
		};
		const ids = [id, ...(siblings.get(id) || [])];
		const threadID = messageThread.get(id) || data.threadID || null;
		for (const key of ids) {
			if (this.kind === "reply") {
				// GoatBot semantics: a reply handler stays armed until the command
				// calls global.GoatBot.onReply.delete(messageID). Consuming it on the
				// first reply meant one invalid answer ended the whole game.
				dispatcher.registerOnReply(key, name, handler, {
					persistent: true,
					threadID,
					fallback: mediaMessages.has(id),
					author: data.author != null ? data.author : (data.au != null ? data.au : null)
				});
			}
			else dispatcher.registerOnReaction(key, name, handler);
		}
		return this;
	}

	delete(messageID) {
		const id = String(messageID);
		const keys = [id, ...(siblings.get(id) || [])];
		let had = false;
		for (const key of keys) had = super.delete(key) || had;
		const dispatcher = state.dispatcher;
		if (dispatcher && this.kind === "reply" && typeof dispatcher.unregisterOnReply === "function") {
			for (const key of keys) dispatcher.unregisterOnReply(key);
		}
		return had;
	}
}

/* ------------------------------------------------------------ data adapters */

function usersAdapter() {
	const store = () => state.database.users;
	const api = () => state.api;

	function record(uid) {
		uid = String(uid);
		const rec = store().ensure(uid, { userID: uid });
		if (rec.money == null) rec.money = 0;
		if (rec.exp == null) rec.exp = 0;
		if (rec.gender == null) rec.gender = 0;
		if (!rec.data) rec.data = {};
		if (!rec.settings) rec.settings = {};
		return rec;
	}
	function save(uid) { const r = record(uid); store().update(String(uid), {}); return r; }
	function pick(obj, key, def) {
		if (!key) return obj;
		const val = String(key).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
		return val === undefined ? def : val;
	}

	const nameMiss = new Map();
	async function ensureName(uid) {
		const rec = record(uid);
		if (rec.name) return rec;
		const missAt = nameMiss.get(String(uid));
		if (missAt && Date.now() - missAt < 10 * 60 * 1000) return rec;
		try {
			const info = await api().getUserInfo(String(uid));
			const p = info && (info[String(uid)] || Object.values(info)[0]);
			const name = p && (p.name || p.firstName || p.vanity);
			if (name) { store().update(String(uid), { name, username: p.vanity || null }); return record(uid); }
		}
		catch (_) { /* remember the miss */ }
		nameMiss.set(String(uid), Date.now());
		return rec;
	}

	const adapter = {
		async get(uid, key, def) {
			const rec = (!key || key === "name") ? await ensureName(uid) : record(uid);
			return pick(rec, key, def);
		},
		async getName(uid) {
			const rec = record(uid);
			if (rec.name) return rec.name;
			try {
				const info = await api().getUserInfo(String(uid));
				const p = info && info[String(uid)];
				const name = p && (p.name || p.firstName || p.vanity);
				if (name) { store().update(String(uid), { name, username: p.vanity || null }); return name; }
			}
			catch (_) { /* fall back */ }
			return `User ${uid}`;
		},
		async set(uid, value, key) {
			const rec = record(uid);
			if (key) {
				const parts = String(key).split(".");
				let cur = rec;
				while (parts.length > 1) { const k = parts.shift(); if (typeof cur[k] !== "object" || cur[k] == null) cur[k] = {}; cur = cur[k]; }
				cur[parts[0]] = value;
			}
			else if (value && typeof value === "object") Object.assign(rec, value);
			save(uid);
			return rec;
		},
		async getAll() { return store().all().map(r => { r.money = r.money || 0; r.exp = r.exp || 0; r.data = r.data || {}; return r; }); },
		async getAvatarUrl(uid) {
			return (await resolveAvatarUrl(String(uid))) || `http://127.0.0.1:${avatarPort}/avatar/${encodeURIComponent(uid)}`;
		},
		async addMoney(uid, amount) { const r = record(uid); r.money = (Number(r.money) || 0) + Number(amount); save(uid); return r.money; },
		async subtractMoney(uid, amount) { const r = record(uid); r.money = (Number(r.money) || 0) - Number(amount); save(uid); return r.money; },
		async refreshInfo(uid) { return record(uid); },
		async json() { return JSON.stringify(store().data); },
		async remove(uid) { delete store().data[String(uid)]; store().flush(); }
	};
	return adapter;
}

function threadsAdapter() {
	const store = () => state.database.threads;

	function record(tid) {
		tid = String(tid);
		const rec = store().ensure(tid, { threadID: tid });
		if (!rec.data) rec.data = {};
		if (!rec.settings) rec.settings = {};
		rec.threadName = rec.name || rec.threadName || "";
		rec.threadID = tid;
		if (!Array.isArray(rec.members)) rec.members = [];
		return rec;
	}
	function view(rec) {
		const out = Object.assign({}, rec);
		out.adminIDs = (rec.adminIDs || []).map(a => (typeof a === "object" ? a : { id: String(a) }));
		out.members = (rec.members || []).map(m => (typeof m === "object" ? m : { userID: String(m), inGroup: true }));
		return out;
	}
	function pick(obj, key, def) {
		if (!key) return obj;
		const val = String(key).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
		return val === undefined ? def : val;
	}

	return {
		async get(tid, key, def) { return pick(view(record(tid)), key, def); },
		async set(tid, value, key) {
			const rec = record(tid);
			if (key) {
				const parts = String(key).split(".");
				let cur = rec;
				while (parts.length > 1) { const k = parts.shift(); if (typeof cur[k] !== "object" || cur[k] == null) cur[k] = {}; cur = cur[k]; }
				cur[parts[0]] = value;
			}
			else if (value && typeof value === "object") Object.assign(rec, value);
			store().update(String(tid), {});
			return rec;
		},
		async getAll() { return store().all().map(r => view(r)); },
		async refreshInfo(tid) { return view(record(tid)); },
		async json() { return JSON.stringify(store().data); }
	};
}

/**
 * GoatBot globalData: named records {key, data} shared by all threads (rankings,
 * aliases ...). It used to be a stub returning {} - so guessnumber's ranking
 * threw "findIndex is not a function" when a game ended. Persisted to
 * <database dir>/globalData.json.
 */
function globalDataAdapter(database) {
	const file = path.join((database && database.dir) || path.join(ROOT, "data"), "globalData.json");
	let data = {};
	try { data = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (_) { data = {}; }
	let timer = null;
	function save() {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			try {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2));
				fs.renameSync(file + ".tmp", file);
			}
			catch (error) { log.warn("GOAT", `could not save globalData: ${error.message}`); }
		}, 250);
		if (timer.unref) timer.unref();
	}
	function pick(obj, key, def) {
		if (!key) return obj;
		const val = String(key).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
		return val === undefined ? def : val;
	}
	function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
	return {
		async get(name, key, def) {
			const rec = data[String(name)];
			if (!rec) return def === undefined ? (key ? undefined : {}) : clone(def);
			const val = pick(rec, key, def);
			return clone(val);
		},
		async set(name, value, key) {
			const id = String(name);
			const rec = data[id] || (data[id] = { key: id, data: {} });
			if (key) {
				const parts = String(key).split(".");
				let cur = rec;
				while (parts.length > 1) { const k = parts.shift(); if (typeof cur[k] !== "object" || cur[k] == null) cur[k] = {}; cur = cur[k]; }
				cur[parts[0]] = clone(value);
			}
			else if (value && typeof value === "object") Object.assign(rec, clone(value));
			save();
			return rec;
		},
		async create(name, value) { const id = String(name); if (!data[id]) data[id] = Object.assign({ key: id, data: {} }, clone(value || {})); save(); return data[id]; },
		async delete(name) { delete data[String(name)]; save(); },
		async getAll() { return Object.values(data); }
	};
}

/* ------------------------------------------------------------- api wrapper */

function normForm(form) {
	if (form == null) return form;
	if (typeof form === "string" || typeof form === "number") return String(form);
	if (Array.isArray(form) || typeof form !== "object") return form;
	const out = Object.assign({}, form);
	delete out.mentions;
	delete out.sticker;
	delete out.location;
	delete out.emoji;
	if (out.attachment == null) delete out.attachment;
	if (out.body == null) out.body = "";
	return out;
}

function idOf(result, threadID) {
	if (!result) return result;
	if (typeof result !== "object") result = { messageID: String(result) };
	if (result.messageID == null) result.messageID = result.id || result.message_id || result.messageId || null;
	if (result.messageID != null) {
		const tid = threadID != null ? threadID : result.threadID;
		if (tid != null) remember(messageThread, String(result.messageID), String(tid));
	}
	const all = Array.isArray(result.messageIDs) ? result.messageIDs.map(String) : [];
	if (all.length > 1) for (const one of all) remember(siblings, one, all.filter(other => other !== one));
	if ((all.length > 1 || result.mediaOnly === true) && result.messageID != null) {
		for (const one of all.length ? all : [String(result.messageID)]) mediaMessages.add(one);
		if (mediaMessages.size > REMEMBER_MAX) mediaMessages.delete(mediaMessages.values().next().value);
	}
	return result;
}

/** Fire-and-forget safe: a failed unsend (e.g. someone else's message) must not become an unhandled rejection. */
function quiet(promise) {
	if (promise && typeof promise.catch === "function") promise.catch(() => { });
	return promise;
}

function createGoatApi(api, event) {
	const threadID = event && event.threadID;

	function send(form, tid, cb, replyID) {
		if (typeof tid === "function") { replyID = cb; cb = tid; tid = threadID; }
		// FCA style: sendMessage(form, threadID, messageID) - the 3rd argument is the message to reply to.
		if (cb != null && typeof cb !== "function") { replyID = cb; cb = undefined; }
		if (tid == null) tid = threadID;
		const message = createLiveMessage(api, event, tid);
		const run = replyID ? message.replyTo(form, replyID) : message.sendTo(form);
		const tagged = run.then(result => idOf(result, tid));
		if (typeof cb === "function") return cbify(tagged, cb);
		return tagged;
	}

	const overrides = {
		sendMessage: send,
		unsendMessage(messageID, cb) {
			const run = new Promise((resolve, reject) => api.unsendMessage(messageID, threadID, (e, r) => e ? reject(e) : resolve(r)));
			if (typeof cb === "function") return cbify(run, cb);
			return quiet(run);
		},
		setMessageReaction(emoji, messageID, cb) {
			const run = new Promise((resolve, reject) => api.setMessageReaction(emoji == null ? "" : emoji, messageID, threadID, (e, r) => e ? reject(e) : resolve(r)));
			if (typeof cb === "function") return cbify(run, cb);
			return run;
		},
		async editMessage(text, messageID, cb) {
			try {
				try { await overrides.unsendMessage(messageID); } catch (_) { /* old message may already be gone */ }
				const result = await send(text, threadID);
				if (typeof cb === "function") cb(null, result);
				return result;
			}
			catch (error) { if (typeof cb === "function") return cb(error); throw error; }
		},
		getThreadInfo(tid, cb) {
			if (typeof tid === "function") { cb = tid; tid = threadID; }
			const run = new Promise((resolve, reject) => api.getThreadInfo(tid || threadID, (e, r) => e ? reject(e) : resolve(r)))
				.then(info => {
					info = info || {};
					const ids = (info.participantIDs || info.userIDs || []).map(String);
					const admins = (info.adminIDs || []).map(a => (typeof a === "object" ? a : { id: String(a) }));
					return Object.assign({}, info, {
						threadID: String(tid || threadID),
						threadName: info.threadName || info.name || "",
						name: info.name || info.threadName || "",
						participantIDs: ids,
						adminIDs: admins,
						isGroup: info.isGroup === true || ids.length > 2,
						emoji: info.emoji || "👍",
						approvalMode: false
					});
				});
			if (typeof cb === "function") return cbify(run, cb);
			return run;
		},
		getUserInfo(ids, cb) {
			const list = Array.isArray(ids) ? ids : [ids];
			const run = new Promise((resolve, reject) => api.getUserInfo(list.length === 1 ? String(list[0]) : list.map(String), (e, r) => e ? reject(e) : resolve(r)))
				.then(result => {
					const out = {};
					for (const id of list) {
						const p = (result && result[String(id)]) || {};
						out[id] = Object.assign({ gender: 0, type: "user", isFriend: false }, p, {
							name: p.name || p.firstName || p.vanity || `User ${id}`,
							firstName: p.firstName || p.name || p.vanity || `User ${id}`,
							vanity: p.vanity || String(id),
							profileUrl: p.profileUrl || (p.vanity ? `https://instagram.com/${p.vanity}` : ""),
							thumbSrc: p.profilePicture || p.thumbSrc || p.profilePicUrl || ""
						});
					}
					return out;
				});
			if (typeof cb === "function") return cbify(run, cb);
			return run;
		},
		addUserToGroup(uid, tid, cb) {
			if (typeof tid === "function") { cb = tid; tid = threadID; }
			const run = new Promise((resolve, reject) => api.addUserToThread(String(uid), tid || threadID, (e, r) => e ? reject(e) : resolve(r)));
			if (typeof cb === "function") return cbify(run, cb);
			return run;
		},
		removeUserFromGroup(uid, tid, cb) {
			if (typeof tid === "function") { cb = tid; tid = threadID; }
			const run = new Promise((resolve, reject) => api.removeUserFromThread(String(uid), tid || threadID, (e, r) => e ? reject(e) : resolve(r)));
			if (typeof cb === "function") return cbify(run, cb);
			return run;
		},
		getCurrentUserID: () => api.getCurrentUserID(),
		getAppState: () => [],
		setOptions: () => { }
	};

	return new Proxy(api, {
		get(target, prop) {
			if (prop in overrides) return overrides[prop];
			if (UNSUPPORTED.has(prop)) return unsupported(prop);
			const value = target[prop];
			if (value !== undefined) return typeof value === "function" ? value.bind(target) : value;
			if (typeof prop === "string" && !prop.startsWith("_") && prop !== "then") return unsupported(prop);
			return undefined;
		}
	});
}

/* ---------------------------------------------------------- message helper */

/**
 * A message helper bound to one thread (used by both the GoatBot `message`
 * object and `api.sendMessage`). `sendTo` posts to the thread, `replyTo`
 * threads the post under a given message id.
 */
function createLiveMessage(api, event, threadID) {
	const { createMessageContext } = require("./message");
	const base = createMessageContext({ api, event: Object.assign({}, event, { threadID }), log });
	return {
		base,
		sendTo: form => base.send(normForm(form)),
		replyTo: (form, replyID) => {
			const ctx = createMessageContext({ api, event: Object.assign({}, event, { threadID, messageID: replyID }), log });
			return ctx.reply(normForm(form));
		}
	};
}

function createGoatMessage(base, event) {
	const wrap = (fn) => function (form, cb) {
		const run = fn(normForm(form)).then(result => idOf(result, base.threadID));
		if (typeof cb === "function") return cbify(run, cb);
		return run;
	};
	return {
		threadID: base.threadID,
		event,
		reply: wrap(f => base.reply(f)),
		send: wrap(f => base.send(f)),
		unsend: (id, cb) => quiet(base.unsend(id || event.messageID, cb)),
		reaction: (emoji, id, cb) => base.react(emoji, id || event.messageID, cb),
		react: (emoji, id, cb) => base.react(emoji, id || event.messageID, cb),
		err: (error) => base.reply(`❌ ${error && error.message ? error.message : String(error)}`),
		SyntaxError: () => base.reply("❌ Wrong syntax. Type the command name followed by `guide` to see how it is used."),
		txt: (text) => base.reply(String(text)),
		edit: async (text, id) => { try { await base.unsend(id); } catch (_) { /* ignore */ } return base.send(String(text)); },
		effect: base.effect,
		typing: base.typing
	};
}

/* ------------------------------------------------------- command adaptation */

function makeGetLang(goat, config) {
	const lang = (config && config.language) || "en";
	return function getLang(key, ...args) {
		const langs = goat.langs || {};
		const table = langs[lang] || langs.en || Object.values(langs)[0] || {};
		let text = table[key];
		if (text == null) {
			for (const t of Object.values(langs)) if (t && t[key] != null) { text = t[key]; break; }
		}
		if (text == null) return key;
		args.forEach((value, i) => { text = String(text).replace(new RegExp(`%${i + 1}`, "g"), String(value)); });
		return String(text).replace(/\{pn\}/g, config.prefix || "/").replace(/\{p\}/g, config.prefix || "/");
	};
}

/**
 * Instagram never delivers a mentions map: a tag arrives as literal "@handle"
 * text. GoatBot commands read event.mentions ({ id: name }), so resolve each
 * "@handle" in the message into one (max 3 lookups).
 */
async function enrichMentions(ctx) {
	const event = ctx.event;
	if (!event || (event.mentions && Object.keys(event.mentions).length)) return;
	const handles = (String(event.body || "").match(/@[A-Za-z0-9._]{2,30}/g) || []).slice(0, 3);
	if (!handles.length) return;
	const { resolveUserTarget } = require("./utils");
	const mentions = {};
	for (const handle of handles) {
		try {
			const target = await resolveUserTarget([handle], Object.assign({}, event, { messageReply: null }), ctx.api);
			if (target && target.id) mentions[String(target.id)] = handle;
		}
		catch (_) { /* skip unresolved handle */ }
	}
	if (Object.keys(mentions).length) event.mentions = mentions;
}

function buildContext(script, ctx) {
	const goat = script.__goat;
	const event = ctx.event;
	const api = createGoatApi(ctx.api, event);
	const message = createGoatMessage(ctx.message, event);

	const goatEvent = Object.assign({}, event);
	if (!goatEvent.mentions) goatEvent.mentions = {};
	if (!goatEvent.attachments) goatEvent.attachments = [];
	if (goatEvent.messageReply && !goatEvent.messageReply.attachments) goatEvent.messageReply.attachments = [];

	const role = ctx.role != null ? ctx.role : (state.dispatcher ? state.dispatcher.roleOf(event, ctx.threadData) : 0);
	return Object.assign({}, ctx, {
		api,
		message,
		event: goatEvent,
		usersData: goatBotData.users,
		threadsData: goatBotData.threads,
		role,
		prefix: state.config.prefix,
		commandName: script.config.name,
		getLang: makeGetLang(goat, state.config),
		envCommands: global.GoatBot.configCommands.envCommands || {},
		envGlobal: {},
		envConfig: {},
		globalData: goatBotData.globalData,
		dashBoardData: {},
		isUserCallCommand: true
	});
}

const goatBotData = { users: null, threads: null, globalData: null };

/**
 * Convert a GoatBot command into an InstaBOT command (mutates + returns it).
 * Native InstaBOT commands (they already define `usage` / `description.en`
 * with no GoatBot hooks) pass through untouched.
 */
function adapt(script, file) {
	if (!script || typeof script !== "object" || !script.config) return script;
	const c = script.config;
	const isGoat = c.countDown != null || script.langs || typeof script.onChat === "function" ||
		typeof script.onReply === "function" || typeof script.onReaction === "function" ||
		typeof script.onLoad === "function" || c.shortDescription != null || c.guide != null || c.version != null ||
		(typeof c.role === "undefined" && typeof c.author === "string" && !c.usage);
	if (!isGoat || script.__goat) return script;

	const goat = {
		onStart: script.onStart, onReply: script.onReply, onReaction: script.onReaction,
		onChat: script.onChat, onEvent: script.onEvent, onLoad: script.onLoad, langs: script.langs
	};
	script.__goat = goat;

	c.name = String(c.name || path.basename(file, ".js")).toLowerCase();
	c.category = String(c.category || "general").toLowerCase();
	if (c.cooldown == null) c.cooldown = Number(c.countDown) || 2;
	if (typeof c.role !== "number") c.role = typeof c.role === "object" && c.role && typeof c.role.onStart === "number" ? c.role.onStart : 0;
	if (c.role > 2) c.role = 2;
	const short = c.shortDescription || c.description || "";
	c.description = { en: typeof short === "object" ? (short.en || Object.values(short)[0] || "") : String(short) };
	const guide = c.guide;
	c.usage = { en: typeof guide === "object" && guide ? (guide.en || Object.values(guide)[0] || "{p}" + c.name) : String(guide || "{p}" + c.name) };
	c.usage.en = c.usage.en.replace(/\{pn\}/g, "{p}" + c.name).replace(/\{prefix\}/g, "{p}");
	c.aliases = Array.isArray(c.aliases) ? c.aliases : [];

	if (typeof goat.onStart === "function") {
		script.onStart = async function (ctx) {
			await enrichMentions(ctx);
			return goat.onStart.call(script, buildContext(script, ctx));
		};
	}
	else {
		// onChat-only / onLoad-only commands still need a callable onStart for validation.
		script.onStart = async function ({ message }) { return message.reply(`ℹ️ "${c.name}" works automatically in chat.`); };
	}
	return script;
}

/** Event-script wrappers for GoatBot onChat/onEvent hooks, plus onLoad. */
function companions(script) {
	const goat = script.__goat;
	if (!goat) return [];
	const out = [];
	const name = script.config.name;

	if (typeof goat.onChat === "function") {
		out.push({
			config: { name: `${name}__onChat`, category: "system", eventType: ["message", "message_reply"] },
			onEvent: async function (ctx) {
				const built = buildContext(script, ctx);
				const body = typeof ctx.event.body === "string" ? ctx.event.body : "";
				built.args = body.split(/\s+/).filter(Boolean);
				built.isUserCallCommand = false;
				await goat.onChat.call(script, built);
			}
		});
	}
	if (typeof goat.onEvent === "function") {
		out.push({
			config: { name: `${name}__onEvent`, category: "system" },
			onEvent: async function (ctx) { await goat.onEvent.call(script, buildContext(script, ctx)); }
		});
	}
	return out;
}

function runOnLoad(script) {
	const goat = script.__goat;
	if (!goat || typeof goat.onLoad !== "function" || !state.api) return;
	try {
		const ctx = { api: state.api, message: null, event: {}, config: state.config, threadData: {}, userData: {} };
		const built = Object.assign(buildContext(script, Object.assign(ctx, { message: createGoatMessage({ threadID: null, reply: async () => ({}), send: async () => ({}), unsend: async () => ({}), react: async () => ({}) }, {}) })));
		built.message = { reply: async () => ({}), send: async () => ({}) };
		Promise.resolve(goat.onLoad.call(script, built)).catch(error => log.warn("GOAT", `onLoad of ${script.config.name} failed: ${error.message}`));
	}
	catch (error) { log.warn("GOAT", `onLoad of ${script.config.name} failed: ${error.message}`); }
}


/* ------------------------------------------------ avatar proxy (FB -> IG) */

// GoatBot commands fetch avatars from graph.facebook.com/<uid>/picture, which
// only knows Facebook ids (Instagram ids come back as a "?" silhouette). We
// intercept those requests and serve the user's Instagram profile picture from
// a tiny loopback server instead, so every command that draws avatars works.

const avatarCache = new Map(); // uid -> { url, at }
const AVATAR_TTL = 30 * 60 * 1000;
let avatarPort = 0;

function placeholderPng() {
	const zlib = require("zlib");
	const size = 256, row = Buffer.alloc(1 + size * 3, 0x88); row[0] = 0;
	const raw = Buffer.concat(Array.from({ length: size }, () => row));
	const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
	const crc = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, c]);
	};
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
let PLACEHOLDER = null;

async function resolveAvatarUrl(uid) {
	const hit = avatarCache.get(uid);
	if (hit && Date.now() - hit.at < AVATAR_TTL) return hit.url;
	let url = null;
	for (let attempt = 0; attempt < 3 && !url; attempt++) {
		try {
			const info = await state.api.getUserInfo(String(uid));
			const p = info && (info[uid] || Object.values(info)[0]);
			url = p && (p.profilePicture || p.thumbSrc || p.profilePicUrl || p.profile_pic_url_hd || p.profile_pic_url) || null;
		}
		catch (_) { /* retry once or twice: lookups get throttled */ }
		if (!url && attempt < 2) await new Promise(r => setTimeout(r, 1500));
	}
	if (url) avatarCache.set(uid, { url, at: Date.now() });
	else if (hit) return hit.url;
	return url;
}

function startAvatarProxy() {
	const http = require("http");
	const server = http.createServer(async (req, res) => {
		const m = /^\/avatar\/([^/?]+)/.exec(req.url || "");
		const send = (buf, type) => { res.writeHead(200, { "Content-Type": type, "Content-Length": buf.length }); res.end(buf); };
		try {
			if (!m) { res.writeHead(404); return res.end(); }
			const url = await resolveAvatarUrl(decodeURIComponent(m[1]));
			if (url) {
				const upstream = await fetch(url, { signal: AbortSignal.timeout(20000) });
				if (upstream.ok) return send(Buffer.from(await upstream.arrayBuffer()), upstream.headers.get("content-type") || "image/jpeg");
			}
		}
		catch (_) { /* placeholder below */ }
		if (!PLACEHOLDER) PLACEHOLDER = placeholderPng();
		send(PLACEHOLDER, "image/png");
	});
	server.on("error", error => log.warn("GOAT", `avatar proxy error: ${error.message}`));
	server.listen(0, "127.0.0.1", () => { avatarPort = server.address().port; });
	if (server.unref) server.unref();
}

function patchFacebookAvatars() {
	if (global.__fbAvatarPatched) return;
	global.__fbAvatarPatched = true;
	const http = require("http");
	const https = require("https");

	function fbUid(args) {
		const first = args[0];
		let host = "", pathName = "";
		try {
			if (typeof first === "string") { const u = new URL(first); host = u.hostname; pathName = u.pathname; }
			else if (first instanceof URL) { host = first.hostname; pathName = first.pathname; }
			else if (first && typeof first === "object") { host = String(first.hostname || first.host || "").replace(/:\d+$/, ""); pathName = String(first.path || first.pathname || "").split("?")[0]; }
		}
		catch (_) { return null; }
		if (host !== "graph.facebook.com") return null;
		const m = /^\/([^/]+)\/picture\/?$/.exec(pathName);
		return m ? m[1] : null;
	}

	function rewrite(args, uid) {
		const rest = args.slice(1).filter(a => typeof a === "function" || (a && typeof a === "object" && !(a instanceof URL)));
		const cb = rest.find(a => typeof a === "function");
		const opts = rest.find(a => typeof a !== "function") || (typeof args[0] === "object" && !(args[0] instanceof URL) ? args[0] : {});
		const options = {
			host: "127.0.0.1", hostname: "127.0.0.1", port: avatarPort, path: `/avatar/${encodeURIComponent(uid)}`,
			method: opts.method || "GET", headers: {}, timeout: opts.timeout
		};
		return [options, cb];
	}

	for (const name of ["request", "get"]) {
		const original = https[name];
		https[name] = function (...args) {
			const uid = avatarPort ? fbUid(args) : null;
			if (!uid) return original.apply(this, args);
			const [options, cb] = rewrite(args, uid);
			const req = http.request(options, cb);
			if (name === "get") req.end();
			return req;
		};
	}
}

/* ------------------------------------------------------------ install/bind */

function install({ config, database, registry }) {
	state.config = config;
	state.database = database;
	state.registry = registry;

	startAvatarProxy();
	patchFacebookAvatars();
	goatBotData.users = usersAdapter();
	goatBotData.threads = threadsAdapter();
	goatBotData.globalData = globalDataAdapter(database);

	const configCommands = (() => {
		try { return JSON.parse(fs.readFileSync(path.join(ROOT, "configCommands.json"), "utf8")); }
		catch (_) { return { envCommands: {}, envEvents: {}, envGlobal: {} }; }
	})();

	global.utils = Object.assign(global.utils || {}, goatUtils);
	global.GoatBot = {
		config: Object.assign({}, config, { prefix: config.prefix, adminBot: config.adminBot, language: config.language }),
		configCommands,
		commands: registry.commands,
		aliases: registry.aliases,
		onReply: new BridgeMap("reply"),
		onReaction: new BridgeMap("reaction"),
		onEvent: new Map(),
		onFirstChat: [],
		fcaApi: null,
		botID: null,
		getCurrentAccount: () => ({ id: state.api ? state.api.getCurrentUserID() : null, name: config.botName }),
		startTime: Date.now()
	};
	global.client = Object.assign(global.client || {}, {
		dirConfig: path.join(ROOT, "config.json"),
		dirConfigCommands: path.join(ROOT, "configCommands.json"),
		dirAccount: path.join(ROOT, "account.txt"),
		cache: {}, database: {}, busyList: {},
		makeRankCard: async () => { throw new Error("Rank cards are not available on Instagram."); }
	});
	global.db = {
		get allUserData() { return database.users.all(); },
		get allThreadData() { return database.threads.all(); },
		allGlobalData: [], allDashBoardData: []
	};
	global.moduleData = global.moduleData || {};
	global.temp = global.temp || {};
	global.language = {};
}

function bind({ api, dispatcher }) {
	state.api = api;
	state.dispatcher = dispatcher;
	if (global.GoatBot) global.GoatBot.botID = api.getCurrentUserID();
}

module.exports = { install, bind, adapt, companions, runOnLoad, buildContext };
