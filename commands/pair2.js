const axios = require("axios");
const { pickPartner } = require("../src/gender");
const Canvas = require("canvas");
const fs = require("fs");
const path = require("path");
const { safeLoadImage, safeLoadBackground, safeThreadInfo } = require("../src/pairUtil");

module.exports = {
  config: {
    name: "pair2",
    version: "3.0",
    author: "CRX Shihab",
    role: 0,
    countDown: 5,
    shortDescription: "Cute romantic pair system",
    category: "LOVE"
  },

  onStart: async function ({ api, event, usersData }) {
    const { threadID, messageID, senderID, messageReply } = event;

    try {
      let targetID = senderID;
      let targetName = null;

      if (messageReply) {
        targetID = messageReply.senderID;
        try {
          const userData = await usersData.get(targetID);
          targetName = userData.name || "User";
        } catch {
          targetName = "User";
        }
      }

      const loading = await api.sendMessage("💗 | Finding your perfect partner...", threadID);

      const [senderData, threadInfo] = await Promise.all([
        usersData.get(targetID),
        safeThreadInfo(api, threadID, event)
      ]);

      const senderName = targetName || senderData.name || "User";

      const members = threadInfo.participantIDs.map(String).filter(uid => uid != String(targetID));
      const wanted = ["boy", "girl"].includes(String(args[0] || "").toLowerCase()) ? String(args[0]).toLowerCase() : null;
      let me, partner;
      try {
        ({ me, partner } = await pickPartner(usersData, String(targetID), members, wanted));
      } catch (e) {
        if (e.friendly) return api.sendMessage("⚠️ " + e.message, threadID, messageID);
        throw e;
      }
      const senderGender = me.gender;

      const match = Math.floor(Math.random() * 31) + 70;

      const canvas = Canvas.createCanvas(1200, 700);
      const ctx = canvas.getContext("2d");

      const gradient = ctx.createLinearGradient(0, 0, 1200, 700);
      gradient.addColorStop(0, "#ffe6f2");
      gradient.addColorStop(1, "#fff0f7");

      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < 50; i++) {
        ctx.font = `${20 + Math.random() * 35}px sans-serif`;
        ctx.fillStyle = "rgba(255,105,180,0.15)";
        ctx.fillText("💖", Math.random() * canvas.width, Math.random() * canvas.height);
      }

      ctx.strokeStyle = "#ffb6d9";
      ctx.lineWidth = 16;
      ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);

      ctx.font = "55px sans-serif";
      for (let i = 0; i < 6; i++) {
        ctx.fillText("🎀", 80 + i * 190, 65);
      }


      const avt1 = await usersData.getAvatarUrl(targetID);
      const avt2 = await usersData.getAvatarUrl(partner.id);

      const loadImage = url => safeLoadImage(Canvas, axios, url);

      const [img1, img2] = await Promise.all([loadImage(avt1), loadImage(avt2)]);

      function drawCuteFrame(img, x, y) {
        const size = 260;

        ctx.shadowColor = "#ff69b4";
        ctx.shadowBlur = 30;

        ctx.fillStyle = "#ffffff";
        ctx.fillRect(x - 14, y - 14, size + 28, size + 28);

        ctx.strokeStyle = "#ff8dc7";
        ctx.lineWidth = 10;
        ctx.strokeRect(x - 6, y - 6, size + 12, size + 12);

        ctx.drawImage(img, x, y, size, size);

        ctx.shadowBlur = 0;

        ctx.font = "35px sans-serif";

        ctx.fillText("🎀", x - 18, y - 18);
        ctx.fillText("🎀", x + size - 5, y - 18);

        ctx.fillText("💖", x - 10, y + size + 28);
        ctx.fillText("💖", x + size - 5, y + size + 28);
      }

      drawCuteFrame(img1, 120, 200);
      drawCuteFrame(img2, 820, 200);

      ctx.font = "130px sans-serif";
      ctx.fillText("💗", 515, 355);

      ctx.textAlign = "center";
      ctx.fillStyle = "#ff1493";
      ctx.font = "bold 48px Sans";
      ctx.fillText(`${match}% MATCH`, 600, 520);

      ctx.fillStyle = "#d63384";
      ctx.font = "bold 32px Sans";
      
      let displayName1 = senderName;
      let displayName2 = partner.name;
      
      if (displayName1.length > 15) {
        displayName1 = displayName1.substring(0, 15) + "...";
      }
      if (displayName2.length > 15) {
        displayName2 = displayName2.substring(0, 15) + "...";
      }
      
      ctx.fillText(displayName1, 250, 585);
      ctx.fillText(displayName2, 950, 585);

      ctx.font = "28px Sans";
      ctx.fillStyle = "#ff69b4";
      ctx.fillText("Made with Love 💕", 600, 650);

      const cacheDir = path.join(__dirname, "cache");
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const filePath = path.join(cacheDir, `pair_${Date.now()}.png`);
      fs.writeFileSync(filePath, canvas.toBuffer());

      if (loading && loading.messageID) {
        try {
          await api.unsendMessage(loading.messageID, threadID);
        } catch {}
      }

      const emoji = match > 85 ? "💞" : match > 75 ? "💗" : "💕";
      const compatibility = match > 85 ? "Perfect" : match > 75 ? "Great" : "Good";
      
      const genderEmoji1 = senderGender === 1 ? "👦" : senderGender === 2 ? "👧" : "👤";
      const genderEmoji2 = partner.gender === 1 ? "👦" : partner.gender === 2 ? "👧" : "👤";

      const msg = `${emoji} 𝗣𝗘𝗥𝗙𝗘𝗖𝗧 𝗣𝗔𝗜𝗥

${genderEmoji1} ${senderName} ✦ ${genderEmoji2} ${partner.name}
📊 ${match}% ${compatibility} Match
💘 Status: Matched!`;

      return await api.sendMessage(
        {
          body: msg,
          attachment: fs.createReadStream(filePath)
        },
        threadID,
        () => {
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
            } catch {}
          }
        },
        messageID
      );

    } catch (err) {
      console.error("[pair] failed:", err && err.stack || err);
      return api.sendMessage(`❌ | Pair system failed: ${String((err && err.message) || err).slice(0, 200)}`, threadID, messageID);
    }
  }
};
