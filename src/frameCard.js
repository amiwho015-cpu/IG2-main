"use strict";

/**
 * Instagram-native "frame card" commands (love, hug, kiss, married, rip, bow ...).
 *
 * The original Mirai versions asked a remote API (/api/frame?senderId=..&mentionId=..) to draw the
 * picture from FACEBOOK ids, which cannot work for Instagram ids. These versions do exactly what
 * the working `pair` command does: resolve the target on Instagram, load the Instagram avatars,
 * and draw the card locally with node-canvas.
 *
 * Nothing in the picture uses emoji or non-Latin text: the container only ships DejaVu, so those
 * would render as empty boxes. Shapes are drawn by hand, and the real names go in the caption.
 */

const Canvas = require("canvas");
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { safeLoadImage } = require("./pairUtil");

const PALETTES = [
	["#ff9a9e", "#fad0c4", "#ff3d71"],
	["#a18cd1", "#fbc2eb", "#8e44ad"],
	["#f6d365", "#fda085", "#e67e22"],
	["#84fab0", "#8fd3f4", "#16a085"],
	["#fa709a", "#fee140", "#e84393"],
	["#4facfe", "#00f2fe", "#0984e3"],
	["#c471f5", "#fa71cd", "#b33771"],
	["#ff758c", "#ff7eb3", "#d63031"],
	["#43e97b", "#38f9d7", "#00b894"],
	["#667eea", "#764ba2", "#6c5ce7"]
];

// shape: what is drawn between the two avatars. percent: show a match score.
const FAMILIES = {
	love:       { title: "LOVE",        shape: "heart", percent: true,  caption: (a, b, p) => `💖 ${a} ❤️ ${b}\n📊 ভালোবাসার মিল: ${p}%` },
	girlfriend: { title: "COUPLE",      shape: "heart", percent: false, caption: (a, b) => `💘 ${a} আর ${b} এখন কাপল! 🥰` },
	friend:     { title: "BEST FRIENDS", shape: "star", percent: false, caption: (a, b) => `🤝 ${a} আর ${b} — সেরা বন্ধু! 💛` },
	married:    { title: "MARRIED",     shape: "ring",  percent: false, caption: (a, b) => `💍 ${a} এর বিয়ে ${b} এর সাথে! 🥰❤️` },
	hug:        { title: "HUG",         shape: "heart", percent: false, caption: (a, b) => `🫂 ${a} জড়িয়ে ধরল ${b} কে 🤗` },
	kiss:       { title: "KISS",        shape: "heart", percent: false, caption: (a, b) => `😘 ${a} চুমু দিল ${b} কে 💋` },
	rip:        { title: "R.I.P",       shape: "cross", percent: false, gray: true, caption: (a, b) => `🪦 ${b} আর নেই... RIP 😂` },
	latti:      { title: "KICK",        shape: "bolt",  percent: false, caption: (a, b) => `🦶 ${a} লাথি মারল ${b} কে 😂` },
	juta:       { title: "SHOE",        shape: "bolt",  percent: false, caption: (a, b) => `👞 ${a} জুতা মারল ${b} কে 😂` },
	bow:        { title: "RESPECT",     shape: "star",  percent: false, caption: (a, b) => `🙇 ${a} মাথা নিচু করে ${b} কে সম্মান জানাল` },
	chor:       { title: "CAUGHT",      shape: "cross", percent: false, caption: (a, b) => `🕵️ ${b} ধরা পড়েছে! চোর চোর 😂` },
	ronaldo:    { title: "SIUUU",       shape: "star",  percent: false, caption: (a, b) => `⚽ ${a} আর ${b} — SIUUU! 🐐` },
	finger:     { title: "POINT",       shape: "bolt",  percent: false, caption: (a, b) => `👆 ${a} আঙুল তুলল ${b} এর দিকে 😜` },
	cdi:        { title: "FUN FRAME",   shape: "star",  percent: false, caption: (a, b) => `😜 ${a} আর ${b} — মজার ফ্রেম!` },
	gaa:        { title: "FUN FRAME",   shape: "bolt",  percent: false, caption: (a, b) => `😜 ${a} → ${b} 😂` },
	gu:         { title: "FUN FRAME",   shape: "cross", percent: false, caption: (a, b) => `😜 ${a} → ${b} 😂` }
};

/* ------------------------------------------------------------------ helpers */

function cleanName(name) {
	const n = String(name || "").split(" (")[0].split(" •")[0].replace(/\s+/g, " ").trim();
	return n || "User";
}

// Only names the bundled font can draw go on the picture; the caption always has the real name.
function drawableName(name) {
	const n = cleanName(name);
	return /^[\x20-\x7E\u00A0-\u024F]+$/.test(n) ? n : null;
}

function pairPercent(a, b) {
	const s = [String(a), String(b)].sort().join("|");
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
	return 60 + (h % 41); // 60..100, always the same for the same two people
}

function heartPath(ctx, cx, cy, size) {
	const s = size / 2;
	ctx.beginPath();
	ctx.moveTo(cx, cy + s * 0.9);
	ctx.bezierCurveTo(cx - s * 1.6, cy - s * 0.1, cx - s * 0.9, cy - s * 1.2, cx, cy - s * 0.4);
	ctx.bezierCurveTo(cx + s * 0.9, cy - s * 1.2, cx + s * 1.6, cy - s * 0.1, cx, cy + s * 0.9);
	ctx.closePath();
}

function starPath(ctx, cx, cy, outer, inner = outer * 0.45) {
	ctx.beginPath();
	for (let i = 0; i < 10; i++) {
		const r = i % 2 === 0 ? outer : inner;
		const ang = -Math.PI / 2 + (i * Math.PI) / 5;
		const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
		if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
	}
	ctx.closePath();
}

function boltPath(ctx, cx, cy, s) {
	ctx.beginPath();
	ctx.moveTo(cx + s * 0.15, cy - s);
	ctx.lineTo(cx - s * 0.55, cy + s * 0.1);
	ctx.lineTo(cx - s * 0.05, cy + s * 0.1);
	ctx.lineTo(cx - s * 0.2, cy + s);
	ctx.lineTo(cx + s * 0.55, cy - s * 0.2);
	ctx.lineTo(cx + s * 0.05, cy - s * 0.2);
	ctx.closePath();
}

function drawCenterShape(ctx, shape, cx, cy, accent) {
	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.35)";
	ctx.shadowBlur = 25;
	ctx.fillStyle = "#ffffff";
	if (shape === "heart") {
		heartPath(ctx, cx, cy, 170); ctx.fill();
		ctx.shadowBlur = 0; ctx.fillStyle = accent; heartPath(ctx, cx, cy, 135); ctx.fill();
	}
	else if (shape === "star") {
		starPath(ctx, cx, cy, 95); ctx.fill();
		ctx.shadowBlur = 0; ctx.fillStyle = accent; starPath(ctx, cx, cy, 76); ctx.fill();
	}
	else if (shape === "bolt") {
		boltPath(ctx, cx, cy, 100); ctx.fill();
		ctx.shadowBlur = 0; ctx.fillStyle = accent; boltPath(ctx, cx, cy, 82); ctx.fill();
	}
	else if (shape === "ring") {
		ctx.shadowBlur = 0;
		ctx.lineWidth = 16; ctx.strokeStyle = "#ffffff";
		ctx.beginPath(); ctx.arc(cx - 32, cy, 55, 0, Math.PI * 2); ctx.stroke();
		ctx.beginPath(); ctx.arc(cx + 32, cy, 55, 0, Math.PI * 2); ctx.stroke();
		ctx.lineWidth = 8; ctx.strokeStyle = accent;
		ctx.beginPath(); ctx.arc(cx - 32, cy, 55, 0, Math.PI * 2); ctx.stroke();
		ctx.beginPath(); ctx.arc(cx + 32, cy, 55, 0, Math.PI * 2); ctx.stroke();
	}
	else if (shape === "cross") {
		ctx.shadowBlur = 0;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(cx - 18, cy - 90, 36, 180);
		ctx.fillRect(cx - 60, cy - 45, 120, 36);
		ctx.fillStyle = accent;
		ctx.fillRect(cx - 10, cy - 82, 20, 164);
		ctx.fillRect(cx - 52, cy - 37, 104, 20);
	}
	ctx.restore();
}

function toGray(ctx, x, y, w, h) {
	const img = ctx.getImageData(x, y, w, h);
	const d = img.data;
	for (let i = 0; i < d.length; i += 4) {
		const g = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
		d[i] = d[i + 1] = d[i + 2] = g;
	}
	ctx.putImageData(img, x, y);
}

function drawAvatar(ctx, img, cx, cy, r, accent, gray) {
	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.35)";
	ctx.shadowBlur = 30;
	ctx.fillStyle = "#ffffff";
	ctx.beginPath(); ctx.arc(cx, cy, r + 14, 0, Math.PI * 2); ctx.fill();
	ctx.restore();

	ctx.save();
	ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
	// cover-fit the (usually square) avatar into the circle
	const side = Math.min(img.width, img.height);
	ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, cx - r, cy - r, r * 2, r * 2);
	if (gray) toGray(ctx, Math.round(cx - r), Math.round(cy - r), Math.round(r * 2), Math.round(r * 2));
	ctx.restore();

	ctx.lineWidth = 8; ctx.strokeStyle = accent;
	ctx.beginPath(); ctx.arc(cx, cy, r + 7, 0, Math.PI * 2); ctx.stroke();
}

function fitText(ctx, text, maxWidth) {
	let t = text;
	while (ctx.measureText(t).width > maxWidth && t.length > 1) t = t.slice(0, -1);
	return t === text ? t : t.trimEnd() + "...";
}

function renderCard({ family, variant, imgA, imgB, nameA, nameB, percent }) {
	const W = 1200, H = 700;
	const [c1, c2, accent] = PALETTES[(variant - 1) % PALETTES.length];
	const canvas = Canvas.createCanvas(W, H);
	const ctx = canvas.getContext("2d");

	const bg = ctx.createLinearGradient(0, 0, W, H);
	bg.addColorStop(0, c1); bg.addColorStop(1, c2);
	ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

	// soft bokeh dots (deterministic per variant so a card never looks broken)
	for (let i = 0; i < 40; i++) {
		const x = ((i * 197 + variant * 53) % W), y = ((i * 131 + variant * 29) % H);
		ctx.fillStyle = `rgba(255,255,255,${0.07 + (i % 5) * 0.025})`;
		ctx.beginPath(); ctx.arc(x, y, 10 + (i % 7) * 7, 0, Math.PI * 2); ctx.fill();
	}

	ctx.lineWidth = 10; ctx.strokeStyle = "rgba(255,255,255,0.85)";
	ctx.strokeRect(18, 18, W - 36, H - 36);

	ctx.textAlign = "center"; ctx.textBaseline = "middle";
	ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 12;
	ctx.fillStyle = "#ffffff";
	ctx.font = "bold 64px DejaVu Sans, Arial, sans-serif";
	ctx.fillText(family.title, W / 2, 85);
	ctx.shadowBlur = 0;

	const cy = 330, r = 150;
	drawAvatar(ctx, imgA, 260, cy, r, accent, false);
	drawAvatar(ctx, imgB, W - 260, cy, r, accent, !!family.gray);
	drawCenterShape(ctx, family.shape, W / 2, cy, accent);

	ctx.shadowColor = "rgba(0,0,0,0.35)"; ctx.shadowBlur = 10;
	ctx.fillStyle = "#ffffff";
	ctx.font = "bold 40px DejaVu Sans, Arial, sans-serif";
	if (nameA) ctx.fillText(fitText(ctx, nameA, 420), 260, 560);
	if (nameB) ctx.fillText(fitText(ctx, nameB, 420), W - 260, 560);

	if (family.percent && percent != null) {
		ctx.font = "bold 58px DejaVu Sans, Arial, sans-serif";
		ctx.fillText(`${percent}% MATCH`, W / 2, 625);
	}
	ctx.shadowBlur = 0;
	return canvas.toBuffer("image/png");
}

/* ----------------------------------------------------------------- command */

function createFrameCommand({ name, family: familyKey, variant = 1 }) {
	const family = FAMILIES[familyKey];
	if (!family) throw new Error(`frameCard: unknown family "${familyKey}"`);

	return {
		config: {
			name,
			version: "3.0",
			author: "InstaBOT",
			role: 2, // bot admins only (config.json adminBot)
			countDown: 5,
			shortDescription: `${family.title} card with two profile pictures`,
			category: "LOVE",
			guide: "{pn} @username | reply to someone | {pn} <user id>"
		},

		onStart: async function ({ api, event, args = [], message, usersData }) {
			const senderID = String(event.senderID);
			try {
				// who is the other person: a reply wins, then a tag, then an id / @username / profile link
				let targetID = null;
				if (event.messageReply && event.messageReply.senderID) targetID = String(event.messageReply.senderID);
				else if (event.mentions && Object.keys(event.mentions).length) targetID = String(Object.keys(event.mentions)[0]);
				else if (args.length) {
					const { resolveUserTarget } = require("./utils");
					const found = await resolveUserTarget(args, event, api);
					if (found && found.id) targetID = String(found.id);
					else if (found && found.rateLimited) return message.reply("⚠️ Instagram is rate limiting lookups right now. Reply to the person's message instead, or try again in a minute.");
				}
				if (!targetID)
					return message.reply(`⚠️ Tag or reply to someone.\nExample: reply to their message with  ${name}  or use  ${name} @username`);

				const [rawA, rawB, urlA, urlB] = await Promise.all([
					usersData.getName(senderID), usersData.getName(targetID),
					usersData.getAvatarUrl(senderID), usersData.getAvatarUrl(targetID)
				]);
				const [imgA, imgB] = await Promise.all([
					safeLoadImage(Canvas, axios, urlA),
					safeLoadImage(Canvas, axios, urlB)
				]);

				const percent = pairPercent(senderID, targetID);
				const png = renderCard({
					family, variant, imgA, imgB,
					nameA: drawableName(rawA), nameB: drawableName(rawB), percent
				});

				const body = family.caption(cleanName(rawA), cleanName(rawB), percent);
				const file = path.join(os.tmpdir(), `${name}_${Date.now()}_${Math.floor(Math.random() * 1e4)}.png`);
				fs.writeFileSync(file, png);
				try {
					await message.reply({ body, attachment: fs.createReadStream(file) });
				}
				finally {
					// Delayed: the uploader opens the stream lazily, so never delete the file the instant send() returns.
					const timer = setTimeout(() => fs.unlink(file, () => { }), 60000);
					if (timer.unref) timer.unref();
				}
			}
			catch (err) {
				console.error(`[${name}] failed:`, err && err.stack || err);
				return message.reply(`❌ | ${name} failed: ${String((err && err.message) || err).slice(0, 200)}`);
			}
		}
	};
}

module.exports = { createFrameCommand, FAMILIES, renderCard, pairPercent };
