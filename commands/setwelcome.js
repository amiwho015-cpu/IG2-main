"use strict";

module.exports = {
	config: {
		name: "setwelcome",
		aliases: ["setwc"],
		version: "2.0",
		author: "CRX Shihab",
		countDown: 5,
		role: 1,
		shortDescription: { en: "Edit the welcome message of this group" },
		category: "box chat",
		guide: {
			en: "{pn} text <message> — set the message\n{pn} text reset — back to default\n{pn} on | off — enable/disable\n{pn} show — view current\n\nShortcuts: {userName} = member, {boxName} = group name"
		}
	},

	onStart: async function ({ args, message, event, threadsData }) {
		const tid = event.threadID;
		const sub = String(args[0] || "").toLowerCase();

		if (sub === "on" || sub === "off") {
			await threadsData.set(tid, sub === "off", "data.welcomeOff");
			return message.reply("welcome message turned " + sub + ".");
		}
		if (sub === "show") {
			const cur = await threadsData.get(tid, "data.welcomeMessage", null);
			const off = await threadsData.get(tid, "data.welcomeOff", false);
			return message.reply("Status: " + (off ? "off" : "on") + "\nMessage: " + (cur || "(default)"));
		}
		if (sub === "text") {
			const body = args.slice(1).join(" ").trim();
			if (!body) return message.reply("❌ Give the message text, or 'reset'.");
			if (body.toLowerCase() === "reset") {
				await threadsData.set(tid, null, "data.welcomeMessage");
				return message.reply("✅ welcome message reset to default.");
			}
			await threadsData.set(tid, body, "data.welcomeMessage");
			return message.reply("✅ welcome message saved:\n" + body);
		}
		return message.reply("Usage: {pn} text <message> | text reset | on | off | show".replace("{pn}", "setwelcome"));
	}
};
