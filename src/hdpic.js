"use strict";

/**
 * Pick the sharpest profile picture from several candidate URLs.
 * Every candidate is downloaded, its real pixel size is read from the image
 * header, and the biggest one wins. Candidates that fail are skipped.
 */



const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const MAX_BYTES = Math.max(256 * 1024, Number(process.env.IG_MAX_MEDIA_BYTES) || 40 * 1024 * 1024);

/** { width, height } for JPEG / PNG / WebP buffers, or null. */
function imageSize(buf) {
	try {
		if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) // PNG
			return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
		if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: walk to a SOF marker
			let i = 2;
			while (i + 9 < buf.length) {
				if (buf[i] !== 0xff) { i++; continue; }
				const marker = buf[i + 1];
				if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
					return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
				i += 2 + buf.readUInt16BE(i + 2);
			}
		}
		if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
			const kind = buf.toString("ascii", 12, 16);
			if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
			if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
		}
	}
	catch (_) { /* unreadable header */ }
	return null;
}

/** Same picture without Instagram's size segment (…/s150x150/… or stp=…_s150x150). */
function upsizedVariants(url) {
	const out = [];
	if (/\/s\d+x\d+\//.test(url)) out.push(url.replace(/\/s\d+x\d+\//, "/"));
	if (/[?&]stp=[^&]*s\d+x\d+/.test(url)) out.push(url.replace(/([?&])stp=[^&]*(&|$)/, (m, a, b) => (b ? a : "")));
	return out;
}

async function fetchImage(url) {
	const axios = require("axios");
	const res = await axios.get(url, {
		responseType: "arraybuffer", timeout: 15000, maxContentLength: MAX_BYTES,
		headers: { "User-Agent": UA, Accept: "image/*,*/*" }
	});
	const buffer = Buffer.from(res.data);
	if (!buffer.length) throw new Error("empty image");
	const size = imageSize(buffer) || { width: 0, height: 0 };
	return { url, buffer, width: size.width, height: size.height, type: String(res.headers["content-type"] || "") };
}

/**
 * @param {string[]} urls candidate picture URLs (best guess first)
 * @returns {Promise<{buffer, width, height, url, ext}|null>}
 */
async function bestPicture(urls) {
	const list = [];
	for (const u of urls.filter(Boolean)) {
		if (!list.includes(u)) list.push(u);
		for (const v of upsizedVariants(u)) if (!list.includes(v)) list.push(v);
	}
	const settled = await Promise.allSettled(list.slice(0, 8).map(fetchImage));
	const images = settled.filter(r => r.status === "fulfilled" && /image/i.test(r.value.type || "image")).map(r => r.value);
	if (!images.length) return null;
	images.sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.buffer.length - a.buffer.length);
	const best = images[0];
	const ext = /png/i.test(best.type) ? "png" : /webp/i.test(best.type) ? "webp" : "jpg";
	return { buffer: best.buffer, width: best.width, height: best.height, url: best.url, ext };
}

module.exports = { bestPicture, imageSize, upsizedVariants };
