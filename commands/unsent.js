module.exports = {
  config: {
    name: "unsent",
    aliases: ["u", "uns", "un", "r"],
    version: "3.5",
    author: "CRX Shihab",
    countDown: 2,
    role: 0,
    shortDescription: "Unsend bot's message ",
    category: "utility"
  },

  onChat: async function ({ api, event }) {
    const { messageReply, body, type } = event;
    const triggers = ["unsent", "u", "uns", "un", "r"];

    if (!triggers.includes(body?.toLowerCase())) return;

    if (type === "message_reply" && messageReply && messageReply.messageID) {
      try {
        await api.unsendMessage(event.messageReply.messageID, event.threadID);
        console.log("[unsent] ok", event.messageReply.messageID);
      } catch (error) { console.error("[unsent] failed:", error && error.message || error); }
    }
  },

  onStart: async function ({ api, event }) {
    const { messageReply, type } = event;

    if (type === "message_reply" && messageReply?.messageID) {
      try {
        await api.unsendMessage(event.messageReply.messageID, event.threadID);
        console.log("[unsent] ok", event.messageReply.messageID);
      } catch (error) { console.error("[unsent] failed:", error && error.message || error); }
    }
  }
};
