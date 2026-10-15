const axios = require("axios");

const API_CONFIG_URL = "https://raw.githubusercontent.com/goatbotnx/xalmanx210/refs/heads/main/apis.json";
const API_KEY = "xalman-hub";
const DEFAULT_HUB = "https://xalman-apis.vercel.app"; // used if apis.json can't be loaded
const MAX_BYTES = Math.max(256 * 1024, Number(process.env.IG_MAX_MEDIA_BYTES) || 40 * 1024 * 1024);
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

// Instagram needs a file name/extension to know a file is a VIDEO (a bare stream
// is sent as a picture). So the video is downloaded and handed over with an .mp4 name.
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
  return { buffer, fileName: "tiktok.mp4" };
}

async function getThumb(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    headers: { "User-Agent": UA }
  });
  return { buffer: Buffer.from(res.data), fileName: "thumb.jpg" };
}

async function searchTikTok(query) {
  const base = await getApiBaseUrl();
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.get(`${base}/api/tik`, {
        params: { q: query },
        timeout: 30000,
        headers: { "User-Agent": UA }
      });
      const results = res.data && res.data.results;
      return Array.isArray(results) ? results.filter(r => r && r.video_url) : [];
    } catch (e) {
      lastError = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

module.exports = {
  config: {
    name: "tiktok",
    aliases: ["tik", "tt"],
    version: "1.3.0",
    author: "CRX Shihab",
    countDown: 10,
    role: 0,
    shortDescription: "Search and download TikTok videos with reply support",
    category: "MEDIA",
    guide: "{pn} [query] or {pn} [query] -list"
  },

  onStart: async function ({ api, event, args, message }) {
    const { messageID } = event;
    const react = emoji => Promise.resolve(api.setMessageReaction(emoji, messageID)).catch(() => {});

    const isList = args.includes("-list");
    const searchQuery = args.filter(arg => arg !== "-list").join(" ").trim();

    if (!searchQuery) {
      return message.reply("╭─❍\n│ Usage: tiktok [query]\n│ List: tiktok [query] -list\n╰───────────⟡");
    }

    await react("🔍");

    let results;
    try {
      results = await searchTikTok(searchQuery);
    } catch (error) {
      console.log("[tiktok] search failed:", error && (error.message || error));
      await react("❌");
      return message.reply("✕ API Error or Timeout!");
    }

    if (!results.length) {
      await react("❌");
      return message.reply("✕ No videos found!");
    }

    try {
      if (isList) {
        const top = results.slice(0, 6);
        let msg = `❖ 𝗧𝗜𝗞𝗧𝗢𝗞 𝗦𝗘𝗔𝗥𝗖𝗛 ❖\n━━━━━━━━━━━━━━━━━━\n`;
        top.forEach((r, i) => {
          msg += `${i + 1}. ${r.title || "No title"}\n👤 Author: ${r.author || "Unknown"}\n\n`;
        });
        msg += `━━━━━━━━━━━━━━━━━━\nReply with the number to download!`;

        // thumbnails are optional: a broken one must never break the list
        const thumbs = (await Promise.all(
          top.map(r => (r.thumbnail ? getThumb(r.thumbnail).catch(() => null) : null))
        )).filter(Boolean);

        const form = thumbs.length ? { body: msg, attachment: thumbs } : msg;
        const info = await message.reply(form);
        await react("📜");

        if (info && info.messageID) {
          global.GoatBot.onReply.set(info.messageID, {
            commandName: this.config.name,
            messageID: info.messageID,
            author: event.senderID,
            results: top
          });
        }
        return;
      }

      // direct mode: try the first few results until one downloads
      await react("📥");
      let lastError;
      for (const item of results.slice(0, 3)) {
        try {
          const video = await getVideo(item.video_url);
          await message.reply({ attachment: video });
          await react("✅");
          return;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError || new Error("download failed");
    } catch (error) {
      console.log("[tiktok] failed:", error && (error.message || error));
      await react("❌");
      return message.reply("✕ API Error or Timeout!");
    }
  },

  onReply: async function ({ api, event, Reply, message }) {
    const { messageID, body, senderID } = event;
    const { results, author } = Reply;

    if (senderID !== author) return;

    const index = parseInt(body) - 1;
    if (isNaN(index) || index < 0 || index >= results.length) {
      return message.reply("✕ Invalid selection!");
    }

    Promise.resolve(api.unsendMessage(Reply.messageID)).catch(() => {});
    Promise.resolve(api.setMessageReaction("📥", messageID)).catch(() => {});

    try {
      const video = await getVideo(results[index].video_url);
      return await message.reply({
        body: `❖ 𝗧𝗜𝗞𝗧𝗢𝗞 𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗 ❖\n━━━━━━━━━━━━━━━━━━\n📝 Title: ${results[index].title || ""}`,
        attachment: video
      });
    } catch (error) {
      console.log("[tiktok] download failed:", error && (error.message || error));
      return message.reply("✕ Failed to download video!");
    }
  }
};
