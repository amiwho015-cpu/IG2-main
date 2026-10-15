"use strict";

/**
 * onMessage — runs for every incoming message event.
 *  1. Records activity and keeps basic thread metadata fresh.
 *  2. Captures Instagram "Once View" (visual_media) and sends it back to the chat.
 * Author: Saifullah Al Neoaz (https://github.com/lazyneoaz) / Once View by CRX Shihab
 */

const fs = require("fs-extra");
const axios = require("axios");
const path = require("path");
const log = require("../src/logger");

function isOnceView(event) {
	return !!(event && (
		event.item_type === "visual_media" ||
		event.visual_media ||
		event.message_type === "visual_media"
	));
}

async function captureOnceView(event, api) {
	try {
		log.info("ONCEVIEW", "🔥 Once View media detected in Instagram Direct!");

		const visualData = event.visual_media || event;
		const mediaUrl =
			visualData?.image_versions2?.candidates?.[0]?.url ||
			visualData?.video_versions?.[0]?.url ||
			visualData?.media_url ||
			visualData?.url;

		if (!mediaUrl) {
			log.warn("ONCEVIEW", "❌ CDN URL not found in visual media payload.");
			return;
		}

		const dir = path.join(__dirname, "../tmp_once");
		await fs.ensureDir(dir);

		// Download immediately, before the CDN token expires.
		const response = await axios.get(mediaUrl, {
			responseType: "arraybuffer",
			timeout: 15000,
			headers: { "User-Agent": "Instagram 269.0.0.18.75 Android", "Accept": "*/*" }
		});

		const isVideo = !!visualData?.video_versions || /\.mp4/i.test(mediaUrl);
		const filePath = path.join(dir, `once_${Date.now()}${isVideo ? ".mp4" : ".jpg"}`);
		await fs.writeFile(filePath, response.data);
		log.info("ONCEVIEW", `✅ Saved Once View file at: ${filePath}`);

		if (api && typeof api.sendMessage === "function" && event.threadID) {
			await new Promise(resolve => {
				api.sendMessage(
					{ body: "🎯 Captured Once View Media:", attachment: fs.createReadStream(filePath) },
					event.threadID,
					() => resolve()
				);
			});
		}
		fs.remove(filePath).catch(() => { });
	}
	catch (err) {
		log.error("ONCEVIEW", `Error processing Once View media: ${err && err.message}`);
	}
}

module.exports = {
	config: {
		name: "onMessage",
		category: "system",
		// Both a plain message and a reply count as activity.
		eventType: ["message", "message_reply"]
	},

	onEvent: async function ({ event, api, threadsData }) {
		const patch = { lastActivity: Date.now() };
		if (event.isGroup != null) patch.isGroup = event.isGroup;
		if (Array.isArray(event.participantIDs) && event.participantIDs.length)
			patch.members = event.participantIDs.map(String);
		threadsData.update(event.threadID, patch);

		// Run in the background so a slow download never delays replies/commands.
		if (isOnceView(event)) captureOnceView(event, api);
	}
};
