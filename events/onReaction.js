"use strict";

/**
 * onReaction — runs for reaction events.
 * Records reactions so commands can inspect them, and removes messages that
 * the bot's own admins mark with an angry reaction.
 * Author: Saifullah Al Neoaz (https://github.com/lazyneoaz)
 */

const log = require("../src/logger");

module.exports = {
	config: {
		name: "onReaction",
		category: "system",
		eventType: "message_reaction"
	},

	onEvent: async function ({ event, message, config, threadData, usersData }) {
		const senderID = String(event.senderID || "");
		const isBotAdmin = config.adminBot.includes(senderID);
		const isBoxAdmin = (threadData.adminIDs || []).map(String).includes(senderID);

		if (["😡", "😠"].includes(event.reaction) && (isBotAdmin || isBoxAdmin)) {
			try {
				await message.unsend(event.messageID);
				log.info("REACTION", `${senderID} removed message ${event.messageID}`);
			}
			catch (error) {
				log.warn("REACTION", `Could not remove ${event.messageID}: ${error.message}`);
			}
		}
	}
};
