"use strict";

/**
 * Shows the typing indicator for a moment before the bot sends anything.
 * Toggle / tune with config.typingIndicator { enable, duration } (see `typingindicator` command).
 * Wraps sendMessage (and the media senders that do not already go through it).
 */

const log = require("./logger");

function install(api, config) {
	if (!api || typeof api.sendTypingIndicator !== "function" || api.sendTypingIndicator._noop) return api;

	const wrap = original => function (...args) {
		const settings = config.typingIndicator || {};
		const threadID = args[1];
		if (settings.enable === false || threadID == null) return original.apply(this, args);

		let stop = null;
		try {
			const result = api.sendTypingIndicator(threadID, () => { });
			if (typeof result === "function") stop = result;
		}
		catch (_) { /* cosmetic */ }

		const duration = Number(settings.duration) > 0 ? Number(settings.duration) : 1000;
		const hasCallback = args.some(a => typeof a === "function");
		const run = new Promise(resolve => setTimeout(resolve, duration)).then(() => {
			try { if (stop) stop(); } catch (_) { /* ignore */ }
			return original.apply(this, args);
		});
		if (hasCallback) run.catch(() => { });
		return run;
	};

	for (const name of ["sendMessage", "sendImage", "sendVideo", "sendAudio"]) {
		// Shim media senders already go through sendMessage; wrapping twice would delay twice.
		if (typeof api[name] === "function" && !api[name]._shim) api[name] = wrap(api[name]);
	}
	log.info("TYPING", "Typing indicator enabled");
	return api;
}

module.exports = { install };
