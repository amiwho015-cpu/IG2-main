"use strict";

/**
 * onMessage — runs for every incoming message event.
 *  1. Records activity and keeps basic thread metadata fresh.
 *  2. Remembers each person's last photos per chat (in memory only, 10 minutes) so the `edit`
 *     command can use "my previous photo" together with the one you reply to (`edit ... --2`).
 * Author: Saifullah Al Neoaz (https://github.com/lazyneoaz)
 */

const PHOTO_TTL_MS = 10 * 60 * 1000;
const PHOTOS_KEPT = 4;

function rememberPhotos(event) {
	if (!Array.isArray(event.attachments) || !event.attachments.length) return;
	const urls = event.attachments
		.filter(a => a && (a.type === "photo" || a.type === "sticker"))
		.map(a => a.url || a.largePreviewUrl || a.previewUrl)
		.filter(Boolean);
	if (!urls.length) return;
	const store = global.__recentPhotos || (global.__recentPhotos = new Map());
	const key = `${event.threadID}:${event.senderID}`;
	const now = Date.now();
	const list = (store.get(key) || []).filter(p => now - p.at < PHOTO_TTL_MS);
	for (const url of urls) list.push({ url, at: now });
	store.set(key, list.slice(-PHOTOS_KEPT));
	if (store.size > 500) store.delete(store.keys().next().value); // keep memory bounded
}

module.exports = {
	config: {
		name: "onMessage",
		category: "system",
		// Both a plain message and a reply count as activity.
		eventType: ["message", "message_reply"]
	},

	onEvent: async function ({ event, threadsData }) {
		const patch = { lastActivity: Date.now() };
		if (event.isGroup != null) patch.isGroup = event.isGroup;
		if (Array.isArray(event.participantIDs) && event.participantIDs.length)
			patch.members = event.participantIDs.map(String);
		threadsData.update(event.threadID, patch);

		try { rememberPhotos(event); } catch (_) { /* never let this break message handling */ }
	}
};
