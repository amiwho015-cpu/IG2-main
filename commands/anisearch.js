const axios = require("axios");

const API_CONFIG_URL = "https://raw.githubusercontent.com/goatbotnx/xalmanx210/refs/heads/main/apis.json";
const API_KEY = "xalman-hub";
const DEFAULT_HUB = "https://xalman-apis.vercel.app"; // used if apis.json can't be loaded
const MAX_BYTES = Math.max(256 * 1024, Number(process.env.IG_MAX_MEDIA_BYTES) || 40 * 1024 * 1024);
const MAX_ATTEMPTS = 4;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let apiBaseUrl = null;
let apiConfigRequest = null;

async function getApiBaseUrl() {
  if (apiBaseUrl) return apiBaseUrl;

  if (!apiConfigRequest) {
    apiConfigRequest = axios
      .get(API_CONFIG_URL, { timeout: 15000 })
      .then(({ data }) => {
        const baseUrl = data?.[API_KEY];
        if (typeof baseUrl === "string" && baseUrl.trim()) {
          apiBaseUrl = baseUrl.trim().replace(/\/+$/, "");
        }
      })
      .catch(() => { /* fall back below */ })
      .then(() => {
        if (!apiBaseUrl) apiBaseUrl = DEFAULT_HUB;
        return apiBaseUrl;
      })
      .finally(() => {
        apiConfigRequest = null;
      });
  }

  return apiConfigRequest;
}

async function searchVideos(query) {
  const base = await getApiBaseUrl();
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(`${base}/api/anisearch`, {
        params: { q: query },
        timeout: 20000,
        headers: { "User-Agent": UA }
      });
      const results = (res.data && res.data.results) || [];
      return results.map(r => r && r.video_url).filter(Boolean);
    } catch (e) {
      lastError = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

// Download the clip and give it an .mp4 name so Instagram sends it as a VIDEO.
async function getVideo(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 60000,
    maxContentLength: MAX_BYTES,
    maxBodyLength: MAX_BYTES,
    headers: { "User-Agent": UA, "Referer": "https://www.tiktok.com/" }
  });
  const buffer = Buffer.from(res.data);
  if (!buffer.length) throw new Error("empty video");
  return { buffer, fileName: "anisearch.mp4" };
}

module.exports = {
  config: {
    name: "anisearch",
    aliases: ["amv", "animesearch"],
    version: "2.1",
    author: "xalman",
    countDown: 3,
    role: 0,
    description: "Search and get Anime TikTok videos",
    category: "ANIME",
    guide: "{pn} <anime name>"
  },

  onStart: async function ({ api, event, message, args }) {
    const { messageID } = event;
    const react = emoji => Promise.resolve(api.setMessageReaction(emoji, messageID)).catch(() => {});

    const query = args.join(" ").trim();
    if (!query) return message.reply("❌ Please provide an anime name to search.");

    await react("⏳");

    let urls;
    try {
      urls = await searchVideos(query);
    } catch (e) {
      console.log("[anisearch] search failed:", e && (e.message || e));
      await react("❌");
      return message.reply("❌ Error fetching video. Please try again.");
    }

    if (!urls.length) {
      await react("❌");
      return message.reply(`❌ No videos found for "${query}".`);
    }

    // random order, then try a few until one downloads
    for (let i = urls.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [urls[i], urls[j]] = [urls[j], urls[i]];
    }

    let lastError;
    for (const url of urls.slice(0, MAX_ATTEMPTS)) {
      try {
        const video = await getVideo(url);
        await message.reply("🎬 𝗔𝗡𝗜𝗠𝗘 𝗦𝗘𝗔𝗥𝗖𝗛 𝗥𝗘𝗦𝗨𝗟𝗧\n━━━━━━━━━━━━━━━━━━");
        await message.reply({ attachment: video });
        await react("✅");
        return;
      } catch (e) {
        lastError = e;
      }
    }

    console.log("[anisearch] all attempts failed:", lastError && (lastError.message || lastError));
    await react("❌");
    return message.reply("❌ Error fetching video. Please try again.");
  }
};
