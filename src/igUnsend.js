"use strict";
/**
 * Working api.unsendMessage for Instagram (ported from Insta-Bot3's func/igcompat/apiCompat.js).
 *
 * Why the old unsend "did nothing":
 *  - it only tried ONE call shape, and
 *  - Instagram often answers a failed unsend as a NORMAL result ({action:"item_ack",
 *    message:"Sorry, something went wrong"}), which the old code counted as success.
 *
 * This version:
 *  - remembers which thread every bot message went to,
 *  - accepts (id) (id, cb) (id, threadID) (id, threadID, cb),
 *  - tries every call shape the Instagram client understands,
 *  - treats an "item_ack ... went wrong" reply as a failure,
 *  - retries once after 2.5s (Instagram needs a moment before a fresh message can be removed),
 *  - logs "[unsend-fail] ..." with the real reason in the Render log.
 */
const THREADS = new Map(); // messageID -> threadID
const MAX = 5000;

function remember(messageID, threadID) {
	if (messageID == null || threadID == null) return;
	THREADS.set(String(messageID), String(threadID));
	if (THREADS.size > MAX) THREADS.delete(THREADS.keys().next().value);
}

function ackFailure(result) {
	if (!result || typeof result !== "object") return null;
	const msg = typeof result.message === "string" ? result.message : "";
	const status = typeof result.status === "string" ? result.status : "";
	if (/sorry|went wrong|try again|error|fail/i.test(msg)) return msg;
	if (status && !/^(ok|success)$/i.test(status)) return `status ${status}${msg ? ": " + msg : ""}`;
	return null;
}

function attempt(fn, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (error, result) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (!error) { const bad = ackFailure(result); if (bad) error = new Error(bad); }
			error ? reject(error) : resolve(result === undefined ? true : result);
		};
		const timer = setTimeout(() => finish(new Error("unsend timed out")), timeoutMs || 8000);
		try {
			const ret = fn(...args, finish);
			if (ret && typeof ret.then === "function") ret.then(r => finish(null, r), e => finish(e));
		}
		catch (error) { finish(error); }
	});
}

function unsendLikeMethods(api) {
	const names = new Set();
	for (let o = api; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
		for (const n of Object.getOwnPropertyNames(o)) names.add(n);
	return [...names].filter(n => { try { return typeof api[n] === "function" && /^(unsend|retract|removeMessage|deleteMessage|removeItem|deleteItem)/i.test(n); } catch (_) { return false; } });
}

function install(api) {
	if (!api || api.__igUnsendInstalled) return api;
	api.__igUnsendInstalled = true;

	// remember message -> thread for everything the bot sends
	for (const name of ["sendMessage", "sendImage", "sendVideo", "sendAudio"]) {
		if (typeof api[name] !== "function") continue;
		const original = api[name].bind(api);
		api[name] = function (...args) {
			const threadID = args[1];
			const track = res => { if (res && typeof res === "object" && res.messageID) remember(res.messageID, res.threadID != null ? res.threadID : threadID); };
			// callback style: wrap the callback so we see the result
			const cbIndex = args.findIndex((a, i) => i >= 2 && typeof a === "function");
			if (cbIndex >= 0) {
				const cb = args[cbIndex];
				args[cbIndex] = (e, r) => { if (!e) track(r); return cb(e, r); };
			}
			const ret = original(...args);
			if (ret && typeof ret.then === "function") ret.then(track, () => { });
			return ret;
		};
	}

	const rawUnsend = typeof api.unsendMessage === "function" ? api.unsendMessage.bind(api) : null;
	api.__rawUnsend = rawUnsend;

	api.unsendMessage = async function unsendMessage(messageID, ...rest) {
		if (!rawUnsend) throw new Error("unsendMessage is not available");
		const callback = [...rest].reverse().find(a => typeof a === "function");
		const given = rest.find(a => typeof a === "string" || typeof a === "number");
		const threadID = given != null ? String(given) : THREADS.get(String(messageID));
		const idStr = String(messageID);

		const forms = [[idStr]];
		if (threadID != null && !idStr.includes(":")) {
			forms.push([`${threadID}:${idStr}`]);
			forms.push([idStr, threadID]);
			forms.push([threadID, idStr]);
		}

		const errors = [];
		const sleep = ms => new Promise(r => setTimeout(r, ms));
		const runOnce = async () => {
			for (const args of forms) {
				try { return await attempt(rawUnsend, args); }
				catch (error) {
					const text = error && (error.message || error.error || (typeof error === "string" ? error : JSON.stringify(error)));
					errors.push(`(${args.length} args) ${String(text).slice(0, 160)}`);
				}
			}
			for (const name of unsendLikeMethods(api)) {
				if (name === "unsendMessage") continue;
				const fn = api[name].bind(api);
				const combos = [[idStr], [[idStr]]];
				if (threadID != null && !idStr.includes(":")) combos.push([`${threadID}:${idStr}`], [idStr, threadID]);
				for (const args of combos) {
					try { return await attempt(fn, args); }
					catch (error) { errors.push(`${name}: ${String((error && error.message) || error).slice(0, 120)}`); }
				}
			}
			return undefined;
		};

		let result = await runOnce();
		if (result === undefined && errors.some(e => /try again|went wrong|timed out/i.test(e))) {
			await sleep(2500);
			result = await runOnce();
		}
		if (result !== undefined) {
			if (typeof callback === "function") callback(null, result);
			return result;
		}
		console.log(`[unsend-fail] message=${messageID} thread=${threadID} :: ${errors.join(" | ") || "no error text"}`);
		const lastError = new Error(errors.join(" | ") || "unsend failed");
		lastError.attempts = errors;
		if (typeof callback === "function") { callback(lastError); return; }
		throw lastError;
	};
	return api;
}

module.exports = { install, remember };
