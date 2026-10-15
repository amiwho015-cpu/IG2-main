"use strict";

module.exports = {
	config: {
		name: "adboxonly",
		aliases: ["onlyadminbox", "onlyadbox", "adminboxonly"],
		version: "2.0",
		author: "CRX Shihab",
		countDown: 5,
		role: 1,
		shortDescription: { en: "Only group admins can use the bot" },
		category: "box chat",
		guide: { en: "{pn} on | off\n{pn} noti on | off — notice shown to non-admins" }
	},

	onStart: async function ({ args, message, event, threadsData }) {
		const noti = args[0] === "noti";
		const word = String(args[noti ? 1 : 0] || "").toLowerCase();
		if (word !== "on" && word !== "off") return message.reply("Syntax: adboxonly on|off  or  adboxonly noti on|off");
		const value = word === "on";

		if (noti) {
			// "noti on" = tell non-admins; stored inverted as "hide notice".
			await threadsData.set(event.threadID, !value, "data.hideNotiMessageOnlyAdminBox");
			return message.reply(value ? "Notice for non-admins turned on." : "Notice for non-admins turned off.");
		}
		await threadsData.set(event.threadID, value, "data.onlyAdminBox");
		return message.reply(value ? "Only group admins can use the bot now." : "Everyone can use the bot again.");
	}
};
