"use strict";

module.exports = {
	config: {
		name: "boxinfo",
		aliases: ["groupinfo", "gcinfo"],
		version: "2.0",
		author: "CRX Shihab",
		countDown: 5,
		role: 0,
		shortDescription: { en: "Show info about this group" },
		category: "box chat",
		guide: { en: "{pn}" }
	},

	onStart: async function ({ api, event, message, threadsData, usersData }) {
		if (!event.isGroup) return message.reply("This command only works in a group thread.");
		const info = await api.getThreadInfo(event.threadID);
		const members = info.participantIDs || [];
		const admins = (info.adminIDs || []).map(a => String(a.id || a));

		const names = [];
		for (const id of admins.slice(0, 15)) {
			try { names.push("• " + await usersData.getName(id)); } catch (_) { names.push("• " + id); }
		}
		const rules = await threadsData.get(event.threadID, "data.rules", []);
		const onlyAdmin = await threadsData.get(event.threadID, "data.onlyAdminBox", false);

		return message.reply(
			`🔧 Name: ${info.threadName || info.name || "Unnamed"}\n` +
			`🔧 Thread ID: ${event.threadID}\n` +
			`🔧 Members: ${members.length}\n` +
			`🔧 Admins (${admins.length}):\n${names.join("\n") || "• none known"}\n` +
			`🔧 Rules set: ${rules.length}\n` +
			`🔧 Admin-only mode: ${onlyAdmin ? "on" : "off"}`
		);
	}
};
