"use strict";

const TEXT_EFFECTS = ["love", "gift", "celebration", "fire"];

function cleanCategoryName(text) {
	if (!text) return "others";
	return String(text)
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase() || "others";
}

function randomTextEffect() {
	return TEXT_EFFECTS[Math.floor(Math.random() * TEXT_EFFECTS.length)];
}

module.exports = {
	config: {
		name: "help",
		aliases: ["h", "menu", "commands"],
		author: "Neoaz 🐊",
		category: "info",
		cooldown: 3,
		role: 0,
		description: { en: "Show all available commands or details for one" },
		usage: { en: "{p}help [command]" }
	},

	onStart: async function ({ message, args, config, registry }) {
		const prefix = config.prefix;
		const query = (args[0] || "").toLowerCase();

		if (query) {
			const command = registry.resolve(query);
			if (!command) return message.send(`❌ Command "${query}" not found.`);

			const c = command.config;
			const description = (c.description && (c.description[config.language] || c.description.en)) || "—";
			const usage = ((c.usage && (c.usage[config.language] || c.usage.en)) || `${prefix}${c.name}`).replace(/\{p\}/g, prefix);

			let version = "1.0.0";
			try { version = require("../package.json").version; } catch (_) { }

			const body = [
				"☠️ 𝗖𝗢𝗠𝗠𝗔𝗡𝗗 𝗜𝗡𝗙𝗢 ☠️",
				"",
				`➥ Name: ${c.name}`,
				`➥ Category: ${c.category || "Uncategorized"}`,
				`➥ Description: ${description}`,
				`➥ Aliases: ${c.aliases && c.aliases.length ? c.aliases.join(", ") : "None"}`,
				`➥ Usage: ${usage}`,
				`➥ Permission: ${c.role || 0}`,
				`➥ Author: ${c.author || "—"}`,
				`➥ Version: ${version}`
			].join("\n");

			try {
				return await message.send({ body, effect: randomTextEffect() });
			}
			catch (_) {
				return message.send(body);
			}
		}

		const byCategory = { };
		for (const command of registry.commands.values()) {
			if (command.config.hidden) continue;
			const category = cleanCategoryName(command.config.category);
			(byCategory[category] = byCategory[category] || []).push(command.config.name);
		}

		const lines = [`━━━☠️ ${String(config.botName || "InstaBOT").toUpperCase()} ☠️━━━`];
		for (const category of Object.keys(byCategory).sort()) {
			lines.push(`\n╭──『 ${category.toUpperCase()} 』`);
			const names = byCategory[category].sort();
			lines.push(names.map((name, index) => `${index === 0 ? "➥" : " "}× ${prefix}${name}`).join("  "));
			lines.push("╰────────────◊");
		}
		lines.push(`\n➥ Use: ${prefix}help [command] for details`);

		const body = lines.join("\n");
		try {
			return await message.send({ body, effect: randomTextEffect() });
		}
		catch (_) {
			return message.send(body);
		}
	}
};
