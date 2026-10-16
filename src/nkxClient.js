"use strict";

/**
 * Shared helpers for the NKX GEN image API (used by genx.js and edit.js).
 */

const axios = require("axios");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");

const BASE_URL = "https://nkx-gen.neokex.xyz";
const API_KEY = "nkxgen";

const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "4:5", "5:4"];

const client = axios.create({
	baseURL: BASE_URL,
	timeout: 300000,
	validateStatus: () => true,
	headers: { "X-API-Key": API_KEY }
});

function formatError(res) {
	const d = res && res.data;
	if (d && typeof d === "object") {
		if (d.detail && typeof d.detail === "object" && !Array.isArray(d.detail))
			return d.detail.error || d.error || "Insufficient balance to run this generation.";
		if (typeof d.detail === "string") return d.detail;
		if (Array.isArray(d.detail)) return d.detail.map(x => x.msg || x).join("; ");
		if (d.error) return d.error;
		if (d.hint) return d.hint;
	}
	if (res.status === 401) return "The API rejected its key.";
	if (res.status === 402) return "Not enough credits right now. Try again shortly.";
	if (res.status === 504) return "The job did not finish in time. Try again.";
	if (res.status === 502 || res.status === 503) return "The generation server is waking up. Try again in a moment.";
	return `Request failed (status ${res.status}).`;
}

/** POST /api/generate and return the finished file URL (throws an Error with a readable message). */
async function runJob(payload) {
	let res = await client.post("/api/generate", payload);
	// Some edit models insist on a ratio; retry once with a square one before giving up.
	if ((res.status === 400 || res.status === 422) && !payload.ratio && /ratio/i.test(JSON.stringify(res.data || ""))) {
		res = await client.post("/api/generate", { ...payload, ratio: "1:1" });
	}
	if (res.status >= 400) throw new Error(formatError(res));
	const d = res.data || {};
	const url = d.url || d.thumbnail;
	if (!url) throw new Error("The job finished but returned no file.");
	return url;
}

async function downloadToTemp(url, prefix) {
	const ext = ((url.split("?")[0].split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 4)) || "jpg";
	const file = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e4)}.${ext}`);
	const res = await axios.get(url, { responseType: "arraybuffer", timeout: 120000 });
	await fs.writeFile(file, Buffer.from(res.data));
	return file;
}

function react(api, id, emoji) {
	try { api.setMessageReaction(emoji, id, () => { }, true); } catch (_) { /* optional */ }
}

/**
 * Split command arguments into flags and prompt words.
 *   --m <n>   model number        --ar <ratio>   aspect ratio
 *   --img <url> (repeatable)      --2   also use my previous photo (edit)
 */
function parseArgs(args) {
	const out = { model: null, ratio: null, images: [], two: false, words: [] };
	for (let i = 0; i < args.length; i++) {
		const a = String(args[i]);
		const low = a.toLowerCase();
		if (low === "--m" || low === "--model") { out.model = args[++i] ?? null; }
		else if (low === "--ar") { out.ratio = args[++i] ?? null; }
		else if (low === "--img" || low === "--image" || low === "--url") { if (args[i + 1]) out.images.push(String(args[++i])); }
		else if (low === "--2" || low === "--two" || low === "--both") { out.two = true; }
		else out.words.push(a);
	}
	out.prompt = out.words.join(" ").trim();
	return out;
}

function photosOf(attachments) {
	if (!Array.isArray(attachments)) return [];
	return attachments
		.filter(a => a && (a.type === "photo" || a.type === "sticker"))
		.map(a => a.url || a.largePreviewUrl || a.previewUrl)
		.filter(Boolean);
}

const sameFile = (a, b) => {
	try { return new URL(a).pathname === new URL(b).pathname; } catch (_) { return a === b; }
};

module.exports = { RATIOS, client, formatError, runJob, downloadToTemp, react, parseArgs, photosOf, sameFile };
    
