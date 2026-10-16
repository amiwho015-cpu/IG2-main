"use strict";

/**
 * sing — `-sing <song name>`
 * Searches YouTube, takes the TOP result and sends only the audio. No song name, no caption,
 * no "downloading" text: just the song itself (a 🎵 reaction on the request shows it is working).
 *
 * Uses the same API host as the ytb command (apis.json -> "xalman-hub"):
 *   /api/ytsearch?q=...   (search)    /api/ytmp3?url=...   (audio link)
 * If YouTube audio fails for a result it tries the next results, then falls back to SoundCloud
 * (/api/scdlv2) so a song still comes even when one source is down.
 */

const axios = require("axios");
const fs = require("fs");
const os = require("os");
const path = require("path");

const API_CONFIG_URL = "https://raw.githubusercontent.com/goatbotnx/xalmanx210/refs/heads/main/apis.json";
const API_KEY = "xalman-hub";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MAX_TRACKS = 3;                    // how many search results to try before giving up
const MAX_SECONDS = 12 * 60;             // skip very long videos (mixes, live streams)
const MAX_BYTES = 30 * 1024 * 1024;      // skip files too big to send comfortably

let apiBaseUrl = null;
let apiConfigRequest = null;

async function getApiBaseUrl() {
	if (apiBaseUrl) return apiBaseUrl;
	if (!apiConfigRequest) {
		apiConfigRequest = axios.get(API_CONFIG_URL, { timeout: 15000 })
			.then(({ data }) => {
				const baseUrl = data && data[API_KEY];
				if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new Error(`Missing ${API_KEY} in apis.json`);
				apiBaseUrl = baseUrl.replace(/\/+$/, "");
				return apiBaseUrl;
			})
			.finally(() => { apiConfigRequest = null; });
	}
	return apiConfigRequest;
}

function toSeconds(value) {
	if (value == null || value === "") return null;
	if (typeof value === "number") return value;
	const parts = String(value).split(":").map(Number);
	if (parts.some(Number.isNaN)) return null;
	return parts.reduce((total, part) => total * 60 + part, 0);
}

function trackUrl(item) {
	if (!item) return null;
	if (item.url) return item.url;
	if (item.link) return item.link;
	if (item.videoId || item.id) return `https://www.youtube.com/watch?v=${item.videoId || item.id}`;
	return null;
}

// Top results first, but prefer ones of a normal song length when the API tells us the duration.
function pickTracks(results) {
	const usable = results.filter(r => trackUrl(r));
	const normal = usable.filter(r => {
		const s = toSeconds(r.duration || r.seconds || r.timestamp);
		return s == null || s <= MAX_SECONDS;
	});
	return (normal.length ? normal : usable).slice(0, MAX_TRACKS);
}

async function downloadTo(file, url, referer) {
	const res = await axios.get(url, {
		responseType: "stream",
		timeout: 60000,
		maxContentLength: Infinity,
		maxBodyLength: Infinity,
		headers: { "User-Agent": UA, "Accept": "audio/mpeg,audio/*,*/*;q=0.8", ...(referer ? { Referer: referer } : {}) }
	});
	const size = Number(res.headers && res.headers["content-length"]);
	if (size && size > MAX_BYTES) {
		if (res.data && res.data.destroy) res.data.destroy();
		throw new Error("file too large");
	}
	await new Promise((resolve, reject) => {
		const out = fs.createWriteStream(file);
		res.data.on("error", reject);
		out.on("error", reject);
		out.on("finish", resolve);
		res.data.pipe(out);
	});
	const written = fs.statSync(file).size;
	if (!written) throw new Error("empty file");
	if (written > MAX_BYTES) throw new Error("file too large");
}

async function youtubeAudio(base, track, file) {
	const { data } = await axios.get(`${base}/api/ytmp3?url=${encodeURIComponent(trackUrl(track))}`, { timeout: 45000, headers: { "User-Agent": UA } });
	if (!(data && (data.status || data.success)) || !data.url) throw new Error("ytmp3 failed");
	await downloadTo(file, data.url);
}

async function soundcloudAudio(base, query, file) {
	const { data } = await axios.get(`${base}/api/scdlv2?query=${encodeURIComponent(query)}`, { timeout: 25000, headers: { "User-Agent": UA } });
	if (!(data && data.status) || !data.result || !data.result.download_url) throw new Error("soundcloud failed");
	await downloadTo(file, data.result.download_url, "https://soundcloud.com/");
}

function cleanup(file) {
	const timer = setTimeout(() => fs.unlink(file, () => { }), 15000);
	if (timer.unref) timer.unref();
}

module.exports = {
	config: {
		name: "sing",
		version: "5.0",
		author: "InstaBOT",
		countDown: 5,
		role: 0,
		category: "MEDIA",
		shortDescription: { en: "Send a song straight from YouTube" },
		longDescription: { en: "Searches YouTube, takes the top result and sends only the audio — no title or caption." },
		guide: { en: "{pn} <song name>" }
	},

	onStart: async function ({ api, event, args = [] }) {
		const { threadID, messageID } = event;
		const query = args.join(" ").trim();
		if (!query) return api.sendMessage("🎵 গানের নাম লেখো।\nউদাহরণ: -sing baila lento", threadID, messageID);

		const react = (emoji) => { try { api.setMessageReaction(emoji, messageID, () => { }, true); } catch (_) { /* reactions are optional */ } };
		react("🎵");

		const file = path.join(os.tmpdir(), `sing_${Date.now()}_${Math.floor(Math.random() * 1e4)}.mp3`);
		let ready = false;

		try {
			const base = await getApiBaseUrl();

			// 1) YouTube: top results, first one that downloads wins
			try {
				const { data } = await axios.get(`${base}/api/ytsearch?q=${encodeURIComponent(query)}`, { timeout: 25000, headers: { "User-Agent": UA } });
				const results = data && data.status && Array.isArray(data.results) ? data.results : [];
				for (const track of pickTracks(results)) {
					try { await youtubeAudio(base, track, file); ready = true; break; }
					catch (e) { console.log(`[sing] youtube track failed (${trackUrl(track)}): ${e && e.message}`); }
				}
			}
			catch (e) { console.log(`[sing] youtube search failed: ${e && e.message}`); }

			// 2) fallback source
			if (!ready) {
				try { await soundcloudAudio(base, query, file); ready = true; }
				catch (e) { console.log(`[sing] soundcloud fallback failed: ${e && e.message}`); }
			}

			if (!ready) {
				react("❌");
				return api.sendMessage("❌ গানটা পাওয়া যায়নি। অন্য নামে চেষ্টা করো।", threadID, messageID);
			}

			// only the song itself goes into the chat
			await api.sendMessage({ body: "", attachment: fs.createReadStream(file) }, threadID);
			react("✅");
		}
		catch (err) {
			console.error("[sing] error:", err && err.stack || err);
			react("❌");
			return api.sendMessage("❌ গান পাঠানো যায়নি। একটু পরে আবার চেষ্টা করো।", threadID, messageID);
		}
		finally {
			cleanup(file);
		}
	}
};
