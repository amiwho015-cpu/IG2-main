"use strict";

module.exports = {
	config: {
		name: "setname",
		aliases: ["settitle", "rename", "setbox"],
		version: "2.0",
		author: "CRX Shihab",
		countDown: 5,
		role: 1,
		shortDescription: { en: "Rename this group chat" },
		category: "box chat",
		guide: { en: "{pn} <new group name>" }
	},

	onStart: async function ({ api, event, args, message, threadsData }) {
		if (!event.isGroup) return message.reply("This command only works in a group thread.");
		const name = args.join(" ").trim();
		if (!name) return message.reply("❌ Please give the new group name.");
		try {
			await api.setTitle(name, event.threadID);
			await threadsData.set(event.threadID, name, "name");
			return message.reply(`✅ Group name changed to: ${name}`);
		}
		catch (error) {
			return message.reply(`❌ Could not rename the group. (${error.message || error})`);
		}
	}
};
