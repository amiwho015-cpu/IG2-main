"use strict";

/**
 * Message / event dispatcher: prefix parsing, roles, cooldowns, reply and
 * reaction hooks, and event script fan-out.
 * Author: Saifullah Al Neoaz (https://github.com/lazyneoaz)
 */

const t = require("./languages").text;
const log = require("./logger");
const { createMessageContext } = require("./message");

const ROLE_USER = 0;
const ROLE_ADMIN_BOX = 1;
const ROLE_ADMIN_BOT = 2;

function createDispatcher({ api, config, registry, database }) {
	const cooldowns = new Map();
	const onReply = new Map(); // messageID -> { commandName, handler, at }
	const onReaction = new Map(); // messageID -> { commandName, handler, at }
	const refreshedUsers = new Set();

	// Reply/reaction handlers are keyed by message id and were never removed, so
	// a long-running bot leaked one closure per command that arms a handler (AI,
	// roll, sing, cmd…). Reply handlers are also consumed one-shot in
	// runReplyHandlers; this sweep bounds the rest (e.g. reaction handlers that
	// are never triggered) by age.
	const HANDLER_TTL_MS = 30 * 60 * 1000;
	function pruneHandlers(now) {
		for (const map of [onReply, onReaction]) {
			if (map.size < 256) continue;
			for (const [key, value] of map) {
				if (now - (value.at || 0) > HANDLER_TTL_MS) map.delete(key);
			}
		}
	}

	function senderIDOf(event) {
		return String(event.senderID || event.userID || "");
	}

	function isBotAdmin(id) {
		return config.adminBot.includes(String(id));
	}

	function roleOf(event, threadData) {
		const senderID = senderIDOf(event);
		if (isBotAdmin(senderID)) return ROLE_ADMIN_BOT;
		const admins = (threadData && threadData.adminIDs) || [];
		if (admins.map(String).includes(senderID)) return ROLE_ADMIN_BOX;
		return ROLE_USER;
	}

	function requiredRole(command, threadData) {
		const configured = command.config.role;
		let role = 0;
		if (typeof configured === "number") role = configured;
		else if (configured && typeof configured === "object" && typeof configured.onStart === "number") role = configured.onStart;
		if (threadData && threadData.settings && typeof threadData.settings.setRole === "object")
			return threadData.settings.setRole[command.config.name] ?? role;
		return role;
	}

	function allowedByWhitelist(event) {
		if (!config.whiteList.enable) return true;
		const senderID = senderIDOf(event);
		if (isBotAdmin(senderID)) return true;
		return config.whiteList.userIDs.includes(senderID) || config.whiteList.threadIDs.includes(String(event.threadID));
	}

	function cooldownRemaining(command, senderID) {
		const seconds = Number(command.config.cooldown ?? config.cooldown.default) || 0;
		if (seconds <= 0) return 0;
		const key = `${command.config.name}:${senderID}`;
		const last = cooldowns.get(key) || 0;
		const remaining = last + seconds * 1000 - Date.now();
		if (remaining > 0) return Math.ceil(remaining / 1000);
		cooldowns.set(key, Date.now());
		return 0;
	}

	/**
	 * Arm a reply handler. `options.persistent` keeps it armed after a reply
	 * (GoatBot semantics: the command removes it itself via
	 * `global.GoatBot.onReply.delete(id)`), which games need so that a wrong
	 * answer / invalid input does not kill the round. `options.threadID` lets the
	 * dispatcher fall back to the thread's latest handler when Instagram reports
	 * a different id for a media message than the one the send call returned.
	 */
	function registerOnReply(messageID, commandName, handler, options) {
		const opts = options || {};
		onReply.set(String(messageID), {
			commandName, handler, at: Date.now(),
			persistent: opts.persistent === true,
			fallback: opts.fallback === true,
			author: opts.author != null ? String(opts.author) : null,
			bodyMatch: opts.bodyMatch ? String(opts.bodyMatch).replace(/\s+/g, " ").trim() : null,
			threadID: opts.threadID != null ? String(opts.threadID) : null
		});
		return handler;
	}

	function unregisterOnReply(messageID) {
		return onReply.delete(String(messageID));
	}

	function registerOnReaction(messageID, commandName, handler) {
		onReaction.set(String(messageID), { commandName, handler, at: Date.now() });
		return handler;
	}

	function suggestionFor(name) {
		if (!name) return null;
		const candidates = new Set(registry.commands.keys());
		for (const alias of registry.aliases.keys()) candidates.add(alias);

		let best = null;
		let bestDistance = Infinity;
		for (const candidate of candidates) {
			const distance = levenshtein(name, candidate);
			// Nudge ties toward the shorter, more likely candidate.
			if (distance < bestDistance || (distance === bestDistance && best && candidate.length < best.length)) {
				bestDistance = distance;
				best = candidate;
			}
		}
		// Accept close matches only; 1 edit for short names, 2 for longer ones.
		const limit = name.length <= 3 ? 1 : 2;
		return bestDistance <= limit ? best : null;
	}

	function levenshtein(a, b) {
		const rows = Array.from({ length: b.length + 1 }, (_, i) => i);
		for (let i = 1; i <= a.length; i++) {
			let previous = rows[0];
			rows[0] = i;
			for (let j = 1; j <= b.length; j++) {
				const temp = rows[j];
				rows[j] = Math.min(rows[j] + 1, rows[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
				previous = temp;
			}
		}
		return rows[b.length];
	}

	async function runCommands(event, message, threadData, userData) {
		const body = typeof event.body === "string" ? event.body : "";
		if (!body) return;
		const senderID = senderIDOf(event);
		const hasPrefix = config.prefix && body.startsWith(config.prefix);

		const rawBody = hasPrefix ? body.slice(config.prefix.length).trim() : body.trim();
		const rawArgs = rawBody ? rawBody.split(/\s+/) : [];
		const rawName = (rawArgs[0] || "").toLowerCase();

		// A command can opt into running without the prefix (config.noPrefix).
		// `prefix` uses this so the operator is never locked out after changing
		// (or forgetting) the prefix. Restrict to bot admins unless the command
		// explicitly allows role 0.
		const bare = registry.resolve(rawName);
		const bareAllowed = !!bare && bare.config.noPrefix === true &&
			(isBotAdmin(senderID) || bare.config.noPrefixRole === 0);
		const noPrefixAllowed = config.noPrefix === true && isBotAdmin(senderID);

		if (!hasPrefix && !bareAllowed && !noPrefixAllowed) return;

		const args = rawArgs.slice();
		const name = (args.shift() || "").toLowerCase();
		const command = registry.resolve(name);

		if (!command) {
			if (config.hideNotiMessage.commandNotFound || !hasPrefix) return;
			const suggestion = suggestionFor(name);
			// Uses the configured prefix via {pn}: "Did you mean -ping or try -help".
			const key = suggestion ? "commandNotFoundSuggestion" : "commandNotFound";
			const text = t(config.language, key, suggestion || "");
			return message.reply(text.replace(/\{pn\}/g, config.prefix));
		}

		const commandName = command.config.name.toLowerCase();

		if (userData && userData.banned && userData.banned.status) {
			if (!config.hideNotiMessage.userBanned)
				return message.reply(t(config.language, "userBanned", config.botName, userData.banned.reason || "—"));
			return;
		}

		if (config.adminOnly.enable && !isBotAdmin(senderID) && !config.adminOnly.ignoreCommands.includes(commandName)) {
			if (!config.hideNotiMessage.adminOnly)
				return message.reply(t(config.language, "onlyAdminBot", commandName));
			return;
		}

		const role = roleOf(event, threadData);

		// Per-group "only group admins can use the bot" mode (command: adboxonly).
		if (threadData && threadData.data && threadData.data.onlyAdminBox === true &&
			event.isGroup !== false && role < ROLE_ADMIN_BOX) {
			if (!threadData.data.hideNotiMessageOnlyAdminBox)
				return message.reply("Only group admins can use the bot in this group right now.");
			return;
		}

		const needRole = requiredRole(command, threadData);
		if (needRole > role) {
			if (!config.hideNotiMessage.needRoleToUseCommand) {
				const key = needRole === ROLE_ADMIN_BOT ? "onlyAdminBot" : "onlyAdmin";
				return message.reply(t(config.language, key, commandName));
			}
			return;
		}

		const wait = cooldownRemaining(command, senderID);
		if (wait) return message.reply(t(config.language, "cooldown", wait, commandName));

		const commandApi = {
			api,
			message,
			event,
			args,
			commandName,
			// The name the user actually typed (an alias like `unban`), which is
			// what a command with several aliases must branch on. `commandName`
			// is always the canonical name (e.g. `ban`).
			invokedAs: name,
			role,
			usersData: database.users,
			threadsData: database.threads,
			userData,
			threadData,
			config,
			registry,
			/**
			 * Arm a handler for a reply. Pass the message a user must reply TO
			 * (`messageID`), e.g. the result of `message.reply(...)`. Without it
			 * the triggering message is used, which only matches replies to the
			 * command message itself.
			 */
			setReplyHandler(handler, messageID) {
				const key = messageID != null ? messageID : event.messageID;
				if (key == null) return handler;
				onReply.set(String(key), { commandName, handler, at: Date.now() });
				return handler;
			},
			setReactionHandler(handler, messageID) {
				const key = messageID != null ? messageID : event.messageID;
				if (key == null) return handler;
				onReaction.set(String(key), { commandName, handler, at: Date.now() });
				return handler;
			}
		};

		try {
			await command.onStart(commandApi);
			log.info("COMMAND", `${commandName} | ${senderID} | ${event.threadID} | ${args.join(" ")}`);
		}
		catch (error) {
			log.error("COMMAND", `Error in "${commandName}"`, error);
			await message.reply(t(config.language, "errorOccurred", commandName, String(error.message || error)));
		}
	}

	/**
	 * Find the handler a reply is aimed at. Exact message-id match first. If that
	 * fails for a reply to one of the BOT's own media messages (Instagram can
	 * report an image under a different id than the send call returned, and a
	 * media-only message carries no text), fall back to the newest persistent
	 * image-game handler armed in this thread by that same player, so a game
	 * keeps working instead of silently ignoring the player. Replies to text
	 * messages never use the fallback.
	 */
	function findReplyEntry(event) {
		const replied = event.messageReply;
		if (!replied) return null;
		const repliedID = replied.messageID != null ? String(replied.messageID) : null;
		if (repliedID && onReply.has(repliedID)) return { id: repliedID, entry: onReply.get(repliedID) };

		// Instagram reports a sent message under a different id format (numeric item id vs "mid.$...")
		// than the send call returned, so an exact id match can miss. A reply to one of the bot's TEXT
		// messages is then matched by the quoted text itself (handlers opt in with `replyBody`).
		if (replied.body && String(replied.body).trim()) {
			const quoted = String(replied.body).replace(/\s+/g, " ").trim();
			const body0 = typeof event.body === "string" ? event.body : "";
			if (!(config.prefix && body0.startsWith(config.prefix))) {
				const tid = String(event.threadID);
				const sid = senderIDOf(event);
				let hit = null;
				for (const [id, entry] of onReply) {
					if (!entry.persistent || !entry.bodyMatch || entry.bodyMatch !== quoted) continue;
					if (entry.threadID !== tid) continue;
					if (entry.author && entry.author !== sid) continue;
					if (Date.now() - (entry.at || 0) > HANDLER_TTL_MS) continue;
					if (!hit || entry.at >= hit.entry.at) hit = { id, entry };
				}
				if (hit) { log.warn("REPLY", `reply to ${repliedID || "unknown id"} matched by text; using ${hit.entry.commandName} handler (${hit.id})`); return hit; }
			}
		}

		const botID = api && typeof api.getCurrentUserID === "function" ? String(api.getCurrentUserID()) : null;
		const repliedToBot = !replied.senderID || (botID && String(replied.senderID) === botID);
		const hasMedia = Array.isArray(replied.attachments) && replied.attachments.length > 0;
		// Instagram sometimes reports the bot's own image with a different sender id format, so an
		// attachment-only message still counts as the bot's when it carries media and no text.
		if (!repliedToBot && !hasMedia) return null;
		if (replied.body && String(replied.body).trim()) return null; // text message: exact id or nothing
		// A reply that is really a command ("-help" swiped onto a bot message) must stay a command.
		const body = typeof event.body === "string" ? event.body : "";
		if (config.prefix && body.startsWith(config.prefix)) return null;

		const threadID = String(event.threadID);
		const senderID = senderIDOf(event);
		let best = null;
		for (const [id, entry] of onReply) {
			// Only handlers armed on an image post, only in this thread, and only for the player who owns the game.
			if (!entry.persistent || !entry.fallback || entry.threadID !== threadID) continue;
			if (entry.author && entry.author !== senderID) continue;
			if (Date.now() - (entry.at || 0) > HANDLER_TTL_MS) continue;
			if (!best || entry.at >= best.entry.at) best = { id, entry };
		}
		if (best) log.warn("REPLY", `reply to ${repliedID || "unknown id"} matched no handler; using the latest ${best.entry.commandName} handler in this thread (${best.id})`);
		return best;
	}

	async function runReplyHandlers(event, message, threadData, userData) {
		const found = findReplyEntry(event);
		if (!found) return false;
		const entry = found.entry;
		// Plain (non-GoatBot) handlers are one-shot: consume them so the map cannot
		// grow without bound; a handler that wants to keep a conversation going
		// re-arms itself via setReplyHandler (the AI command does this). GoatBot
		// handlers are persistent and removed by the command itself.
		if (!entry.persistent) onReply.delete(found.id);
		else entry.at = Date.now();

		// A banned user must not drive an armed handler (AI chat, sing/roll pick…)
		// just because they replied instead of typing a command. Consume the
		// handler and drop the turn, mirroring how runCommands refuses the ban.
		if (userData && userData.banned && userData.banned.status) {
			if (!config.hideNotiMessage.userBanned)
				await message.reply(t(config.language, "userBanned", config.botName, userData.banned.reason || "—"));
			return true;
		}

		try {
			await entry.handler({
				api,
				message,
				event,
				args: event.body ? event.body.split(/\s+/) : [],
				usersData: database.users,
				threadsData: database.threads,
				userData,
				threadData,
				config,
				commandName: entry.commandName,
				// A reply handler may arm a new handler so a conversation can keep
				// threading (the AI command does this).
				setReplyHandler(handler, messageID) {
					const key = messageID != null ? messageID : event.messageID;
					if (key == null) return handler;
					onReply.set(String(key), { commandName: entry.commandName, handler, at: Date.now() });
					return handler;
				},
				setReactionHandler(handler, messageID) {
					const key = messageID != null ? messageID : event.messageID;
					if (key == null) return handler;
					onReaction.set(String(key), { commandName: entry.commandName, handler, at: Date.now() });
					return handler;
				}
			});
		}
		catch (error) {
			log.error("REPLY", `Error in reply handler for "${entry.commandName}"`, error);
		}
		return true;
	}

	async function runReactionHandlers(event, message, threadData, userData) {
		const entry = onReaction.get(String(event.messageID));
		if (!entry) return false;
		// Same ban rule as a reply: a banned user cannot drive an armed handler.
		if (userData && userData.banned && userData.banned.status) return true;
		try {
			await entry.handler({
				api,
				message,
				event,
				usersData: database.users,
				threadsData: database.threads,
				userData,
				threadData,
				config,
				commandName: entry.commandName,
				setReplyHandler(handler, messageID) {
					const key = messageID != null ? messageID : event.messageID;
					if (key == null) return handler;
					onReply.set(String(key), { commandName: entry.commandName, handler, at: Date.now() });
					return handler;
				},
				setReactionHandler(handler, messageID) {
					const key = messageID != null ? messageID : event.messageID;
					if (key == null) return handler;
					onReaction.set(String(key), { commandName: entry.commandName, handler, at: Date.now() });
					return handler;
				}
			});
		}
		catch (error) {
			log.error("REACTION", `Error in reaction handler for "${entry.commandName}"`, error);
		}
		return true;
	}

	async function runEventScripts(event, message, threadData, userData) {
		for (const script of registry.events) {
			// eventType may be a single type or an array of them (e.g. onMessage
			// listens to both "message" and "message_reply").
			const wanted = script.config.eventType;
			if (wanted) {
				const list = Array.isArray(wanted) ? wanted : [wanted];
				if (!list.includes(event.type)) continue;
			}
			try {
				await script.onEvent({ api, message, event, usersData: database.users, threadsData: database.threads, userData, threadData, config, role: roleOf(event, threadData) });
			}
			catch (error) {
				log.error("EVENT", `Error in event "${script.config.name}"`, error);
			}
		}
	}

	function refreshUserIfNeeded(userData, userID) {
		if (!userData || userData.name || refreshedUsers.has(userID)) return;
		refreshedUsers.add(userID);
		api.getUserInfo(userID, (error, info) => {
			if (error || !info || !info[userID]) return;
			const profile = info[userID];
			database.users.update(userID, {
				name: profile.name || profile.firstName || null,
				username: profile.vanity || null
			});
		});
	}

	/**
	 * Decide whether a thread is a group. The transport reports `isGroup` when
	 * it knows it; when the field is missing we check the event's participant
	 * list, then a cached value, and finally ask the API once per thread.
	 */
	async function resolveThreadGroup(event, threadData) {
		if (event.isGroup === true) return { isGroup: true, known: true };
		if (event.isGroup === false) return { isGroup: false, known: true };
		const members = new Set();
		for (const list of [event.participantIDs, event.userIDs]) {
			if (Array.isArray(list)) for (const id of list) if (id != null && String(id)) members.add(String(id));
		}
		if (members.size > 1) return { isGroup: true, known: true };
		if (threadData.groupKnown) return { isGroup: threadData.isGroup === true, known: true };
		try {
			const info = await new Promise((resolve, reject) =>
				api.getThreadInfo(event.threadID, (error, result) => error ? reject(error) : resolve(result)));
			const isGroup = !!(info && (info.isGroup === true || Number(info.threadType) === 2 ||
				(Array.isArray(info.participantIDs) && info.participantIDs.length > 2)));
			database.threads.update(event.threadID, { isGroup, groupKnown: true, name: info && info.name || undefined });
			return { isGroup, known: true };
		}
		catch (_) {
			// Could not confirm: do not cache a guess, and treat as unknown.
			return { isGroup: false, known: false };
		}
	}

	async function handle(event) {
		if (!event || !event.threadID) return;
		pruneHandlers(Date.now());
		const senderID = senderIDOf(event);
		if (!senderID && (event.type === "message" || event.type === "message_reply")) return;

		if (!allowedByWhitelist(event)) return;

		const threadData = database.threads.ensure(event.threadID, { threadID: event.threadID });
		let userData = null;
		if (senderID) userData = database.users.ensure(senderID, { userID: senderID });

		// Resolve the real thread type before any command or event script runs,
		// and feed the answer back onto the event so join/leave scripts and
		// group-only commands see the truth.
		const group = await resolveThreadGroup(event, threadData);
		event.isGroup = group.isGroup;
		threadData.isGroup = group.isGroup;
		if (group.known) threadData.groupKnown = true;

		const message = createMessageContext({ api, event, log });

		switch (event.type) {
			case "message":
			case "message_reply":
				refreshUserIfNeeded(userData, senderID);
				await runEventScripts(event, message, threadData, userData);
				if (await runReplyHandlers(event, message, threadData, userData)) break;
				await runCommands(event, message, threadData, userData);
				break;
			case "message_reaction":
				await runEventScripts(event, message, threadData, userData);
				await runReactionHandlers(event, message, threadData, userData);
				break;
			default:
				await runEventScripts(event, message, threadData, userData);
				break;
		}

		database.threads.flush();
		database.users.flush();
	}

	return { handle, roleOf, registerOnReply, unregisterOnReply, registerOnReaction, ROLE_USER, ROLE_ADMIN_BOX, ROLE_ADMIN_BOT };
}

module.exports = { createDispatcher, ROLE_USER, ROLE_ADMIN_BOX, ROLE_ADMIN_BOT };
