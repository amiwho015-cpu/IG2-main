"use strict";

const { resolveGender } = require("../src/gender");
const { resolveUserTarget } = require("../src/utils");

const LABEL = { 1: "👦 boy", 2: "👧 girl", 0: "❓ unknown" };
const MAX_TAGS = 20;

// words that mean boy / girl (English, Banglish, Bangla)
const BOY_WORDS = new Set(["boy", "male", "m", "chele", "chhele", "cheler", "ছেলে"]);
const GIRL_WORDS = new Set(["girl", "female", "f", "meye", "meyey", "মেয়ে"]);

function wordValue(word) {
	const w = String(word || "").toLowerCase().replace(/[:,;]+$/, "");
	if (BOY_WORDS.has(w)) return 1;
	if (GIRL_WORDS.has(w)) return 2;
	return null;
}

module.exports = {
	config: {
		name: "gender",
		aliases: ["setgender"],
		version: "2.0",
		author: "CRX Shihab",
		countDown: 3,
		role: 0,
		shortDescription: { en: "Set gender (by @tag) so pair matches boy with girl" },
		category: "love",
		guide: {
			en:
				"{pn} boy | girl — set your own\n" +
				"{pn} girl @a @b — set tagged people as girls (group admin)\n" +
				"{pn} boy @c @d — set tagged people as boys (group admin)\n" +
				"{pn} boy @c @d girl @a @b — boys and girls in ONE message (group admin)\n" +
				"{pn} boy | girl (reply to someone) — set theirs (group admin)\n" +
				"{pn} scan — list members and who is still unknown (group admin)"
		}
	},

	onStart: async function ({ args, event, message, api, usersData, role }) {
		const sub = String(args[0] || "").toLowerCase();

		/* ---------------------------------------------------------- scan */
		if (sub === "scan") {
			if (role < 1) return message.reply("Only group admins can scan the group.");
			const info = await api.getThreadInfo(event.threadID);
			const rows = [];
			for (const id of (info.participantIDs || []).slice(0, 80)) {
				const g = await resolveGender(usersData, id);
				rows.push(`${LABEL[g.gender]}  ${g.name || id}${g.manual ? " ✔" : ""}`);
			}
			return message.reply(`Members (✔ = set by hand)\n${rows.join("\n")}\n\nFix several at once: gender boy @a @b girl @c @d`);
		}

		/* ------------------------------------- parse "boy @a @b girl @c" */
		const groups = []; // { value, handles[] }
		let current = null;
		for (const raw of args) {
			const value = wordValue(raw);
			if (value) { current = { value, handles: [] }; groups.push(current); continue; }
			if (!current) continue;
			const token = String(raw).replace(/[,;]+$/, "");
			if (/^@?[A-Za-z0-9._]{2,30}$/.test(token) && (token.startsWith("@") || /^\d{6,}$/.test(token)))
				current.handles.push(token);
		}

		const tagged = groups.reduce((n, g) => n + g.handles.length, 0);

		// Real mention map from the platform (if it ever arrives) with a single boy/girl word
		const mentionIDs = Object.keys(event.mentions || {});
		if (!tagged && mentionIDs.length && groups.length === 1) {
			groups[0].ids = mentionIDs.map(String);
		}

		const hasTargets = tagged > 0 || groups.some(g => g.ids && g.ids.length);

		/* --------------------------------------- no tags: self / reply */
		if (!hasTargets) {
			const value = groups.length ? groups[0].value : null;
			if (!value) return message.reply("Usage:\ngender boy | girl\ngender girl @a @b\ngender boy @c girl @d\ngender scan");

			const replyTo = event.messageReply && event.messageReply.senderID;
			const target = replyTo && String(replyTo) !== String(event.senderID) ? String(replyTo) : String(event.senderID);
			if (target !== String(event.senderID) && role < 1)
				return message.reply("Only group admins can set someone else's gender.");

			await usersData.set(target, value, "gender");
			const name = await usersData.getName(target);
			return message.reply(`✅ ${name} is now set as ${LABEL[value]}.`);
		}

		/* --------------------------------------------- tagged: admin only */
		if (role < 1) return message.reply("Only group admins can set other people's gender by tag.");
		if (tagged > MAX_TAGS) return message.reply(`Too many tags (max ${MAX_TAGS} at once).`);

		const done = [];
		const failed = [];
		const seen = new Set();
		const handleOf = new Map();
		const cleanEvent = Object.assign({}, event, { messageReply: null });

		// Match @username against the people IN THIS GROUP first (no Instagram lookup needed,
		// so it works even when Instagram refuses profile searches from the server).
		let memberMap = null;
		const getMemberMap = async () => {
			if (memberMap) return memberMap;
			memberMap = new Map();
			try {
				const info = await api.getThreadInfo(event.threadID);
				const all = ((info && info.participantIDs) || []).map(String).slice(0, 100);
				for (let i = 0; i < all.length; i += 8) {
					await Promise.all(all.slice(i, i + 8).map(async uid => {
						try {
							const rec = await usersData.get(uid);
							const u = rec && rec.username;
							if (u) memberMap.set(String(u).replace(/^@/, "").toLowerCase(), uid);
						}
						catch (_) { /* skip this member */ }
					}));
				}
			}
			catch (_) { /* fall back to Instagram lookup */ }
			return memberMap;
		};

		for (const group of groups) {
			const ids = (group.ids || []).slice();
			for (const handle of group.handles) {
				try {
					const wantedName = String(handle).replace(/^@/, "").toLowerCase();
					if (!/^\d+$/.test(wantedName)) {
						const inGroup = (await getMemberMap()).get(wantedName);
						if (inGroup) {
							ids.push(inGroup);
							handleOf.set(inGroup, handle);
							continue;
						}
					}
					const found = await resolveUserTarget([handle], cleanEvent, api);
					if (found && found.id) {
						// Safety: make sure Instagram really gave us the account that was tagged,
						// never silently set somebody else (e.g. the sender).
						const asked = String(handle).replace(/^@/, "").toLowerCase();
						const p = found.profile || {};
						const got = String(p.vanity || p.username || "").toLowerCase();
						if (got && !/^\d+$/.test(asked) && got !== asked) {
							failed.push(`${handle} (Instagram returned @${got} instead)`);
							continue;
						}
						ids.push(String(found.id));
						handleOf.set(String(found.id), handle);
					}
					else failed.push(handle + (found && found.rateLimited ? " (Instagram busy, try again)" : " (not in this group, check the username spelling)"));
				}
				catch (_) { failed.push(handle); }
			}
			for (const id of ids) {
				if (seen.has(id)) continue;
				seen.add(id);
				try {
					await usersData.set(id, group.value, "gender");
					const name = await usersData.getName(id);
					done.push(`${LABEL[group.value]}  ${name}${handleOf.get(id) ? " (" + handleOf.get(id) + ")" : ""}`);
				}
				catch (_) { failed.push(id); }
			}
		}

		let text = done.length ? `✅ Gender saved (${done.length})\n${done.join("\n")}` : "❌ Nobody could be set.";
		if (failed.length) text += `\n\n⚠️ Could not find: ${failed.join(", ")}`;
		return message.reply(text);
	}
};
