"use strict";

/**
 * `sing` — send the FULL song as an audio attachment.
 *
 * Unlike `music` (which attaches a 20-30s Instagram music sticker), this command
 * talks to the configured full-song API, picks the best downloadable audio URL
 * from the results and streams those bytes to the chat as a voice/audio message.
 *
 * The track list from `music.apiUrl` may expose the full-song URL under any of a
 * few common keys (`url`, `downloadUrl`, `audioUrl`, `previewUrl`, `stream`,
 * `link`, `src`); we accept the first one we find. `music.apiUrl` is reused, so
 * `{query}` is replaced with the song text just like the sticker command.
 */

function formatDuration(ms) {
	if (!ms || ms < 0) return "0:00";
	const total = Math.round(ms / 1000);
	const minutes = Math.floor(total / 60);
	const seconds = String(total % 60).padStart(2, "0");
	return `${minutes}:${seconds}`;
}

/** Collect a full-song audio URL from a track object, whatever key it uses. */
function pickAudioUrl(track) {
	if (!track || typeof track !== "object") return null;
	const keys = ["url", "downloadUrl", "download_url", "audioUrl", "audio_url",
		"previewUrl", "preview_url", "streamUrl", "stream_url", "stream", "link", "src", "media"];
	for (const key of keys) {
		const value = track[key];
		if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
		if (value && typeof value === "object") {
			const nested = value.url || value.src || value.link;
			if (typeof nested === "string" && /^https?:\/\//i.test(nested)) return nested;
		}
	}
	return null;
}

/** Normalize whatever the API returns into a list with a title, artist and URL. */
function normalizeTracks(data) {
	const list = Array.isArray(data) ? data
		: Array.isArray(data && data.tracks) ? data.tracks
			: Array.isArray(data && data.results) ? data.results
				: Array.isArray(data && data.data) ? data.data
					: Array.isArray(data && data.songs) ? data.songs : [];
	const rows = list.map(entry => {
		const t = entry && entry.track ? entry.track : entry;
		return {
			title: t.title || t.name || t.song || "Unknown",
			artist: t.artist || t.display_artist || t.singer || t.channel || "Unknown",
			durationMs: t.durationMs || t.duration_ms || t.duration || 0,
			url: pickAudioUrl(entry) || pickAudioUrl(t)
		};
	}).filter(row => row.url);
	return rows;
}

async function searchSongs(query, message, config) {
	const music = (config && config.music) || { };

	// Prefer a configured full-song server. Blank apiUrl falls through to
	// Instagram's own music catalogue, whose tracks carry a full-length
	// progressive audio URL.
	if (music.enable !== false && music.apiUrl) {
		const url = music.apiUrl.includes("{query}")
			? music.apiUrl.replace("{query}", encodeURIComponent(query))
			: `${music.apiUrl}${music.apiUrl.includes("?") ? "&" : "?"}query=${encodeURIComponent(query)}`;
		const headers = { "Accept": "application/json" };
		if (music.apiToken) headers["Authorization"] = `Bearer ${music.apiToken}`;
		const res = await fetch(url, { headers });
		if (!res.ok) throw new Error(`music server responded ${res.status}`);
		const tracks = normalizeTracks(await res.json());
		if (tracks.length) return tracks;
	}

	const result = await message.musicSearch(query);
	const tracks = normalizeTracks(result || { });
	if (!tracks.length)
		throw new Error("no full songs found (Instagram returned no audio URL)");
	return tracks;
}

async function sendSong(message, track) {
	if (!track || !track.url)
		return message.reply("That song is no longer available. Search again.");
	try {
		// Instagram's full-song file is an audio-only MP4: tag it with an audio
		// MIME so it routes to sendAudio, not sendVideo. The audio broadcast is
		// media-only (its caption would arrive AFTER the clip), so `textFirst`
		// posts the title as its own message first.
		await message.send({
			body: `${track.title || "Unknown"} — ${track.artist || "Unknown"}${track.durationMs ? ` (${formatDuration(track.durationMs)})` : ""}`,
			attachment: { url: track.url, mimetype: track.mimetype || "audio/mp4" },
			textFirst: true
		});
	}
	catch (error) {
		return message.reply(`Could not send "${track.title || "the song"}": ${String(error.message || error)}`);
	}
}

module.exports = {
	config: {
		name: "sing",
		aliases: [],
		author: "Neoaz 🐊",
		category: "media",
		cooldown: 10,
		role: 0,
		description: { en: "Search and send the full song as audio (not a sticker)" },
		usage: { en: "{p}sing <song name or artist> | {p}sing <number> to pick from the last search" }
	},

	onStart: async function ({ message, args, event, config, usersData, setReplyHandler }) {
		const query = args.join(" ").trim();
		if (!query)
			return message.reply(`Usage: sing <song name>\nExample: sing blinding lights`);

		const last = usersData.get(event.senderID) || { };
		const cached = last.data && last.data.lastSong;

		if (/^\d+$/.test(query) && cached && Array.isArray(cached.tracks) && cached.tracks.length) {
			const index = Number(query) - 1;
			const track = cached.tracks[index];
			if (!track)
				return message.reply(`Pick a number between 1 and ${cached.tracks.length}.`);
			return sendSong(message, track);
		}

		let tracks;
		try {
			tracks = await searchSongs(query, message, config);
		}
		catch (error) {
			return message.reply(`Song search failed: ${String(error.message || error)}`);
		}

		const top = tracks.slice(0, 10);
		usersData.update(event.senderID, { data: Object.assign({ }, last.data, { lastSong: { query, tracks: top } }) });

		if (top.length === 1 || args.includes("--top"))
			return sendSong(message, top[0]);

		const lines = top.map((track, index) =>
			`${index + 1}. ${track.title || "Unknown"} — ${track.artist || "Unknown"}${track.durationMs ? ` (${formatDuration(track.durationMs)})` : ""}`
		);
		const sent = await message.reply(
			`Full songs for "${query}"\n${lines.join("\n")}\n\nReply with sing <number> to send one.`
		);

		if (typeof setReplyHandler === "function") {
			setReplyHandler(async ({ message: replyMessage, event: replyEvent }) => {
				const pick = String(replyEvent.body || "").trim().split(/\s+/).pop();
				if (!/^\d+$/.test(pick)) return;
				const chosen = top[Number(pick) - 1];
				if (!chosen) return replyMessage.reply(`Pick a number between 1 and ${top.length}.`);
				await sendSong(replyMessage, chosen);
			}, sent && sent.messageID);
		}
		return sent;
	}
};
