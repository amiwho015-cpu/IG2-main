const axios = require("axios");

const API_CONFIG_URL = "https://raw.githubusercontent.com/goatbotnx/xalmanx210/refs/heads/main/apis.json";
const API_KEY = "xalman-hub";
let apiBaseUrl = null;
let apiConfigRequest = null;

async function getApiBaseUrl() {
  if (apiBaseUrl) return apiBaseUrl;

  if (!apiConfigRequest) {
    apiConfigRequest = axios
      .get(API_CONFIG_URL, { timeout: 15000 })
      .then(({ data }) => {
        const baseUrl = data?.[API_KEY];

        if (typeof baseUrl !== "string" || !baseUrl.trim()) {
          throw new Error(`Missing API key in apis.json: ${API_KEY}`);
        }

        apiBaseUrl = baseUrl.replace(/\/+$/, "");
        return apiBaseUrl;
      })
      .finally(() => {
        apiConfigRequest = null;
      });
  }

  return apiConfigRequest;
}
const fs = require("fs-extra");
const path = require("path");

// ---- auto-unsend helpers ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Unsend with retries and real error logging (the old code swallowed every error silently).
async function unsendSafe(api, messageID, threadID, label = "msg") {
  if (!messageID) return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await api.unsendMessage(messageID, threadID);
      return true;
    } catch (e) {
      console.log(`[ytb] unsend ${label} failed (try ${attempt}/3):`, e && (e.message || e));
      await sleep(1500 * attempt);
    }
  }
  return false;
}


module.exports = {
  config: {
    name: "ytb",
    aliases: ["youtube"],
    version: "10.0",
    author: "CRX Shihab",
    countDown: 5,
    role: 0,
    shortDescription: "YouTube Audio/Video Downloader with fast stream response",
    longDescription: "Search and download YouTube audio/video with fast streaming support",
    category: "MEDIA",
    guide: {
      en: "{pn} -v <song name>\n{pn} -a <song name>\n{pn} <youtube link>"
    }
  },

  onStart: async function ({ api, event, args }) {
    const { threadID, messageID, senderID } = event;
    if (!args[0]) {
      return api.sendMessage(
        `╭──〔 YOUTUBE DOWNLOADER 〕──╮\n│\n├─ 🎥 ${this.config.name} -v believer\n├─ 🎵 ${this.config.name} -a believer\n├─ 🔗 ${this.config.name} <youtube link>\n│\n╰──────────────────╯`,
        threadID,
        messageID
      );
    }
    const input = args.join(" ");
    const ytRegex = /(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/[^\s]+/i;
    if (ytRegex.test(input)) {
      api.setMessageReaction("⏳", messageID, () => {}, true);
      return downloadMedia(api, threadID, messageID, input, "video");
    }
    let mode = "video";
    if (args[0] === "-a") mode = "audio";
    const query = args[0].startsWith("-") ? args.slice(1).join(" ") : args.join(" ");
    if (!query) {
      return api.sendMessage("❌ Please enter search query", threadID, messageID);
    }
    api.setMessageReaction("🔍", messageID, () => {}, true);
    try {
      const res = await axios.get(`${await getApiBaseUrl()}/api/ytsearch?q=${encodeURIComponent(query)}`);
      if (!res.data.status || !res.data.results || !res.data.results.length) {
        api.setMessageReaction("❌", messageID, () => {}, true);
        return api.sendMessage("❌ No result found", threadID, messageID);
      }
      const results = res.data.results;
      const searchQuery = res.data.search_query || query;
      const totalPages = Math.ceil(results.length / 5);
      if (!global.ytbSearch) global.ytbSearch = {};
      global.ytbSearch[senderID] = {
        results,
        mode,
        searchQuery,
        currentPage: 1,
        totalPages
      };
      await sendSearchPage(api, threadID, senderID, 1);
    } catch (e) {
      console.log(e);
      api.setMessageReaction("❌", messageID, () => {}, true);
      api.sendMessage("❌ Search failed", threadID, messageID);
    }
  },

  onReply: async function ({ api, event, Reply }) {
    const { threadID, messageID, body, senderID } = event;
    if (senderID != Reply.author) return;
    const data = global.ytbSearch?.[senderID];
    if (!data) return api.sendMessage("⚠️ Search session expired. Please search again.", threadID, messageID);
    const lower = body.toLowerCase().trim();
    if (lower === "next" || lower === "n") {
      if (data.currentPage < data.totalPages) {
        data.currentPage++;
        await sendSearchPage(api, threadID, senderID, data.currentPage);
      } else {
        api.sendMessage("📄 You are on the last page.", threadID, messageID);
      }
      return;
    }
    if (lower === "prev" || lower === "p") {
      if (data.currentPage > 1) {
        data.currentPage--;
        await sendSearchPage(api, threadID, senderID, data.currentPage);
      } else {
        api.sendMessage("📄 You are on the first page.", threadID, messageID);
      }
      return;
    }
    const num = parseInt(body);
    if (isNaN(num) || num < 1 || num > 5) {
      return api.sendMessage("❌ Invalid number. Choose 1-5, or type 'next'/'prev'.", threadID, messageID);
    }
    const pageStart = (data.currentPage - 1) * 5;
    const index = pageStart + num - 1;
    if (index >= data.results.length) {
      return api.sendMessage("❌ That result doesn't exist.", threadID, messageID);
    }
    const video = data.results[index];
    const listID = data.searchMessageID || Reply.searchMessageID;
    data.searchMessageID = null;
    if (global.GoatBot && global.GoatBot.onReply && listID) global.GoatBot.onReply.delete(listID);
    unsendSafe(api, listID, threadID, "search-list");
    api.setMessageReaction("⏳", messageID, () => {}, true);
    return downloadMedia(api, threadID, messageID, video.url, data.mode);
  }
};

async function sendSearchPage(api, threadID, senderID, page) {
  const data = global.ytbSearch?.[senderID];
  if (!data) return;
  const results = data.results;
  const pageStart = (page - 1) * 5;
  const pageResults = results.slice(pageStart, pageStart + 5);
  let msg = `╭──〔 SEARCH RESULT 〕──╮\n│ 🔎 Query: ${data.searchQuery || "..."}\n│ 📦 Mode: ${data.mode.toUpperCase()}\n│ 📄 Page ${page}/${data.totalPages}\n╰──────────────────╯\n\n`;
  for (let i = 0; i < pageResults.length; i++) {
    const idx = pageStart + i + 1;
    msg += `${idx}. ${pageResults[i].title}\n⏱ ${pageResults[i].duration}\n📺 ${pageResults[i].channel}\n\n`;
  }
  msg += "💬 Reply with a number (1-5) to select, or 'next'/'prev' to navigate.";
  if (data.searchMessageID) {
    await unsendSafe(api, data.searchMessageID, threadID, "old-search-page");
  }
  const sent = await api.sendMessage(msg, threadID);
  data.searchMessageID = sent.messageID;
  data.currentPage = page;
  global.GoatBot.onReply.set(sent.messageID, {
    commandName: "ytb",
    author: senderID,
    searchMessageID: sent.messageID
  });
}

async function downloadMedia(api, threadID, messageID, url, mode) {
  let waitMsg = null;
  try {
    waitMsg = await api.sendMessage("⏳ Downloading media...", threadID);
    const cacheDir = path.join(__dirname, "cache");
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const endpoint = mode === "audio" 
      ? `${await getApiBaseUrl()}/api/ytmp3?url=${encodeURIComponent(url)}`
      : `${await getApiBaseUrl()}/api/ytdl?url=${encodeURIComponent(url)}`;

    const apiRes = await axios.get(endpoint);
    const data = apiRes.data;

    const isSuccess = data.status || data.success;
    if (!isSuccess || !data.url) {
      api.setMessageReaction("❌", messageID, () => {}, true);
      if (waitMsg?.messageID) {
        await unsendSafe(api, waitMsg.messageID, threadID, "downloading");
      }
      return api.sendMessage("❌ Download failed", threadID, messageID);
    }

    const mediaUrl = data.url;
    const ext = mode === "audio" ? "mp3" : "mp4";
    const filePath = path.join(cacheDir, `${Date.now()}.${ext}`);

    const media = await axios({
      method: "GET",
      url: mediaUrl,
      responseType: "stream",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive"
      }
    });

    const writer = fs.createWriteStream(filePath);
    media.data.pipe(writer);

    writer.on("finish", async () => {
      if (waitMsg?.messageID) {
        await unsendSafe(api, waitMsg.messageID, threadID, "downloading");
      }
      api.setMessageReaction("✅", messageID, () => {}, true);
      // Only the song/video itself stays in the chat (no caption, no "complete" text).
      try {
        await api.sendMessage({ body: "", attachment: fs.createReadStream(filePath) }, threadID);
      } catch (e) {
        console.log("[ytb] media send failed:", e && e.message);
        api.sendMessage("❌ Could not send the file", threadID);
      }
      setTimeout(() => {
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch {}
        }
      }, 10000);
    });

    writer.on("error", async () => {
      api.setMessageReaction("❌", messageID, () => {}, true);
      if (waitMsg?.messageID) {
        await unsendSafe(api, waitMsg.messageID, threadID, "downloading");
      }
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
      api.sendMessage("❌ Download failed", threadID, messageID);
    });
  } catch (err) {
    console.log(err);
    api.setMessageReaction("❌", messageID, () => {}, true);
    if (waitMsg?.messageID) {
      await unsendSafe(api, waitMsg.messageID, threadID, "downloading");
    }
    api.sendMessage("❌ Download failed", threadID, messageID);
  }
}
