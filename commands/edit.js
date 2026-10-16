"use strict";

const axios = require("axios");
const fs = require("fs-extra");
const nkx = require("../src/nkxClient");

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
        if (typeof baseUrl !== "string" || !baseUrl.trim()) throw new Error(`Missing API key in apis.json: ${API_KEY}`);
        apiBaseUrl = baseUrl.replace(/\/+$/, "");
        return apiBaseUrl;
      })
      .finally(() => { apiConfigRequest = null; });
  }
  return apiConfigRequest;
}

// Edit models only (the image-generation models live in genx). Model 1 is the original edit
// service and the default; 2+ are NKX edit models that can take two photos at once.
// Numbers never change, so add new models at the END only.
const MODELS = [
  { id: 1, name: "Classic Edit", tag: "🎨", kind: "hub", maxImages: 1 },
  { id: 2, name: "Nano Banana 2 Edit", tag: "🍌", kind: "nkx", model: "nano-banana-2-edit", maxImages: 2 },
  { id: 3, name: "GPT Image 2 Edit", tag: "🧠", kind: "nkx", model: "gpt-image-2-edit", maxImages: 2 },
  { id: 4, name: "Flux 2 Dev Edit", tag: "🔥", kind: "nkx", model: "flux-2-dev-edit", maxImages: 2 },
  { id: 5, name: "Flux 2 Pro Edit", tag: "🔥", kind: "nkx", model: "flux-2-pro-edit", maxImages: 2 },
  { id: 6, name: "Flux Krea Edit", tag: "🔥", kind: "nkx", model: "flux-krea-edit", maxImages: 2 },
  { id: 7, name: "Flux Kontext Dev", tag: "🔥", kind: "nkx", model: "flux-kontext-dev", maxImages: 2 },
  { id: 8, name: "SeedDream 4 Edit", tag: "🌱", kind: "nkx", model: "seedream-4-edit", maxImages: 2 },
  { id: 9, name: "SeedDream 4.5 Edit", tag: "🌱", kind: "nkx", model: "seedream-4-5-edit", maxImages: 2 },
  { id: 10, name: "SeedDream 5 Edit", tag: "🌱", kind: "nkx", model: "seedream-5-edit", maxImages: 2 },
  { id: 11, name: "Gemini 2.5 Flash Edit", tag: "💎", kind: "nkx", model: "gemini-2-5-flash-image-edit", maxImages: 2 },
  { id: 12, name: "GPT 2.5 Flare Edit", tag: "✨", kind: "nkx", model: "gpt-image-2-5-flare-low-edit", maxImages: 2 },
  { id: 13, name: "GPT 2.5 Sunburst Edit", tag: "🌅", kind: "nkx", model: "gpt-image-2-5-sunburst-low-edit", maxImages: 2 }
];

function buildModelBox() {
  const rows = MODELS.map(m => `│ ${String(m.id).padStart(2, "0")}. ${m.tag} ${m.name}${m.maxImages > 1 ? " (2 photos)" : ""}`);
  return "╭─〔 ✏️ 𝐄𝐃𝐈𝐓 𝐌𝐎𝐃𝐄𝐋𝐒 〕─╮\n" + rows.join("\n") + "\n╰─────────────────────╯";
}

// The photos to edit: the ones in the message you reply to, extra --img links, and (with --2)
// your previous photo in this chat. Never more than two.
function collectPhotos(event, parsed) {
  const urls = [];
  const add = (u) => { if (u && !urls.some(x => nkx.sameFile(x, u))) urls.push(u); };

  nkx.photosOf(event.messageReply?.attachments).forEach(add);
  nkx.photosOf(event.attachments).forEach(add);
  parsed.images.filter(u => /^https?:\/\//i.test(u)).forEach(add);

  if (parsed.two && urls.length < 2) {
    const mine = (global.__recentPhotos && global.__recentPhotos.get(`${event.threadID}:${event.senderID}`)) || [];
    const fresh = mine.filter(p => Date.now() - p.at < 10 * 60 * 1000);
    // newest first; the earlier photo goes first so "photo 1" is the one you sent first
    for (let i = fresh.length - 1; i >= 0 && urls.length < 2; i--) {
      const u = fresh[i].url;
      if (u && !urls.some(x => nkx.sameFile(x, u))) urls.unshift(u);
    }
  }
  return urls.slice(0, 2);
}

module.exports = {
  config: {
    name: "edit",
    aliases: ["imageedit", "ai-edit"],
    version: "5.0",
    author: "CRX Shihab",
    countDown: 10,
    role: 0,
    shortDescription: "AI Image Editor",
    longDescription: "Edit one or two photos with AI by replying to a photo with a prompt. Pick a model with --m.",
    category: "AI",
    guide:
      "{pn} <prompt> --m <number>   (reply to a photo)\n" +
      "{pn} models   → list the edit models\n" +
      "Two photos: send photo 1, send photo 2, reply to photo 2 with {pn} <prompt> --m 2 --2"
  },

  onStart: async function ({ api, event, args, message, prefix, commandName }) {
    const { messageID } = event;

    if (!args.length || ["models", "model", "list", "--models"].includes(String(args[0]).toLowerCase())) {
      return message.reply(
        `╭─〔 ✏️ 𝐀𝐈 𝐄𝐃𝐈𝐓 〕─╮\n` +
        `│ 📝 Reply to a photo: ${prefix}${commandName} <prompt> --m <1-${MODELS.length}>\n` +
        `│ 🖼️ Two photos: send both, reply to the 2nd with --2\n` +
        `│ ⭐ No --m = model 1\n` +
        `╰─────────────────╯\n\n` + buildModelBox()
      );
    }

    const parsed = nkx.parseArgs(args);
    const modelNo = parsed.model == null ? 1 : parseInt(parsed.model, 10);
    const model = MODELS.find(m => m.id === modelNo);
    if (!model) return message.reply(`❌ Please choose a valid model with --m <1-${MODELS.length}>.\n\n${buildModelBox()}`);
    if (!parsed.prompt) return message.reply(`📝 Please provide a prompt.\nExample: ${prefix}${commandName} change the background to space --m 2`);

    const photos = collectPhotos(event, parsed);
    if (!photos.length) {
      return message.reply(
        "⚠️ Reply to a photo to start editing.\n" +
        "For two photos: send both, then reply to the second one with  --2  added."
      );
    }
    if (photos.length > model.maxImages) {
      return message.reply(
        `⚠️ ${model.name} edits one photo at a time.\nFor two photos use a model marked (2 photos), for example --m 2.`
      );
    }

    nkx.react(api, messageID, "🎨");
    let processing = null;
    try { processing = await message.reply("🚀 | Processing your image, please wait..."); } catch (_) { /* optional */ }

    let filePath;
    try {
      if (model.kind === "hub") {
        const url = `${await getApiBaseUrl()}/api/edit?img=${encodeURIComponent(photos[0])}&prompt=${encodeURIComponent(parsed.prompt)}`;
        const res = await axios({ method: "GET", url, responseType: "arraybuffer", timeout: 240000 });
        filePath = require("path").join(require("os").tmpdir(), `edited_${Date.now()}.png`);
        await fs.writeFile(filePath, Buffer.from(res.data));
      } else {
        const payload = { prompt: parsed.prompt, model: model.model, image_urls: photos, resolution: "2k", wait: true };
        if (parsed.ratio && nkx.RATIOS.includes(parsed.ratio)) payload.ratio = parsed.ratio;
        const url = await nkx.runJob(payload);
        filePath = await nkx.downloadToTemp(url, "edited");
      }

      nkx.react(api, messageID, "✅");
      if (processing && processing.messageID) { try { await api.unsendMessage(processing.messageID); } catch (_) { /* already gone */ } }
      await message.reply({
        body: `✨ 𝗜𝗠𝗔𝗚𝗘 𝗘𝗗𝗜𝗧𝗘𝗗 ✨\n━━━━━━━━━━━━━━━━━━━\n${model.tag} ${model.name}${photos.length > 1 ? " · 2 photos" : ""}\nPrompt: ${parsed.prompt}`,
        attachment: fs.createReadStream(filePath)
      });
    } catch (err) {
      console.error("[edit] Error:", err.response?.data || err.message);
      nkx.react(api, messageID, "❌");
      if (processing && processing.messageID) { try { await api.unsendMessage(processing.messageID); } catch (_) { /* already gone */ } }
      const msg = err.code === "ECONNABORTED" ? "⏱️ | Request Timeout: the server took too long." : `🚫 | ${model.name} failed: ${err.message}`;
      return message.reply(msg);
    } finally {
      if (filePath) { const t = setTimeout(() => fs.remove(filePath).catch(() => { }), 15000); if (t.unref) t.unref(); }
    }
  }
};
    
