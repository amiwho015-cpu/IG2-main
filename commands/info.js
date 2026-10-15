const { findUid, getStreamFromURL } = global.utils;

module.exports = {
	config: {
		name: "info",
		version: "1.0",
		author: "Neoaz 🐊",
		countDown: 5,
		role: 0,
		description: {
			en: "View all Instagram information of a user"
		},
		category: "info",
		guide: {
			en: "   {pn}: view your own Instagram information"
				+ "\n   {pn} @tag: view Instagram information of tagged people"
				+ "\n   {pn} <username|profile link>: view Instagram information of a username or profile link"
				+ "\n   Reply to someone's message with the command to view their Instagram information"
		}
	},

	langs: {
		en: {
			notFound: "❌ Could not find Instagram information for this user",
			error: "❌ An error occurred while fetching information: %1"
		}
	},

	onStart: async function ({ api, message, event, args, getLang }) {
		const targets = [];
		if (event.messageReply)
			targets.push({ id: event.messageReply.senderID });
		else if (!args[0])
			targets.push({ id: event.senderID });
		else {
			const { mentions } = event;
			if (mentions && Object.keys(mentions).length) {
				for (const id of Object.keys(mentions))
					targets.push({ id, label: String(mentions[id] || "").replace(/^@/, "") });
			}
			else {
				for (const arg of args) {
					try {
						targets.push({ id: await findUid(arg), label: arg });
					}
					catch (e) {
						targets.push({ error: e.message || String(e), label: arg });
					}
				}
			}
		}

		const ids = targets.filter(t => t.id).map(t => t.id);
		let infoMap = {};
		if (ids.length) {
			try {
				infoMap = await api.getUserInfo(ids) || {};
			}
			catch (e) {
				return message.reply(getLang("error", e.error || e.message || String(e)));
			}
		}

		const blocks = [];
		let firstPic = null;
		for (const t of targets) {
			if (t.error)
				blocks.push(`⚠️ ${t.label}: ${t.error}`);
			else if (!infoMap[t.id])
				blocks.push(getLang("notFound") + (t.label ? ` (${t.label})` : ""));
			else {
				const u = infoMap[t.id];
				if (!firstPic && u.thumbSrc) firstPic = u.thumbSrc;
				blocks.push(formatBlock(u));
			}
		}
		const body = blocks.join("\n\n") || getLang("notFound");
		if (!firstPic)
			return message.reply(body);
		try {
			const stream = await getStreamFromURL(firstPic);
			return message.reply({ body, attachment: stream });
		}
		catch (e) {
			return message.reply(body);
		}
	}
};

function formatBlock(u) {
	const raw = u.raw || {};
	const line = (k, v) => v === undefined || v === null || v === "" || v === false ? null : `│ ${k}: ${v}`;
	const bool = (v) => v ? "Yes" : "No";
	const lines = [
		"╭─ 👤 INSTAGRAM INFO ─",
		line("Username", u.username),
		line("Name", u.name),
		line("First name", u.firstName),
		line("User ID", u.id),
		line("Followers", u.followerCount),
		line("Following", u.followingCount),
		line("Posts", u.mediaCount),
		line("Private", bool(u.isPrivate)),
		line("Verified", bool(u.isVerified)),
		line("Business", bool(u.isBusiness)),
		line("Category", raw.category_name || raw.category),
		line("Friendship", u.isFriend ? "Following" : "Not following"),
		line("Biography", String(u.biography || "").replace(/\n/g, " ").trim()),
		line("External URL", u.externalUrl),
		line("fbid", raw.fbid_v2 || raw.fbid),
		line("Interop fbid", raw.interop_messaging_user_fbid),
		line("Strong ID", raw.strong_id__),
		"╰─────────────────────"
	];
	return lines.filter(Boolean).join("\n");
}
