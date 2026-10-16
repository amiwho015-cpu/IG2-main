"use strict";

const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");
const os = require("os");
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

// kind "hub" = the original xalman-hub models (numbers 1-12, unchanged)
// kind "nkx" = NKX GEN models (13+), picked by their API id
// Numbers never change, so add new models at the END only.
const MODELS = [
  { id: 1, name: "Flux 2 Max", tag: "🔥", kind: "hub", path: "/api/flux2max", supportsImage: true },
  { id: 2, name: "GPT Image 2", tag: "🧠", kind: "hub", path: "/api/gptimage2", supportsImage: true },
  { id: 3, name: "GPT 2.5 Flare", tag: "✨", kind: "hub", path: "/api/gpt2.5-flare", supportsImage: true },
  { id: 4, name: "GPT 2.5 Flare V2", tag: "✨", kind: "hub", path: "/api/gpt2.5-flare-v2", supportsImage: true },
  { id: 5, name: "GPT 2.5 Sunburst", tag: "🌅", kind: "hub", path: "/api/gpt2.5-sunburst", supportsImage: true },
  { id: 6, name: "GPT Image 2.5 Sunburst V2", tag: "🌅", kind: "hub", path: "/api/gptimage2.5-sunburst-v2", supportsImage: true },
  { id: 7, name: "Grok", tag: "⚡", kind: "hub", path: "/api/grok", supportsImage: true },
  { id: 8, name: "Nano Banana", tag: "🍌", kind: "hub", path: "/api/nb", supportsImage: true },
  { id: 9, name: "Nano Banana 2", tag: "🍌", kind: "hub", path: "/api/nanobanana2", supportsImage: true },
  { id: 10, name: "Qwen Image 2", tag: "🌀", kind: "hub", path: "/api/qwenimage2", supportsImage: true },
  { id: 11, name: "Qwen Image", tag: "🌀", kind: "hub", path: "/api/qwen-image", supportsImage: false },
  { id: 12, name: "SeedDream 4", tag: "🌱", kind: "hub", path: "/api/seedream4", supportsImage: true },

  { id: 13, name: "NKX Nano Banana 2", tag: "🍌", kind: "nkx", model: "nano-banana-2" },
  { id: 14, name: "NKX GPT Image 2", tag: "🧠", kind: "nkx", model: "gpt-image-2-low" },
  { id: 15, name: "NKX Flux 2 Dev", tag: "🔥", kind: "nkx", model: "flux-2-dev" },
  { id: 16, name: "NKX Flux 2 Flex", tag: "🔥", kind: "nkx", model: "flux-2-flex" },
  { id: 17, name: "NKX Flux 2 Pro", tag: "🔥", kind: "nkx", model: "flux-2-pro" },
  { id: 18, name: "NKX Flux Krea", tag: "🔥", kind: "nkx", model: "flux-krea" },
  { id: 19, name: "NKX Ideogram V3 Turbo", tag: "🎨", kind: "nkx", model: "ideogram-v3-turbo" },
  { id: 20, name: "NKX SeedDream 4", tag: "🌱", kind: "nkx", model: "seedream-4" },
  { id: 21, name: "NKX SeedDream 4.5", tag: "🌱", kind: "nkx", model: "seedream-4-5" },
  { id: 22, name: "NKX SeedDream 5", tag: "🌱", kind: "nkx", model: "seedream-5" },
  { id: 23, name: "NKX Qwen Image 2", tag: "🌀", kind: "nkx", model: "qwen-image-2" },
  { id: 24, name: "NKX Qwen Image 2 Pro", tag: "🌀", kind: "nkx", model: "qwen-image-2-pro" },
  { id: 25, name: "NKX Gemini 2.5 Flash Image", tag: "💎", kind: "nkx", model: "gemini-2-5-flash-image" },
  { id: 26, name: "NKX GPT 2.5 Flare", tag: "✨", kind: "nkx", model: "gpt-image-2-5-flare-low" },
  { id: 27, name: "NKX GPT 2.5 Sunburst", tag: "🌅", kind: "nkx", model: "gpt-image-2-5-sunburst-low" }
];

function buildModelBox() {
  const rows = MODELS.map(m => `│ ${String(m.id).padStart(2, "0")}. ${m.tag} ${m.name}`);
  return "╭─〔 🤖 𝐆𝐄𝐍𝐗 𝐌𝐎𝐃𝐄𝐋𝐒 〕─╮\n" + rows.join("\n") + "\n╰─────────────────────╯";
}

function extFromBuffer(buffer, contentType) {
  const magic = buffer.slice(0, 12).toString("hex");
  if (magic.startsWith("89504e470d0a1a0a")) return "png";
  if (magic.startsWith("ffd8ff")) return "jpg";
  if (magic.startsWith("47494638")) return "gif";
  if (magic.startsWith("52494646") && magic.includes("57454250")) return "webp";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

module.exports = {
  config: {
    name: "genx",
    aliases: ["gnx"],
    version: "2.0",
    author: "CRX Shihab",
    countDown: 10,
    role: 0,
    shortDescription: { en: "Generate images with 27 AI models" },
    longDescription: { en: "Text-to-image with many models. For editing photos use the edit command." },
    category: "AI",
    guide: {
      en:
        "   {pn} <prompt> --m <1-27> --ar <ratio>\n" +
        "   {pn} models   → list every model\n\n" +
        buildModelBox() +
        "\n\n📐 Ratios: " + nkx.RATIOS.join(", ")
    }
  },

  onStart: async function ({ api, event, args, message, prefix, commandName }) {
    const { messageID } = event;

    if (!args.length || ["models", "model", "list", "--models"].includes(String(args[0]).toLowerCase())) {
      return message.reply(
        `╭─〔 🤖 𝐆𝐄𝐍𝐗 𝐈𝐌𝐀𝐆𝐄 𝐀𝐈 〕─╮\n` +
        `│ 📝 ${prefix}${commandName} <prompt> --m <1-${MODELS.length}> --ar <ratio>\n` +
        `│ ✏️ Photo edit: ${prefix}edit <prompt> --m <number>\n` +
        `╰─────────────────────╯\n\n` +
        buildModelBox() +
        `\n\n📐 Ratios: ${nkx.RATIOS.join(", ")}`
      );
    }

    const parsed = nkx.parseArgs(args);
    const model = MODELS.find(m => m.id === parseInt(parsed.model, 10));
    if (!model) {
      return message.reply(`❌ Please choose a valid model with --m <1-${MODELS.length}>.\n\n${buildModelBox()}`);
    }
    if (!parsed.prompt) return message.reply("❌ Please provide a prompt.");

    const ratio = parsed.ratio && nkx.RATIOS.includes(parsed.ratio) ? parsed.ratio : "1:1";

    // a photo you reply to is used as a reference (kept from the old behaviour)
    const reference = nkx.photosOf(event.messageReply?.attachments)[0] || null;
    const canUseImage = model.kind === "nkx" || model.supportsImage;
    const isEdit = Boolean(reference && canUseImage);

    nkx.react(api, messageID, "⏳");
    let filePath;
    try {
      if (model.kind === "nkx") {
        const payload = { prompt: parsed.prompt, model: model.model, ratio, resolution: "2k", wait: true };
        if (isEdit) payload.image_urls = [reference];
        const url = await nkx.runJob(payload);
        filePath = await nkx.downloadToTemp(url, "genx");
      } else {
        const endpoint = `${await getApiBaseUrl()}${model.path}`;
        const params = { prompt: parsed.prompt, ratio: ratio || "", image: model.supportsImage ? (reference || "") : undefined };
        const res = await axios.get(endpoint, { params, timeout: 180000, responseType: "arraybuffer", validateStatus: () => true });

        const contentType = res.headers["content-type"] || "";
        const buffer = Buffer.from(res.data);
        if (contentType.includes("json") || contentType.includes("text") || res.status >= 400) {
          let errMsg = `HTTP ${res.status} ${res.statusText || ""}`.trim();
          try {
            const errData = JSON.parse(buffer.toString("utf-8"));
            errMsg = errData?.message || errData?.error || errMsg;
          } catch {
            const snippet = buffer.toString("utf-8").replace(/\s+/g, " ").trim().slice(0, 150);
            if (snippet) errMsg = snippet;
          }
          nkx.react(api, messageID, "❌");
          return message.reply(`❌ ${model.name} failed: ${errMsg}`);
        }
        filePath = path.join(os.tmpdir(), `genx_${Date.now()}.${extFromBuffer(buffer, contentType)}`);
        await fs.writeFile(filePath, buffer);
      }

      nkx.react(api, messageID, "✅");
      return await message.reply({
        body:
          `╭─〔 🤖 𝐆𝐄𝐍𝐗 𝐑𝐄𝐒𝐔𝐋𝐓 〕─╮\n` +
          `│ ${model.tag} 𝐌𝐨𝐝𝐞𝐥   ─> ${model.name}\n` +
          `│ 📐 𝐑𝐚𝐭𝐢𝐨   ─> 「 ${ratio} 」\n` +
          `│ 🎭 𝐌𝐨𝐝𝐞    ─> 『 ${isEdit ? "Edit" : "Text-to-Image"} 』\n` +
          `╰----------------------------─╯`,
        attachment: fs.createReadStream(filePath)
      });
    } catch (err) {
      console.error("[genx] Error:", err.message);
      nkx.react(api, messageID, "❌");
      return message.reply(`❌ ${model.name} failed: ${err.message}`);
    } finally {
      if (filePath) setTimeout(() => fs.remove(filePath).catch(() => { }), 15000).unref?.();
    }
  }
};
    
