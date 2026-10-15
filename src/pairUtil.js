"use strict";

/** Helpers that keep the pair commands from dying on a flaky lookup or download. */

function placeholderAvatar(Canvas) {
	const c = Canvas.createCanvas(256, 256);
	const x = c.getContext("2d");
	const g = x.createLinearGradient(0, 0, 256, 256);
	g.addColorStop(0, "#ff9ecb");
	g.addColorStop(1, "#b983ff");
	x.fillStyle = g;
	x.fillRect(0, 0, 256, 256);
	x.fillStyle = "rgba(255,255,255,0.85)";
	x.beginPath(); x.arc(128, 100, 48, 0, Math.PI * 2); x.fill();
	x.beginPath(); x.arc(128, 250, 86, Math.PI, 0); x.fill();
	return c;
}

function placeholderBackground(Canvas) {
	const c = Canvas.createCanvas(1200, 700);
	const x = c.getContext("2d");
	const g = x.createLinearGradient(0, 0, 1200, 700);
	g.addColorStop(0, "#3a1c71");
	g.addColorStop(0.5, "#d76d77");
	g.addColorStop(1, "#ffaf7b");
	x.fillStyle = g;
	x.fillRect(0, 0, 1200, 700);
	return c;
}

async function download(axios, url) {
	const response = await axios.get(url, {
		responseType: "arraybuffer",
		timeout: 20000,
		headers: { "User-Agent": "Mozilla/5.0" }
	});
	return Buffer.from(response.data);
}

async function safeLoadImage(Canvas, axios, url) {
	try {
		if (!url) throw new Error("no image url");
		return await Canvas.loadImage(await download(axios, url));
	}
	catch (error) {
		console.error("[pair] image load failed, using placeholder:", String(url || "").slice(0, 80), error && error.message);
		return placeholderAvatar(Canvas);
	}
}

async function safeLoadBackground(Canvas, axios, url) {
	try {
		return await Canvas.loadImage(await download(axios, url));
	}
	catch (error) {
		console.error("[pair] background load failed, using gradient:", error && error.message);
		return placeholderBackground(Canvas);
	}
}

/** getThreadInfo that never throws and always returns a usable participantIDs list. */
async function safeThreadInfo(api, threadID, event) {
	let info = null;
	try { info = await api.getThreadInfo(threadID); }
	catch (error) { console.error("[pair] getThreadInfo failed:", error && error.message || error); }
	let ids = (info && Array.isArray(info.participantIDs) ? info.participantIDs : []).map(String);
	if (!ids.length) ids = ((event && event.participantIDs) || []).map(String);
	if (!ids.length && event && event.senderID) ids = [String(event.senderID)];
	return Object.assign({}, info || {}, { participantIDs: ids });
}

module.exports = { safeLoadImage, safeLoadBackground, safeThreadInfo };
