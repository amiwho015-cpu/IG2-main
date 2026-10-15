"use strict";

const t = require("../src/languages").text;
const { saveConfig } = require("../src/config");

module.exports = {
	config: {
		name: "admin",
		aliases: ["adminbot"],
		author: "Neoaz 🐊",
		category: "admin",
		cooldown: 2,
		role: 2,
		noPrefix: true,
		description: { en: "Add, remove or list bot admins" },
		usage: { en: "{p}admin add|remove|list [userID]" }
	},

	onStart: async function ({ message, args, event, config }) {
		const lang = config.language;
		const action = (args.shift() || "list").toLowerCase();
		let target = args[0];
		if (!target && event.messageReply && event.messageReply.senderID)
			target = event.messageReply.senderID;
		if (target) target = String(target);

		if (action === "list") {
			const list = config.adminBot.length ? config.adminBot.join("\n") : "—";
			return message.reply(t(lang, "adminList", list));
		}

		if (!target || !/^\d+$/.test(target))
			return message.reply("Provide a numeric Instagram user id (or reply to a user's message).");

		if (action === "add") {
			if (config.adminBot.includes(target))
				return message.reply(`${target} is already a bot admin.`);
			config.adminBot.push(target);
			saveConfig(config);
			return message.reply(t(lang, "adminAddedUser", target));
		}

		if (action === "remove") {
			if (!config.adminBot.includes(target))
				return message.reply(`${target} is not a bot admin.`);
			config.adminBot = config.adminBot.filter(id => id !== target);
			saveConfig(config);
			return message.reply(t(lang, "adminRemovedUser", target));
		}

		return message.reply(`Unknown action "${action}". Use add, remove or list.`);
	}
};
