"use strict";

/**
 * InstaBOT runtime: login, listener and lifecycle.
 * Author: Saifullah Al Neoaz (https://github.com/lazyneoaz)
 */

const log = require("./logger");
const { loadAccount } = require("./config");
const { createDatabase } = require("./database");
const { createRegistry, loadAll } = require("./commandLoader");
const { createDispatcher } = require("./dispatcher");
const goatCompat = require("./goatCompat");
const { createOnlineStatus } = require("./onlineStatus");

const serverLogin = require("../auth");

/**
 * Cookies the bot itself will hand to the server. `IG_COOKIES` (an env var on
 * the bot service) wins, else `account.txt`. Returns a cookie blob (string,
 * JSON array or Netscape text) the server understands, or null when the bot has
 * none — in which case the server must have its own.
 */
function loadServerCookies() {
	if (process.env.IG_COOKIES && process.env.IG_COOKIES.trim()) return process.env.IG_COOKIES.trim();
	try {
		return loadAccount();
	}
	catch (_) {
		return null;
	}
}

/**
 * Resolve the login function. When `server.url` + `server.token` are set the
 * bot talks to the private ig-chat-api server through auth.js; otherwise it
 * falls back to a locally-installed ig-chat-api package (Mode B, development).
 */
function resolveLogin(config) {
	const server = config.server || {};
	const wantDirect = server.mode === "direct";
	if (!wantDirect && server.url && server.token) return { login: serverLogin, mode: "server" };
	// Direct mode (same as Insta-Bot3): talk to Instagram through the locally
	// installed ig-chat-api package. Bot3's package is tried first.
	for (const name of ["@lazyneoaz/ig-chat-api", "ig-chat-api"]) {
		try {
			const mod = require(name);
			const login = typeof mod === "function" ? mod : (mod && (mod.login || mod.default));
			if (typeof login === "function") return { login, mode: "direct" };
		}
		catch (_) { /* try the next package */ }
	}
	throw new Error(
		"Direct mode needs the ig-chat-api package, but it is not installed.\n" +
		"Run: npm install @lazyneoaz/ig-chat-api   (cookies go in account.txt)\n" +
		"Or set server.mode to \"server\" and give server.url + server.token in config.json."
	);
}

/**
 * Normalize an ig-chat-api event into the shape the rest of InstaBOT uses:
 *  - add `messageReply` (mirroring `repliedToMessage`) and switch the type to
 *    "message_reply" so commands can branch on replies,
 *  - map media attachment types ("image" -> "photo"),
 *  - add a `userID` alias for `senderID`.
 * ig-chat-api itself is left untouched.
 */
function normalizeEvent(event) {
	if (!event || typeof event !== "object") return event;
	const normalized = Object.assign({}, event);

	if (Array.isArray(normalized.attachments)) {
		normalized.attachments = normalized.attachments.map(att => {
			if (!att || typeof att !== "object") return att;
			const type = att.type === "image" ? "photo" : att.type === "gif" ? "animated_image" : att.type;
			return Object.assign({}, att, { type });
		});
	}

	if (normalized.repliedToMessage) {
		const replied = normalized.repliedToMessage;
		normalized.messageReply = {
			messageID: replied.messageID || null,
			senderID: replied.senderID != null ? String(replied.senderID) : null,
			body: replied.body != null ? String(replied.body) : "",
			attachments: Array.isArray(replied.attachments) ? replied.attachments : [],
			timestamp: replied.timestamp || null
		};
		if (normalized.type === "message") normalized.type = "message_reply";
	}

	if (normalized.senderID != null && normalized.userID == null) normalized.userID = normalized.senderID;
	if (normalized.userID != null && normalized.senderID == null) normalized.senderID = normalized.userID;

	// Membership changes (join/leave) may arrive under different names depending
	// on the transport; normalize the participant lists every event script reads.
	const added = firstArray(normalized.userIDs, normalized.addedParticipants, normalized.added_participants,
		normalized.added_users, normalized.added_user_ids, normalized.usersAdded, normalized.users_added,
		normalized.participantsAdded, normalized.participants_added);
	const removed = firstArray(normalized.removedParticipants, normalized.removed_participants,
		normalized.removed_users, normalized.removed_user_ids, normalized.left_users, normalized.usersRemoved,
		normalized.users_removed, normalized.participantsRemoved, normalized.participants_removed);

	if (normalized.type === "join" && !normalized.userIDs) normalized.userIDs = added || [];
	if (normalized.type === "leave" && !normalized.userIDs) normalized.userIDs = removed || [];

	// Infer a group thread when the API omitted isGroup: the realtime payload
	// often does. A participant list with more than one member, or a legacy
	// "thread:user" id, both mean a group.
	if (normalized.isGroup !== true) {
		const members = [...(added || []), ...(removed || []), ...(normalized.userIDs || []),
			...(normalized.participantIDs || []), ...(normalized.participants || [])];
		const unique = new Set(members.map(String).filter(Boolean));
		const legacyGroup = String(normalized.threadID || "").includes(":");
		const isMembership = normalized.type === "join" || normalized.type === "leave";
		const looksGroup = Array.isArray(added) || Array.isArray(removed) ||
			isMembership || legacyGroup || unique.size > 2;
		if (looksGroup) normalized.isGroup = true;
	}

	return normalized;
}

// Return the first argument that is a non-empty array, else null.
function firstArray(...candidates) {
	for (const value of candidates) {
		if (Array.isArray(value)) return value;
	}
	return null;
}

function createBot(config) {
	const startedAt = Date.now();
	global.instabotStartedAt = startedAt;
	const database = createDatabase(config);
	const registry = createRegistry();
	goatCompat.install({ config, database, registry });
	const state = {
		api: null,
		botID: null,
		listening: null,
		stopListening: null,
		listenerGeneration: 0,
		restartTimer: null,
		retireListener: null,
		running: false,
		stopping: false,
		commandCount: 0,
		eventCount: 0,
		messagesHandled: 0
	};

	const onlineStatus = createOnlineStatus({
		config,
		startedAt,
		stats: () => ({
			botID: state.botID,
			commands: state.commandCount,
			events: state.eventCount,
			messagesHandled: state.messagesHandled
		})
	});

	let dispatcher = null;

	function loadCommands() {
		const { commandCount, eventCount } = loadAll(registry);
		state.commandCount = commandCount;
		state.eventCount = eventCount;
	}

	function startServer() {
		let login, mode;
		try {
			({ login, mode } = resolveLogin(config));
		}
		catch (error) {
			return Promise.reject(error);
		}

		return new Promise((resolve, reject) => {
			const finish = async (error, api) => {
				if (error) return reject(error);
				try { require("./mediaShim").install(api); } catch (e) { log.warn("MEDIA", `shim failed: ${e.message}`); }
				try { require("./igUnsend").install(api); } catch (e) { log.warn("UNSEND", `unsend compat failed: ${e.message}`); }
				try { require("./autoTyping").install(api, config); } catch (_) { /* cosmetic */ }
				state.api = api;
				state.botID = api.getCurrentUserID();
				dispatcher = createDispatcher({ api, config, registry, database });
				goatCompat.bind({ api, dispatcher });
				for (const script of registry.commands.values()) goatCompat.runOnLoad(script);

				try {
					const info = await api.getUserInfo(state.botID);
					const profile = info && info[state.botID];
					log.success("LOGIN", `Logged in as ${state.botID}${profile && profile.vanity ? ` (@${profile.vanity})` : ""}`);
				}
				catch (_) {
					log.success("LOGIN", `Logged in as ${state.botID}`);
				}

				startListening();
				onlineStatus.start();
				resolve(api);
			};

			if (mode === "server") {
				const options = {
					server: config.server.url,
					token: config.server.token,
					botId: config.server.botId,
					timeout: Number(config.server.timeout) || 60000,
					selfListen: config.selfListen === true,
					// Hand the server our cookies (account.txt / IG_COOKIES) so the
					// bot can own them instead of the server. Re-read on every
					// attempt so a repaste is picked up on reconnect.
					cookies: loadServerCookies()
				};
				log.info("LOGIN", `Connecting to ig-chat-api server at ${options.server} as "${options.botId || "default"}"${options.selfListen ? " (selfListen on)" : ""}`);
				Promise.resolve(login(options)).then(api => finish(null, api), finish);
				return;
			}

			login({ appState: loadAccount() }, buildOptions(), finish);
		});
	}

	function buildOptions() {
		const options = {
			listenEvents: config.listenEvents,
			selfListen: config.selfListen,
			autoMarkRead: config.autoMarkRead,
			autoMarkDelivery: config.autoMarkDelivery,
			autoReconnect: config.autoReconnect,
			logLevel: "silent"
		};
		// Extra ig-chat-api options (minRequestInterval, keepAliveInterval, ...), as in Insta-Bot3.
		const extra = config.optionsFca && typeof config.optionsFca === "object" ? config.optionsFca : {};
		for (const [key, value] of Object.entries(extra))
			if (key !== "notes" && key !== "logLevel" && value !== null && value !== undefined) options[key] = value;
		if (config.account && config.account.proxy) options.proxy = config.account.proxy;
		if (config.account && config.account.userAgent) options.userAgent = config.account.userAgent;
		return options;
	}

	function handleListenerEvent(error, rawEvent) {
		if (error) return handleListenerError(error);
		// Internal notices from the server bridge (never user events).
		if (rawEvent && rawEvent.__internal) {
			if (rawEvent.__internal === "relogin") {
				log.warn("LISTEN", "Server is re-logging in; waiting for the stream to resume");
				onlineStatus.writeLine({ event: "relogin", reason: rawEvent.reason || null });
			}
			else if (rawEvent.__internal === "error") {
				handleListenerError(rawEvent.error || { message: "server error" });
			}
			return;
		}
		const event = normalizeEvent(rawEvent);
		if (!event || event.type === "ready") return;

		state.messagesHandled++;

		if (shouldLog(event.type)) {
			const shown = Object.assign({}, event);
			if (Array.isArray(shown.participantIDs)) shown.participantIDs = `Array(${shown.participantIDs.length})`;
			log.info(String(event.type).toUpperCase(), JSON.stringify(shown));
		}

		Promise.resolve(dispatcher.handle(event)).catch(err => log.error("DISPATCH", "Unhandled error", err));
	}

	function shouldLog(type) {
		const settings = config.logEvents || {};
		if (settings.disableAll === true) return false;
		return settings[type] === true;
	}

	function handleListenerError(error) {
		const message = String(error && (error.error || error.message) || error);
		if (/connection closed|closed by user/i.test(message)) return;
		onlineStatus.writeLine({ event: "listener_error", error: message });
		if (/not logged in|login_required|logged.?out/i.test(message)) {
			log.error("LISTEN", "Session is no longer valid. Re-reading account.txt…", message);
			scheduleRelogin();
		}
		else {
			log.error("LISTEN", "Listener error", message);
		}
	}

	function startListening() {
		state.listenerGeneration++;
		const generation = state.listenerGeneration;
		// Retire the previous listener (and any scheduled restart) so we never
		// stack MQTT clients; overlapping listeners leak sockets over time.
		if (state.retireListener) clearTimeout(state.retireListener);
		try {
			if (typeof state.stopListening === "function") state.stopListening();
		}
		catch (_) { /* ignore */ }
		state.stopListening = state.api.listenMqtt((error, event) => {
			if (generation !== state.listenerGeneration) return;
			handleListenerEvent(error, event);
		});
		state.listening = true;
		log.success("LISTEN", "Realtime listener started");

		if (state.restartTimer) clearInterval(state.restartTimer);
		const interval = Number(config.restartListenInterval) || 0;
		if (interval > 0) {
			state.restartTimer = setInterval(() => restartListening(), interval);
			if (state.restartTimer.unref) state.restartTimer.unref();
		}
	}

	function restartListening() {
		try {
			if (typeof state.stopListening === "function") state.stopListening();
		}
		catch (_) { /* ignore */ }
		if (state.retireListener) clearTimeout(state.retireListener);
		state.retireListener = setTimeout(() => { state.retireListener = null; startListening(); }, 3000);
		if (state.retireListener.unref) state.retireListener.unref();
		log.info("LISTEN", "Listener restarted");
	}

	function scheduleRelogin() {
		if (state.retireListener) return;
		state.retireListener = setTimeout(() => {
			state.retireListener = null;
			log.info("LOGIN", "Reconnecting the realtime listener");
			startListening();
		}, 5000);
		if (state.retireListener.unref) state.retireListener.unref();
	}

	async function start() {
		log.master("BOOT", `${config.botName} starting…`);
		// Load commands/events once, before connecting. Re-running this on every
		// retry would duplicate entries and drop the count to zero.
		// Pull saved users/threads (and command data files) from GitHub first,
		// so commands that read their files at load time see the saved data.
		try { await database.init(); }
		catch (error) { log.warn("GITHUB", `storage init failed, continuing with local data: ${error.message}`); }
		loadCommands();
		// Retry the initial connection instead of exiting: the server may not have
		// cookies yet (or may be cold-starting on a free tier). A fatal exit here
		// would fail the deploy and also stop the bot from recovering on its own.
		let attempt = 0;
		for (;;) {
			if (state.stopping) return;
			try {
				await startServer();
				break;
			}
			catch (error) {
				attempt++;
				const message = String(error && (error.error || error.message) || error);
				const delay = Math.min(60000, 5000 * attempt);
				onlineStatus.writeLine({ event: "boot_retry", attempt, error: message });
				log.warn("BOOT", `Could not connect (attempt ${attempt}): ${message}. Retrying in ${Math.round(delay / 1000)}s…`);
				// Keep the process alive so the host does not mark the deploy failed
				// and so a later cookie/server fix is picked up without a redeploy.
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
		if (state.stopping) return;
		state.running = true;
		log.success("BOOT", `${config.botName} is online. Type ${config.prefix}help in a chat.`);
	}

	async function stop() {
		state.running = false;
		state.stopping = true;
		onlineStatus.writeLine({ event: "stopping" });
		try {
			if (typeof state.stopListening === "function") state.stopListening();
		}
		catch (_) { /* ignore */ }
		// Cancel BOTH timers: the periodic restart interval AND a one-shot
		// listener retire/relogin timeout. Without clearing the latter, a callback
		// could recreate the listener after stop().
		if (state.restartTimer) { clearInterval(state.restartTimer); state.restartTimer = null; }
		if (state.retireListener) { clearTimeout(state.retireListener); state.retireListener = null; }
		try { await database.flushRemote(); }
		catch (error) { log.warn("GITHUB", `final save failed: ${error.message}`); }
		// Deliberately DO NOT call api.logout() on shutdown.
		//
		// In server mode this RPCs Instagram's /accounts/logout/, which invalidates
		// the sessionid server-side and permanently kills the cookies. A platform
		// sends SIGTERM on every redeploy, so logging out on exit means every
		// deploy logs the account out. Dropping the in-memory handle is enough;
		// the cookie stays valid for the next boot.
		log.master("BOOT", `${config.botName} stopped`);
	}

	return { start, stop, state, database, registry, normalizeEvent };
}

module.exports = { createBot, normalizeEvent };
