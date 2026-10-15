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
const moment = require("moment-timezone");

module.exports = {
  config: {
    name: "owner",
    aliases: ["admininfo", "info", "ownerinfo"],
    version: "3.0",
    author: "Shihab",
    countDown: 5,
    role: 0,
    shortDescription: { en: "Show owner information" },
    category: "owner",
    guide: { en: "{pn}" }
  },

  onStart: async function ({ api, event, message }) {

    const ownerName = "Negative Shihab";
    const ownerAge = "18+";
    const fbName = "Negative Shihab";
    const messenger = "https://www.facebook.com/profile.php?id=100094063186003";
    const whatsapp = "016133853**";
    const telegram = "Ekon use Kori na😢";
    const address = "Chandanaish, Chittagong, Bangladesh";
    const religion = "Islam";
    const apiServer = await getApiBaseUrl();
    const relationship = "Single"
    const timeBD = moment().tz("Asia/Dhaka");
    
    const infoMsg = 
`『 𝗢𝗪𝗡𝗘𝗥 𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗧𝗜𝗢𝗡 』
━━━━━━━━━━━━━━━━━━━━━

👤 𝗔𝗕𝗢𝗨𝗧 𝗠𝗘:
● Name: ${ownerName}
● Age: ${ownerAge}
● Relationship: ${relationship}
● Religion: ${religion}
● Address: ${address}

📞 𝗖𝗢𝗡𝗧𝗔𝗖𝗧 𝗗𝗘𝗧𝗔𝗜𝗟𝗦:
● Facebook: ${fbName}
● Fb Link: ${messenger}
● WhatsApp: ${whatsapp}
● Telegram: ${telegram}


⏰ 𝗗𝗔𝗧𝗘 & 𝗧𝗜𝗠𝗘 (𝗕𝗗):
● ${timeBD.format("DD MMMM, YYYY")}
● ${timeBD.format("hh:mm:ss A")}
━━━━━━━━━━━━━━━━━━━━━`;

    try {
      return message.reply({
        body: infoMsg,
        attachment: await global.utils.getStreamFromURL(imageLink)
      });
    } catch (e) {
      return message.reply(infoMsg);
    }
  },

  onChat: async function ({ event, message }) {
    if (event.body?.toLowerCase() === "info") {
      return this.onStart({ message, event });
    }
  }
};
