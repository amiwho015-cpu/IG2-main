"use strict";

/**
 * Message context handed to every command.
 * Author: Saifullah Al Neoaz (https://github.com/lazyneoaz)
 */

const utils = require("./utils");
const { toVoiceSource, toSendableVideo } = require("./audioFix");

/**
 * Build the message helper for an event. It exposes:
 *   message.send(form)          send to the thread
 *   message.reply(form)         reply to the triggering message
 *   message.unsend(id?)         remove a message for everyone
 *   message.react(emoji, id?)   react to a message
 *   message.effect(text, style) animated text effect
 *   message.typing()            typing indicator (returns a stop fn)
 *
 * `form` may be a string, or `{ body, attachment, url, effect, avatarEffect, textFirst }`.
 * Media attachments are routed to sendImage / sendAudio / sendVideo based on
 * their type, and each media source may be a URL, path, Buffer or stream.
 * When a `body` is present it is always sent BEFORE the attachment; pass
 * `textFirst: false` to opt out.
 */
function createMessageContext({ api, event, log }) {
	const threadID = event.threadID;
	const eventMessageID = event.messageID;

	function sendPlain(form, replyTarget) {
		const body = typeof form === "string" ? form : (form && form.body != null ? String(form.body) : "");
		const payload = { body };
		if (form && typeof form === "object") {
			if (form.url) payload.url = form.url;
			if (form.effect != null) payload.effect = form.effect;
			if (form.avatarEffect != null) payload.avatarEffect = form.avatarEffect;
		}
		return new Promise((resolve, reject) => {
			api.sendMessage(payload, threadID, (error, result) => error ? reject(error) : resolve(result), replyTarget);
		});
	}

	function sendWithMedia(form, replyTarget) {
		const sources = (Array.isArray(form.attachment) ? form.attachment : [form.attachment]).filter(Boolean);
		if (!sources.length) return sendPlain(form, replyTarget);

		// Text always precedes attached media: Instagram's media broadcasts
		// (image/video/audio) are media-only, so a caption sent with them would
		// arrive AFTER the attachment. When there is a body, post it as its own
		// message first and send the media bare. Set `textFirst: false` to opt
		// out (e.g. a caller that wants the caption attempted inline).
		const hasBody = form.body != null && String(form.body) !== "";
		const textFirst = hasBody && form.textFirst !== false;

		return new Promise((resolve, reject) => {
			let index = 0;
			let firstResult = null;
			let textResult = null;
			const mediaIDs = [];
			// With a body the caller gets the TEXT message's result, but players often
			// reply to the image that follows it. Expose every id that was sent as
			// `messageIDs` so reply handlers can be armed on all of them.
			const finish = () => {
				const base = textResult || firstResult;
				if (!base || typeof base !== "object") return resolve(base);
				const ids = [base.messageID, ...mediaIDs].filter(id => id != null).map(String);
				const unique = ids.filter((id, i) => ids.indexOf(id) === i);
				try {
					if (unique.length > 1) Object.defineProperty(base, "messageIDs", { value: unique, enumerable: false, configurable: true, writable: true });
					// A media-only message has no text, so a reply to it carries no quoted body to match on.
					if (!hasBody) Object.defineProperty(base, "mediaOnly", { value: true, enumerable: false, configurable: true, writable: true });
				}
				catch (_) { /* frozen result: these are only conveniences */ }
				return resolve(base);
			};
			const sendMedia = () => {
				if (index >= sources.length) return finish();
				const current = index++;
				const raw = sources[current];
				const kind = utils.mediaKind(raw);
				const source = utils.toSource(raw);
				const caption = current === 0 && !textFirst && form.body != null ? String(form.body) : "";
				const done = (error, result) => {
					if (error) return reject(error);
					if (current === 0) firstResult = result;
					if (result && typeof result === "object" && result.messageID != null) mediaIDs.push(result.messageID);
					sendMedia();
				};
				try {
					// Instagram's video_attachment broadcast is media-only: captions
					// are silently dropped. Send the clip, then the caption as its
					// own plain message (the documented way to caption a video).
					if (kind === "video") {
						const videoReply = current === 0 ? replyTarget : undefined;
						const afterVideo = (error, result) => {
							if (error || !caption) return done(error, result);
							api.sendMessage({ body: caption }, threadID, () => done(null, result), videoReply);
						};
						return toSendableVideo(source).then(video => api.sendVideo(video, threadID, (error, result) => {
							// Some ig-chat-api-server builds fail video uploads with a
							// server-side "caption is not defined". Retry once with the
							// caption slot filled (the sendImage-style signature).
							if (error && /caption is not defined/i.test(String(error.message || error))) {
								log.warn("VIDEO", "server said 'caption is not defined', retrying with an empty caption");
								return api.sendVideo(video, threadID, "", afterVideo, videoReply);
							}
							return afterVideo(error, result);
						}, videoReply)).catch(error => reject(error));
					}
					if (kind === "audio") {
						// The voice_attachment broadcast is also media-only: send the
						// clip, then its caption as a separate plain message.
						const audioReply = current === 0 ? replyTarget : undefined;
						const hint = typeof raw === "object" && raw && !Buffer.isBuffer(raw) && typeof raw.pipe !== "function" ? { mimetype: raw.mimetype || raw.mimeType } : {};
						return toVoiceSource(source, hint).then(voice => api.sendAudio(voice, threadID, (error, result) => {
							if (error || !caption) return done(error, result);
							api.sendMessage({ body: caption }, threadID, () => done(null, result), audioReply);
						}, audioReply)).catch(error => {
							log.warn("AUDIO", `convert failed (${error.message}), sending original`);
							return api.sendAudio(source, threadID, (e, r) => done(e, r), audioReply);
						});
					}
					return api.sendImage(source, threadID, "", (error, result) => {
						if (error || !caption) return done(error, result);
						api.sendMessage({ body: caption }, threadID, () => done(null, result), current === 0 ? replyTarget : undefined);
					}, current === 0 ? replyTarget : undefined);
				}
				catch (error) {
					return reject(error);
				}
			};
			if (!textFirst) return sendMedia();
			// Text first, then the media (no caption on the media).
			api.sendMessage({ body: String(form.body) }, threadID, (error, result) => {
				if (error) return reject(error);
				textResult = result;
				sendMedia();
			}, replyTarget);
		});
	}

	function dispatch(form, replyTarget) {
		if (form == null) return Promise.reject(new Error("Nothing to send"));
		if (typeof form === "object" && !Array.isArray(form) && form.attachment != null)
			return sendWithMedia(form, replyTarget);
		return sendPlain(form, replyTarget);
	}

	const context = {
		threadID,
		event,

		/** Send to the thread. Accepts an optional node-style callback. */
		send(form, callback) {
			if (typeof callback === "function")
				return dispatch(form, undefined).then(r => callback(null, r), e => callback(e));
			return dispatch(form, undefined);
		},

		/** Reply to the message that triggered this command. */
		reply(form, callback) {
			if (typeof callback === "function")
				return dispatch(form, eventMessageID).then(r => callback(null, r), e => callback(e));
			return dispatch(form, eventMessageID);
		},

		/** Remove a message for everyone (defaults to the triggering message). */
		unsend(messageID = eventMessageID, callback) {
			if (typeof callback === "function")
				return api.unsendMessage(messageID, threadID, callback);
			return new Promise((resolve, reject) => {
				api.unsendMessage(messageID, threadID, (error, result) => error ? reject(error) : resolve(result));
			});
		},

		/** React to a message ("" removes the reaction). */
		react(emoji, messageID = eventMessageID, callback) {
			const reaction = emoji == null ? "" : emoji;
			if (typeof callback === "function")
				return api.setMessageReaction(reaction, messageID, threadID, callback);
			return new Promise((resolve, reject) => {
				api.setMessageReaction(reaction, messageID, threadID, (error, result) => error ? reject(error) : resolve(result));
			});
		},

		/** Animated text effect ("love", "gift", "celebration", "fire"). */
		effect(text, effect, callback) {
			if (typeof callback === "function")
				return api.sendTextEffect(text, threadID, effect, callback);
			return new Promise((resolve, reject) => {
				api.sendTextEffect(text, threadID, effect, (error, result) => error ? reject(error) : resolve(result));
			});
		},

		/** Avatar character text effect ("love", "angry", "laugh", "cry"). */
		avatarEffect(text, effect, callback) {
			// Avatar effects work like text effects: a text broadcast carrying
			// power_up_data={"style":1000..1003} and no avatar sticker id. The
			// app also sends an `attachment_fbid` avatar sticker id, but
			// Instagram scopes that id to one conversation, so sending it makes
			// the post fail with 403 error_code 1545003 in every other thread.
			// Omitting it works from any thread, so we pass the effect name and
			// the server resolves it to just the style.
			const attempt = new Promise((resolve, reject) => {
				api.sendAvatarTextEffect(text, threadID, effect, (error, result) => error ? reject(error) : resolve(result));
			});
			if (typeof callback === "function")
				attempt.then(result => callback(null, result), error => callback(error));
			return attempt;
		},

		/** Attach an Instagram music sticker. Accepts a track id or musicSearch result. */
		music(track, callback) {
			if (typeof callback === "function")
				return api.sendMusic(threadID, track, callback);
			return new Promise((resolve, reject) => {
				api.sendMusic(threadID, track, (error, result) => error ? reject(error) : resolve(result));
			});
		},

		/** Search Instagram's music catalogue. */
		musicSearch(query, callback) {
			if (typeof callback === "function")
				return api.musicSearch(query, callback);
			return new Promise((resolve, reject) => {
				api.musicSearch(query, (error, result) => error ? reject(error) : resolve(result));
			});
		},

		/** Show a typing indicator. Returns a stop function. */
		typing() {
			return api.sendTypingIndicator(threadID, () => { });
		}
	};

	return context;
}

module.exports = { createMessageContext };
