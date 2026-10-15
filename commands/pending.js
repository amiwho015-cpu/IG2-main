"use strict";

const { listPending } = require("../src/groupUtil");

module.exports = {
	config: {
		name: "pending",
		aliases: ["requests", "msgrequests"],
		version: "3.0",
		author: "CRX Shihab",
		countDown: 5,
		role: 2,
		shortDescription: { en: "Approve or refuse group requests waiting for the bot" },
		longDescription: { en: "Lists group message requests (pending) and lets a bot admin approve or refuse them by number." },
		category: "owner",
		guide: { en: "{pn}  → list pending groups\nReply with number(s) to approve (e.g. 1 3)\nReply `c <number(s)>` to refuse and leave" }
	},

	onStart: async function ({ api, event, message, commandName }) {
		let groups;
		try { groups = await listPending(api); }
		catch (error) { return message.reply(`❌ Unable to load pending groups. (${error.message || error})`); }
		if (!groups.length) return message.reply("✅ No pending groups found.");

		const text = groups.map((g, i) => `${i + 1}. ${g.name || "Unnamed Group"} → ${g.threadID}`).join("\n");
		message.reply(
			`🔔 PENDING GROUPS (${groups.length})\n\n${text}\n\n👉 Reply with number(s) to approve\n👉 Reply \`c <number(s)>\` to refuse`,
			(err, info) => {
				if (err || !info) return;
				global.GoatBot.onReply.set(info.messageID, { commandName, author: event.senderID, queue: groups });
			}
		);
	},

	onReply: async function ({ api, event, Reply, message, config }) {
		if (event.senderID !== Reply.author) return;
		const input = String(event.body || "").trim();
		const prefix = (config && config.prefix) || "-";
		const botName = (config && config.botName) || "Bot";
		const refuse = /^(c|cancel)\b/i.test(input);
		const nums = (refuse ? input.replace(/^(c|cancel)/i, "") : input).trim().split(/\s+/).map(Number);

		if (!nums.length || nums.some(n => !Number.isInteger(n) || n < 1 || n > Reply.queue.length))
			return message.reply(`❌ Invalid selection: ${input}`);

		let done = 0;
		for (const n of [...new Set(nums)]) {
			const target = Reply.queue[n - 1];
			try {
				if (refuse) {
					// Politely decline, then leave the thread.
					try { await api.sendMessage(`🚫 ${botName}: access refused.`, target.threadID); } catch (_) { /* ignore */ }
					try { await api.handleMessageRequest(target.threadID, false); } catch (_) { /* not available on Instagram */ }
					try { await api.removeUserFromGroup(api.getCurrentUserID(), target.threadID); } catch (_) { /* ignore */ }
				}
				else {
					// Instagram accepts a message request as soon as you reply in it,
					// so the welcome message below is what actually approves the group.
					try { await api.handleMessageRequest(target.threadID, true); } catch (_) { /* not available on Instagram */ }
					await api.sendMessage(`✅ ${botName} activated!\n🔗 Prefix: ${prefix}\nType ${prefix}help to see the commands.`, target.threadID);
				}
				done++;
			}
			catch (error) {
				await message.reply(`❌ Failed for ${target.name || target.threadID}: ${error.message || error}`);
			}
		}
		return message.reply(refuse ? `🚫 ${done} group request(s) refused.` : `✅ ${done} group(s) approved.`);
	}
};
