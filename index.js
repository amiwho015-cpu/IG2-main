"use strict";

/**
 * InstaBOT — a modular Instagram Direct chat bot.
 *
 * Author: Saifullah Al Neoaz (https://github.com/lazyneoaz)
 * GitHub: https://github.com/lazyneoaz
 * License: MIT
 *
 * Usage:
 *   1. npm install
 *   2. put your Instagram cookies in account.txt
 *   3. npm start
 */

const log = require("./src/logger");
const { loadConfig } = require("./src/config");
const { createBot } = require("./src/bot");
const { createStatusServer } = require("./src/statusServer");

const BANNER = [
	" ___           _        ____   ___ _____",
	"|_ _|_ __  ___| |_ __ _| __ ) / _ \\_   _|",
	" | || '_ \\/ __| __/ _` |  _ \\| | | || |",
	" | || | | \\__ \\ || (_| | |_) | |_| || |",
	"|___|_| |_|___/\\__\\__,_|____/ \\___/ |_|"
];

function printBanner() {
	const version = require("./package.json").version;
	const author = "by Saifullah Al Neoaz — https://github.com/lazyneoaz";
	log.plain("");
	for (const line of BANNER) log.plain(log.paint("magenta", line));
	log.plain(log.paint("dim", ` ${author}  ·  v${version}`));
	log.plain("");
}

async function main() {
	printBanner();

	let config;
	try {
		config = loadConfig();
	}
	catch (error) {
		log.error("CONFIG", error.message);
		process.exit(1);
	}

	const bot = createBot(config);

	// A host like Render scans for an open port and marks a service that binds
	// none as unhealthy. This tiny server satisfies that check and serves
	// /health. Set PORT=0 to disable it (pure worker mode).
	const statusServer = createStatusServer({
		info: () => ({
			bot: config.botName,
			botId: config.server && config.server.botId ? config.server.botId : "default",
			online: bot.state.running === true,
			userID: bot.state.botID || null,
			commands: bot.state.commandCount,
			events: bot.state.eventCount
		})
	});

	const shutdown = async (signal) => {
		log.warn("SYSTEM", `Received ${signal}; shutting down…`);
		await statusServer.stop();
		await bot.stop();
		process.exit(0);
	};
	process.once("SIGINT", () => shutdown("SIGINT"));
	process.once("SIGTERM", () => shutdown("SIGTERM"));

	process.on("unhandledRejection", (reason) => log.error("PROCESS", "Unhandled promise rejection", reason));
	process.on("uncaughtException", (error) => log.error("PROCESS", "Uncaught exception", error));

	try {
		await statusServer.start();
	}
	catch (error) {
		log.error("HTTP", "Could not start the status server", error);
	}

	try {
		await bot.start();
	}
	catch (error) {
		// start() already retries; this is only a last-resort guard. Keep the
		// process alive so the host does not fail the deploy and a later fix is
		// picked up without a redeploy.
		log.error("BOOT", "Failed to start (will keep the process alive)", error);
		await new Promise(() => { });
	}
}

main();
