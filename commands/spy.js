"use strict";

/**
 * spy — Instagram user info (InstaBOT version)
 * Uses the bot's own logged-in session (api.getUserInfo + account.txt cookies),
 * so it does NOT need a separate IG_SESSIONID.
 * Put this file in /commands/spy.js (replace the old one).
 */

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { bestPicture } = require("../src/hdpic");
const { resolveProfile, resolveUserTarget, isRateLimitError } = require("../src/utils");

const IG_APP_ID = "936619743392459";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const MOBILE_UA = "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229237)";

// Cookies the bot runs with: IG_COOKIES (env var) wins, else account.txt — the
// same order the bot uses to log in. Read on every call, never cached at load.
function botCookies() {
	try {
		const cfg = require("../src/config");
		const env = process.env.IG_COOKIES && process.env.IG_COOKIES.trim();
		if (env) {
			if (env.startsWith("[") || env.startsWith("{")) {
				let parsed = JSON.parse(env);
				if (!Array.isArray(parsed)) {
					const obj = parsed.cookies || parsed.appState || parsed;
					parsed = Array.isArray(obj) ? obj : Object.keys(obj).map(key => ({ key, value: obj[key] }));
				}
				return cfg.normalizeCookies(parsed);
			}
			return cfg.isNetScapeCookie(env) ? cfg.netScapeToCookies(env) : cfg.cookieHeaderToCookies(env);
		}
		return cfg.loadAccount();
	}
	catch (_) {
		return [];
	}
}

function botCookieHeader() {
	const keep = ["sessionid", "ds_user_id", "csrftoken", "mid", "ig_did", "ig_nrcb", "datr"];
	return botCookies().filter(c => keep.includes(c.key)).map(c => `${c.key}=${c.value}`).join("; ");
}

function cookieValue(name) {
	const hit = botCookies().find(c => c.key === name);
	return hit ? hit.value : "";
}

const diag = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Instagram rate-limits quickly from a datacenter IP. Space calls out, and once
// it answers 429 stop calling for a few minutes instead of making it worse.
let blockedUntil = 0;
let lastCall = 0;
async function getJSON(url, headers, key) {
	if (Date.now() < blockedUntil) { if (key) diag[key] = "cooldown"; return null; }
	const wait = lastCall + 1500 - Date.now();
	if (wait > 0) await sleep(wait);
	lastCall = Date.now();
	try {
		const res = await axios.get(url, { headers, timeout: 15000 });
		if (key) diag[key] = "ok";
		return res.data;
	}
	catch (error) {
		const status = error.response && error.response.status;
		if (status === 429) blockedUntil = Date.now() + 5 * 60 * 1000;
		if (key) diag[key] = status || error.code || "error";
		return null;
	}
}

// Disk cache: a good HD picture + the extra fields are kept per user, so asking
// about the same person again never touches Instagram's API (and never 429s).
const CACHE_DIR = path.join(__dirname, "..", "data", "spy-cache");
const CACHE_TTL = 12 * 60 * 60 * 1000;
function readCache(id) {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${id}.json`), "utf8"));
		const buffer = fs.readFileSync(path.join(CACHE_DIR, `${id}.${meta.ext}`));
		return Object.assign(meta, { buffer });
	}
	catch (_) { return null; }
}
function writeCache(id, meta, buffer) {
	try {
		fs.mkdirSync(CACHE_DIR, { recursive: true });
		fs.writeFileSync(path.join(CACHE_DIR, `${id}.${meta.ext}`), buffer);
		fs.writeFileSync(path.join(CACHE_DIR, `${id}.json`), JSON.stringify(meta));
	}
	catch (_) { /* cache is optional */ }
}

const yn = v => (v ? "Yes" : "No");
const num = v => (v == null ? "N/A" : String(v));
const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== "");

module.exports = {
	config: {
		name: "spy",
		aliases: ["iginfo", "stalk"],
		author: "CRX Shihab",
		category: "info",
		cooldown: 8,
		role: 0,
		description: { en: "Detailed Instagram user info + HD profile picture" },
		usage: { en: "{p}spy [userID | @handle | username | profile URL] — or reply to a message" }
	},

	onStart: async function ({ message, args, event, api }) {
		const target = await resolveUserTarget(args, event, api);
		if (!target.id) {
			if (target.rateLimited) return message.reply("⏳ Instagram rate-limit korse. Kichukkhon pore try koro.");
			if (target.username) return message.reply(`❌ @${target.username} paoa jay nai.`);
			return message.reply("⚠️ Username, user ID dao ba kono message e reply koro.\nExample: spy tanvir143.ig.robot");
		}

		const profile = await resolveProfile(args, event, api);
		if (!profile) return message.reply(`❌ User ${target.id} paoa jay nai.`);
		if (profile.rateLimited && !profile.username && !profile.name)
			return message.reply("⏳ Instagram rate-limit korse. Kichukkhon pore try koro.");

		const userID = String(profile.userID || target.id);

		// Extra details (best effort, all optional)
		for (const k of Object.keys(diag)) delete diag[k];
		const COOKIE = botCookieHeader();
		const webHeaders = Object.assign({ "User-Agent": UA, "X-IG-App-ID": IG_APP_ID, Accept: "*/*" }, COOKIE ? { Cookie: COOKIE, "X-CSRFToken": cookieValue("csrftoken") } : {});
		const mobileHeaders = Object.assign({ "User-Agent": MOBILE_UA, "X-IG-App-ID": IG_APP_ID, Accept: "*/*" }, COOKIE ? { Cookie: COOKIE } : {});
		diag.cookies = COOKIE.includes("sessionid=") ? "found" : "missing";

		const cached = readCache(userID);
		const fresh = !!(cached && Date.now() - cached.at < CACHE_TTL);
		let web = null, pu = null, ex;
		if (fresh) {
			ex = cached.extra || {};
			diag.source = "cache";
		}
		else {
			// Private info carries the real HD picture. Mobile endpoint first, then the
			// web one (skipped after a 429). Both need the bot's own cookies.
			let priv = null;
			if (COOKIE) {
				priv = await getJSON(`https://i.instagram.com/api/v1/users/${userID}/info/`, mobileHeaders, "private");
				if ((!priv || !priv.user) && diag.private !== 429)
					priv = await getJSON(`https://www.instagram.com/api/v1/users/${userID}/info/`, webHeaders, "private-web");
			}
			pu = priv && priv.user;
			// Public web info is only a fallback when the private call gave nothing.
			if (!pu && profile.username) {
				const d = await getJSON(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(profile.username)}`, webHeaders, "web");
				const u = d && d.data && d.data.user;
				if (u && String(u.id) === userID) web = u;
			}
			const fr = (pu && COOKIE) ? await getJSON(`https://i.instagram.com/api/v1/friendships/show/${userID}/`, mobileHeaders, "friendship") : null;

			let friendship;
			if (fr) {
				if (fr.following && fr.followed_by) friendship = "Mutual";
				else if (fr.following) friendship = "Following";
				else if (fr.followed_by) friendship = "Follows you";
				else if (fr.outgoing_request) friendship = "Request sent";
				else friendship = "Not following";
			}
			ex = {
				business: web ? web.is_business_account : (pu ? pu.is_business : undefined),
				fbid: pick(web && web.fbid, pu && pu.fbid_v2, pu && pu.fbid),
				interop: pick(pu && pu.interop_messaging_user_fbid),
				strong: pick(pu && pu.strong_id__),
				friendship
			};
			// Blocked / empty answer: reuse whatever we stored last time.
			if (!pu && !web && cached && cached.extra) ex = cached.extra;
		}
		const friendship = ex.friendship || "N/A";

		const name = pick(profile.name, web && web.full_name, pu && pu.full_name) || "None";
		const username = pick(profile.username, web && web.username, pu && pu.username) || "None";
		const bio = String(pick(profile.biography, web && web.biography, pu && pu.biography) || "None").replace(/\n/g, " ");
		const business = ex.business;
		const fbid = ex.fbid;
		const interop = ex.interop;
		const strong = pick(ex.strong, userID);

		const body =
`╭─ 👤 INSTAGRAM INFO ─
│ Username: ${username}
│ Name: ${name}
│ First name: ${String(name).split(" ")[0]}
│ User ID: ${userID}
│ Followers: ${num(pick(profile.followers, web && web.edge_followed_by && web.edge_followed_by.count))}
│ Following: ${num(pick(profile.following, web && web.edge_follow && web.edge_follow.count))}
│ Private: ${yn(profile.isPrivate)}
│ Verified: ${yn(profile.isVerified)}
│ Business: ${business === undefined ? "N/A" : yn(business)}
│ Friendship: ${friendship}
│ Biography: ${bio}
│ fbid: ${num(fbid)}
│ Interop fbid: ${num(interop)}
│ Strong ID: ${strong}
╰──────────────────`;

		let best = null;
		const candidates = [];
		if (fresh && cached.width >= 500) {
			best = { buffer: cached.buffer, width: cached.width, height: cached.height, ext: cached.ext };
		}
		else {
			// Collect every picture URL we know of, then keep the sharpest one.
			const versions = (pu && Array.isArray(pu.hd_profile_pic_versions)) ? pu.hd_profile_pic_versions : [];
			candidates.push(
				pu && pu.hd_profile_pic_url_info && pu.hd_profile_pic_url_info.url,
				...versions.slice().sort((a, b) => (b.width || 0) - (a.width || 0)).map(v => v && v.url),
				web && web.profile_pic_url_hd,
				profile.profilePicture
			);
			best = await bestPicture(candidates);
			if (best && best.width >= 500) {
				writeCache(userID, { at: Date.now(), ext: best.ext, width: best.width, height: best.height, extra: ex }, best.buffer);
			}
			else if (cached && cached.width >= 500) {
				// Instagram only gave a thumbnail (blocked): an older HD copy is better.
				best = { buffer: cached.buffer, width: cached.width, height: cached.height, ext: cached.ext };
				diag.source = "old cache";
			}
		}
		if (best) {
			const quality = best.width ? `${best.width}x${best.height}` : "unknown size";
			const low = best.width && best.width < 500;
			const note = low
				? `\n⚠️ Instagram only gave ${quality}. cookies: ${diag.cookies}, private API: ${diag.private || "skipped"}${diag["private-web"] ? "/" + diag["private-web"] : ""}, web: ${diag.web || "skipped"}. Try again in a few minutes.`
				: `\n🖼️ HD picture (${quality})`;
			return message.reply({ body: body + note, attachment: { buffer: best.buffer, fileName: `profile_hd.${best.ext}` }, textFirst: true });
		}
		const pic = pick(candidates.find(Boolean));
		if (pic) return message.reply({ body, attachment: pic, textFirst: true });
		return message.reply(body);
	}
};
                                   
