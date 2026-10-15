// autosticker: when someone sends a sticker/GIF in a group, the bot sends it back.
//
// Instagram has no API for a bot to send one of its own stickers, so the bot
// downloads the sticker that was just sent and posts it back as an image.
// Off by default; a group admin turns it on with "autosticker on".

const COOLDOWN_MS = 4000; // per group, so two bots / fast stickers cannot loop or spam
const lastReply = new Map(); // threadID -> time of the last reply
const debugThreads = new Set();

const STICKER_TYPES = ["sticker", "animated_image", "animated_media", "gif", "giphy", "avatar_sticker"];

function findSticker(attachments) {
	if (!Array.isArray(attachments)) return null;
	return attachments.find(att => {
		if (!att || typeof att !== "object") return false;
		const type = String(att.type || "").toLowerCase();
		return STICKER_TYPES.includes(type) || type.includes("sticker");
	}) || null;
}

function urlOf(att) {
	return att.url || att.largePreviewUrl || att.previewUrl || att.image_url || att.imageUrl || att.thumbnail || null;
}

module.exports = {
	config: {
		name: "autosticker",
		aliases: ["autostk"],
		version: "1.0",
		author: "CRX Shihab",
		countDown: 3,
		role: 1,
		shortDescription: { en: "Reply to stickers with a sticker" },
		longDescription: { en: "When a member sends a sticker or GIF, the bot sends it back." },
		category: "BOX CHAT",
		guide: { en: "{pn} on | off | status | debug" }
	},

	onStart: async function ({ args, event, message, threadsData }) {
		const threadID = event.threadID;
		const action = String(args[0] || "status").toLowerCase();
		const enabled = !!(await threadsData.get(threadID, "data.autosticker", false));

		if (action === "on") {
			await threadsData.set(threadID, true, "data.autosticker");
			return message.reply("✅ AutoSticker is ON. I will send a sticker back when someone sends one.");
		}
		if (action === "off") {
			await threadsData.set(threadID, false, "data.autosticker");
			return message.reply("❌ AutoSticker is OFF.");
		}
		if (action === "debug") {
			// Prints what Instagram sends for a sticker, in the console, so the detection can be tuned.
			if (debugThreads.has(String(threadID))) { debugThreads.delete(String(threadID)); return message.reply("🔧 Debug OFF."); }
			debugThreads.add(String(threadID));
			return message.reply("🔧 Debug ON. Send a sticker, then look at the bot console for [AUTOSTICKER DEBUG].");
		}
		return message.reply(`📌 AutoSticker: ${enabled ? "✅ ON" : "❌ OFF"}\nUse: autosticker on | off | debug`);
	},

	onChat: async function ({ api, event, message, threadsData }) {
		const attachments = event.attachments;
		if (!Array.isArray(attachments) || !attachments.length) return;
		const threadID = String(event.threadID);

		if (debugThreads.has(threadID)) {
			console.log("[AUTOSTICKER DEBUG]", JSON.stringify(attachments.map(a => ({ type: a && a.type, keys: a && Object.keys(a), url: a && urlOf(a) }))));
		}

		const botID = api && typeof api.getCurrentUserID === "function" ? String(api.getCurrentUserID()) : null;
		if (botID && String(event.senderID) === botID) return;

		const sticker = findSticker(attachments);
		if (!sticker) return;
		if (!(await threadsData.get(threadID, "data.autosticker", false))) return;

		const now = Date.now();
		if (now - (lastReply.get(threadID) || 0) < COOLDOWN_MS) return;
		lastReply.set(threadID, now);

		const url = urlOf(sticker);
		try {
			if (!url) throw new Error("sticker has no url");
			const stream = await global.utils.getStreamFromURL(url);
			await message.reply({ attachment: stream });
		}
		catch (error) {
			console.log("[AUTOSTICKER] could not send the sticker back:", error && error.message);
			try { await message.react("😄"); } catch (_) { /* reaction is only a fallback */ }
		}
	}
};
