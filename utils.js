const moment = require('moment-timezone');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');

class MessageUtils {
  constructor(ctx) {
    this.ctx = ctx;
    this.api = ctx.telegram;
    this.event = ctx.message || ctx.callbackQuery?.message || ctx.update;
    this.Markup = Markup;

    // Add easy-access properties for commands
    const msg = ctx.message || ctx.callbackQuery?.message;
    if (msg) {
      // Chat info
      this.chatId = msg.chat?.id;
      this.chatType = msg.chat?.type; // 'private', 'group', 'supergroup', 'channel'
      this.chatTitle = msg.chat?.title || null; // Group/channel name
      this.isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup';
      this.isPrivate = msg.chat?.type === 'private';

      // Sender info
      this.senderID = msg.from?.id;
      this.senderName = msg.from ? `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() : null;
      this.senderUsername = msg.from?.username || null;

      // Message content types
      this.hasText = !!msg.text;
      this.hasPhoto = !!msg.photo;
      this.hasVideo = !!msg.video;
      this.hasAudio = !!msg.audio;
      this.hasVoice = !!msg.voice;
      this.hasDocument = !!msg.document;
      this.hasSticker = !!msg.sticker;
      this.hasAnimation = !!msg.animation;

      // Message content
      this.messageText = msg.text || msg.caption || '';
      this.messageId = msg.message_id;
    }

    // Database shortcuts
    this.db = {
      getUser: (userId) => global.db.getUser(String(userId)),
      updateUser: (userId, data) => global.db.updateUser(String(userId), data),
      getThread: (chatId) => global.db.getThread(String(chatId)),
      updateThread: (chatId, data) => global.db.updateThread(String(chatId), data),
      incrementMessageCount: (userId, chatId) => global.db.incrementMessageCount(String(userId), String(chatId)),
      getUserMessageCount: (userId, chatId) => global.db.getUserMessageCount(String(userId), String(chatId)),
      getThreadMessageStats: (chatId) => global.db.getThreadMessageStats(String(chatId)),
      incrementUserExp: (userId, amount) => global.db.incrementUserExp(String(userId), amount),
      getAllUsers: () => global.db.getAllUsers(),
      getAllThreads: () => global.db.getAllThreads(),
      banUser: (userId, reason, bannedBy) => global.db.banUser(String(userId), reason, bannedBy),
      unbanUser: (userId) => global.db.unbanUser(String(userId)),
      isUserBanned: (userId) => global.db.isUserBanned(String(userId)),
      addWarning: (userId, chatId, reason, warnedBy) => global.db.addWarning(String(userId), String(chatId), reason, warnedBy),
      getWarnings: (userId, chatId) => global.db.getWarnings(String(userId), String(chatId)),
      clearWarnings: (userId, chatId) => global.db.clearWarnings(String(userId), String(chatId))
    };

    // Bind all Telegraf API methods to message object
    this._bindTelegrafMethods();
  }

  _bindTelegrafMethods() {
    const telegramApi = this.ctx.telegram;
    const defaultChatId = this.ctx.chat?.id;
    const defaultMessageId = this.ctx.message?.message_id || this.ctx.callbackQuery?.message?.message_id;

    const allMethods = new Set();
    let currentObj = telegramApi;

    while (currentObj && currentObj !== Object.prototype) {
      Object.getOwnPropertyNames(currentObj).forEach(name => {
        if (name !== 'constructor' && typeof telegramApi[name] === 'function') {
          allMethods.add(name);
        }
      });
      currentObj = Object.getPrototypeOf(currentObj);
    }

    allMethods.forEach(methodName => {
      const originalMethod = telegramApi[methodName];

      const sendMethodsThatNeedChatId = [
        'sendMessage', 'sendPhoto', 'sendVideo', 'sendAudio', 'sendDocument',
        'sendAnimation', 'sendVoice', 'sendVideoNote', 'sendMediaGroup',
        'sendLocation', 'sendVenue', 'sendContact', 'sendPoll', 'sendDice',
        'sendSticker', 'sendChatAction', 'getChat', 'getChatMember', 
        'getChatAdministrators', 'getChatMembersCount', 'setChatTitle', 
        'setChatDescription', 'setChatPhoto', 'deleteChatPhoto', 'pinChatMessage',
        'unpinChatMessage', 'unpinAllChatMessages', 'leaveChat', 'setChatPermissions',
        'banChatMember', 'unbanChatMember', 'restrictChatMember', 'promoteChatMember',
        'exportChatInviteLink', 'createChatInviteLink', 'revokeChatInviteLink',
        'approveChatJoinRequest', 'declineChatJoinRequest', 'setChatStickerSet',
        'deleteChatStickerSet', 'setChatAdministratorCustomTitle', 'createForumTopic',
        'editForumTopic', 'closeForumTopic', 'reopenForumTopic', 'deleteForumTopic',
        'unpinAllForumTopicMessages', 'editGeneralForumTopic', 'closeGeneralForumTopic',
        'reopenGeneralForumTopic', 'hideGeneralForumTopic', 'unhideGeneralForumTopic',
        'forwardMessage', 'copyMessage', 'stopPoll', 'setMessageReaction'
      ];

      const editMethodsThatNeedChatIdAndMessageId = [
        'editMessageText', 'editMessageCaption', 'editMessageMedia', 
        'editMessageReplyMarkup', 'deleteMessage'
      ];

      if (sendMethodsThatNeedChatId.includes(methodName)) {
        this[methodName] = (...args) => {
          if (args.length === 0 || (typeof args[0] === 'string' && !args[0].match(/^-?\d+$/))) {
            if (defaultChatId) {
              return originalMethod.call(telegramApi, defaultChatId, ...args);
            }
          }
          return originalMethod.call(telegramApi, ...args);
        };
      } else if (editMethodsThatNeedChatIdAndMessageId.includes(methodName)) {
        this[methodName] = (...args) => {
          if (args.length === 0 || (typeof args[0] !== 'number' && typeof args[0] !== 'string')) {
            if (defaultChatId && defaultMessageId) {
              return originalMethod.call(telegramApi, defaultChatId, defaultMessageId, undefined, ...args);
            }
          }
          return originalMethod.call(telegramApi, ...args);
        };
      } else {
        this[methodName] = originalMethod.bind(telegramApi);
      }
    });

    allMethods.forEach(methodName => {
      if (!this.ctx[methodName] && typeof this[methodName] === 'function') {
        this.ctx[methodName] = this[methodName];
      }
    });
  }

  async reply(text, options = {}) {
    try {
      // Support both formats: reply(text, options) and reply({ body, attachment })
      if (typeof text === 'object' && text.body !== undefined) {
        const { body, attachment, ...restOptions } = text;
        if (attachment) {
          return await this.sendAttachment({
            body,
            attachment,
            replyTo: this.ctx.message?.message_id,
            ...restOptions
          });
        }
        text = body;
        options = restOptions;
      }

      const msg = await this.ctx.reply(text, {
        reply_to_message_id: this.ctx.message?.message_id,
        ...options
      });
      return msg;
    } catch (error) {
      if (error.message.includes('not enough rights')) {
        return null;
      }
      console.error('Error in message.reply():', error.message);
      throw error;
    }
  }

  async send(text, chatId = null, options = {}) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      const msg = await this.api.sendMessage(targetChat, text, options);
      return msg;
    } catch (error) {
      if (error.message.includes('not enough rights')) {
        return null;
      }
      console.error('Error in message.send():', error.message);
      throw error;
    }
  }

  async sendPhoto(photo, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendPhoto(chatId, photo, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendPhoto():', error.message);
      throw error;
    }
  }

  async sendVideo(video, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendVideo(chatId, video, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendVideo():', error.message);
      throw error;
    }
  }

  async sendAudio(audio, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendAudio(chatId, audio, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendAudio():', error.message);
      throw error;
    }
  }

  async sendDocument(document, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendDocument(chatId, document, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendDocument():', error.message);
      throw error;
    }
  }

  async sendAnimation(animation, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendAnimation(chatId, animation, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendAnimation():', error.message);
      throw error;
    }
  }

  async sendVoice(voice, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendVoice(chatId, voice, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendVoice():', error.message);
      throw error;
    }
  }

  async sendVideoNote(videoNote, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendVideoNote(chatId, videoNote, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendVideoNote():', error.message);
      throw error;
    }
  }

  async sendMediaGroup(media, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendMediaGroup(chatId, media, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendMediaGroup():', error.message);
      throw error;
    }
  }

  async sendLocation(latitude, longitude, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendLocation(chatId, latitude, longitude, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendLocation():', error.message);
      throw error;
    }
  }

  async sendVenue(latitude, longitude, title, address, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendVenue(chatId, latitude, longitude, title, address, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendVenue():', error.message);
      throw error;
    }
  }

  async sendContact(phoneNumber, firstName, options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendContact(chatId, phoneNumber, firstName, options);
      return msg;
    } catch (error) {
      console.error('Error in message.sendContact():', error.message);
      throw error;
    }
  }

  async sendPoll(question, options, extraOptions = {}) {
    try {
      const chatId = extraOptions.chatId || this.ctx.chat.id;
      const msg = await this.api.sendPoll(chatId, question, options, extraOptions);
      return msg;
    } catch (error) {
      console.error('Error in message.sendPoll():', error.message);
      throw error;
    }
  }

  async sendQuiz(question, options, correctOptionId, extraOptions = {}) {
    try {
      const chatId = extraOptions.chatId || this.ctx.chat.id;
      const msg = await this.api.sendQuiz(chatId, question, options, {
        correct_option_id: correctOptionId,
        ...extraOptions
      });
      return msg;
    } catch (error) {
      console.error('Error in message.sendQuiz():', error.message);
      throw error;
    }
  }

  async sendDice(emoji = '🎲', options = {}) {
    try {
      const chatId = options.chatId || this.ctx.chat.id;
      const msg = await this.api.sendDice(chatId, { emoji, ...options });
      return msg;
    } catch (error) {
      console.error('Error in message.sendDice():', error.message);
      throw error;
    }
  }

  async sendChatAction(action = 'typing') {
    try {
      await this.api.sendChatAction(this.ctx.chat.id, action);
      return true;
    } catch (error) {
      console.error('Error in message.sendChatAction():', error.message);
      return false;
    }
  }

  async forwardMessage(toChatId, fromChatId = null, messageId = null) {
    try {
      const sourceChatId = fromChatId || this.ctx.chat.id;
      const sourceMessageId = messageId || this.ctx.message?.message_id;
      const msg = await this.api.forwardMessage(toChatId, sourceChatId, sourceMessageId);
      return msg;
    } catch (error) {
      console.error('Error in message.forwardMessage():', error.message);
      throw error;
    }
  }

  async copyMessage(toChatId, fromChatId = null, messageId = null, options = {}) {
    try {
      const sourceChatId = fromChatId || this.ctx.chat.id;
      const sourceMessageId = messageId || this.ctx.message?.message_id;
      const msg = await this.api.copyMessage(toChatId, sourceChatId, sourceMessageId, options);
      return msg;
    } catch (error) {
      console.error('Error in message.copyMessage():', error.message);
      throw error;
    }
  }

  async mention(userRef, chatId = null, sendMessage = false) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      let userId = null;
      let mentionText = null;

      if (typeof userRef === "object" && userRef.id) {
        userId = userRef.id;
        mentionText = `[${userRef.first_name || "User"}](tg://user?id=${userId})`;
      }
      else if (/^\d+$/.test(userRef)) {
        userId = parseInt(userRef);
        mentionText = `[User](tg://user?id=${userId})`;
      }
      else if (typeof userRef === "string" && userRef.startsWith("@")) {
        const username = userRef.replace("@", "");
        try {
          const chat = await this.api.getChat(`@${username}`);
          if (chat && chat.id) {
            userId = chat.id;
            mentionText = `[${chat.first_name || username}](tg://user?id=${chat.id})`;
          }
        } catch (err) {
          console.error("❌ Username not found:", username);
        }
      }

      if (!userId) {
        userId = this.ctx.from.id;
        mentionText = `[${this.ctx.from.first_name}](tg://user?id=${userId})`;
      }

      if (sendMessage && mentionText) {
        await this.api.sendMessage(targetChat, `${mentionText}`, {
          parse_mode: "Markdown"
        });
      }

      return {
        userId: userId,
        mentionText: mentionText
      };

    } catch (error) {
      console.error("Error in message.mention():", error.message);
      return null;
    }
  }

  async unsend(messageId, chatId = null) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      await this.api.deleteMessage(targetChat, messageId);
      return true;
    } catch (error) {
      console.error('Error in message.unsend():', error.message);
      return false;
    }
  }

  async react(emoji, messageId = null, isBig = false) {
    try {
      const targetMessageId = messageId || (this.ctx.message?.message_id || this.ctx.callbackQuery?.message?.message_id);
      const targetChatId = this.ctx.chat?.id;

      if (!targetChatId || !targetMessageId) {
        return false;
      }

      if (!emoji || typeof emoji !== 'string' || emoji.trim() === '') {
        return false;
      }

      const reaction = [{ type: 'emoji', emoji: emoji.trim() }];

      await this.api.setMessageReaction(targetChatId, targetMessageId, reaction, isBig || false);
      return true;
    } catch (error) {
      return false;
    }
  }

  async indicator(action = 'typing', duration = 5000) {
    try {
      const validActions = [
        'typing', 'upload_photo', 'record_video', 'upload_video',
        'record_voice', 'upload_voice', 'upload_document', 
        'choose_sticker', 'find_location'
      ];

      const chatAction = validActions.includes(action) ? action : 'typing';

      await this.api.sendChatAction(this.ctx.chat.id, chatAction);

      if (duration > 0) {
        setTimeout(() => {
          this.api.sendChatAction(this.ctx.chat.id, chatAction).catch(() => {});
        }, duration);
      }

      return true;
    } catch (error) {
      console.error('Error in message.indicator():', error.message);
      return false;
    }
  }

  async edit(text, messageId, chatId = null, options = {}) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      await this.api.editMessageText(targetChat, messageId, undefined, text, {
        ...options
      });
      return true;
    } catch (error) {
      if (!error.message.includes('message is not modified')) {
        console.error('Error in message.edit():', error.message);
      }
      return false;
    }
  }

  async editCaption(caption, messageId, chatId = null, options = {}) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      await this.api.editMessageCaption(targetChat, messageId, undefined, caption, {
        ...options
      });
      return true;
    } catch (error) {
      console.error('Error in message.editCaption():', error.message);
      return false;
    }
  }

  async editMedia(media, messageId, chatId = null, options = {}) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      await this.api.editMessageMedia(targetChat, messageId, undefined, media, {
        ...options
      });
      return true;
    } catch (error) {
      console.error('Error in message.editMedia():', error.message);
      return false;
    }
  }

  async editReplyMarkup(markup, messageId, chatId = null) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      await this.api.editMessageReplyMarkup(targetChat, messageId, undefined, markup);
      return true;
    } catch (error) {
      console.error('Error in message.editReplyMarkup():', error.message);
      return false;
    }
  }

  async pin(messageId = null, chatId = null, disableNotification = false) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      const targetMessageId = messageId || this.ctx.message?.message_id;
      await this.api.pinChatMessage(targetChat, targetMessageId, { disable_notification: disableNotification });
      return true;
    } catch (error) {
      console.error('Error in message.pin():', error.message);
      return false;
    }
  }

  async unpin(messageId = null, chatId = null) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      if (messageId) {
        await this.api.unpinChatMessage(targetChat, { message_id: messageId });
      } else {
        await this.api.unpinChatMessage(targetChat);
      }
      return true;
    } catch (error) {
      console.error('Error in message.unpin():', error.message);
      return false;
    }
  }

  async unpinAll(chatId = null) {
    try {
      const targetChat = chatId || this.ctx.chat.id;
      await this.api.unpinAllChatMessages(targetChat);
      return true;
    } catch (error) {
      console.error('Error in message.unpinAll():', error.message);
      return false;
    }
  }

  async sendAttachment(options = {}) {
    try {
      const { body, attachment, chatId, replyTo } = options;
      const targetChat = chatId || this.ctx.chat.id;
      const extraOptions = replyTo ? { reply_to_message_id: replyTo } : {};

      if (!attachment) {
        return await this.api.sendMessage(targetChat, body || '', extraOptions);
      }

      if (Array.isArray(attachment)) {
        const mediaGroup = [];

        for (let i = 0; i < attachment.length; i++) {
          const att = attachment[i];
          let mediaInput;
          let fileName = '';

          if (typeof att === 'string') {
            if (att.startsWith('http://') || att.startsWith('https://')) {
              mediaInput = att;
              fileName = path.basename(att);
            } else if (fs.existsSync(att)) {
              mediaInput = { source: fs.createReadStream(att) };
              fileName = path.basename(att);
            } else {
              throw new Error(`File not found: ${att}`);
            }
          } else {
            mediaInput = { source: att };
            fileName = 'file';
          }

          const ext = path.extname(fileName).toLowerCase();
          const isVideo = ['.mp4', '.avi', '.mov', '.mkv'].includes(ext);

          mediaGroup.push({
            type: isVideo ? 'video' : 'photo',
            media: mediaInput,
            caption: i === 0 ? (body || '') : undefined
          });
        }

        return await this.api.sendMediaGroup(targetChat, mediaGroup, extraOptions);
      }

      let fileStream;
      let fileName;

      if (typeof attachment === 'string') {
        if (attachment.startsWith('http://') || attachment.startsWith('https://')) {
          fileStream = attachment;
          fileName = path.basename(attachment);
        } else if (fs.existsSync(attachment)) {
          fileStream = fs.createReadStream(attachment);
          fileName = path.basename(attachment);
        } else {
          throw new Error('File not found');
        }
      } else {
        fileStream = attachment;
        fileName = 'file';
      }

      const caption = body || '';
      const ext = path.extname(fileName).toLowerCase();

      if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
        return await this.api.sendPhoto(targetChat, 
          typeof fileStream === 'string' ? fileStream : { source: fileStream }, 
          { caption, ...extraOptions }
        );
      } else if (['.mp4', '.avi', '.mov', '.mkv'].includes(ext)) {
        return await this.api.sendVideo(targetChat, 
          typeof fileStream === 'string' ? fileStream : { source: fileStream }, 
          { caption, ...extraOptions }
        );
      } else if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) {
        return await this.api.sendAudio(targetChat, 
          typeof fileStream === 'string' ? fileStream : { source: fileStream }, 
          { caption, ...extraOptions }
        );
      } else {
        return await this.api.sendDocument(targetChat, 
          typeof fileStream === 'string' ? fileStream : { source: fileStream }, 
          { caption, ...extraOptions }
        );
      }
    } catch (error) {
      console.error('Error in message.sendAttachment():', error.message);
      throw error;
    }
  }

  _getContentType(ext) {
    const mimeTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4'
    };
    return mimeTypes[ext.toLowerCase()] || null;
  }

  getAttachment(type = 'any') {
    try {
      const msg = this.ctx.message?.reply_to_message || this.ctx.message;

      if (!msg) return null;

      if (type === 'photo' || type === 'any') {
        if (msg.photo && msg.photo.length > 0) {
          return { type: 'photo', data: msg.photo[msg.photo.length - 1] };
        }
      }

      if (type === 'video' || type === 'any') {
        if (msg.video) {
          return { type: 'video', data: msg.video };
        }
      }

      if (type === 'audio' || type === 'any') {
        if (msg.audio) {
          return { type: 'audio', data: msg.audio };
        }
      }

      if (type === 'document' || type === 'any') {
        if (msg.document) {
          return { type: 'document', data: msg.document };
        }
      }

      if (type === 'voice' || type === 'any') {
        if (msg.voice) {
          return { type: 'voice', data: msg.voice };
        }
      }

      if (type === 'sticker' || type === 'any') {
        if (msg.sticker) {
          return { type: 'sticker', data: msg.sticker };
        }
      }

      if (type === 'animation' || type === 'any') {
        if (msg.animation) {
          return { type: 'animation', data: msg.animation };
        }
      }

      return null;
    } catch (error) {
      console.error('Error in message.getAttachment():', error.message);
      return null;
    }
  }

  async downloadAttachment(attachment, savePath = null) {
    try {
      if (!attachment) return null;

      const fileData = attachment.data || attachment;
      const fileId = fileData.file_id;

      const file = await this.api.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${global.config.token}/${file.file_path}`;

      if (!savePath) {
        const tmpDir = path.join(__dirname, 'tmp');
        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true });
        }
        savePath = path.join(tmpDir, `${Date.now()}_${path.basename(file.file_path)}`);
      }

      const response = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'stream'
      });

      const writer = fs.createWriteStream(savePath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => resolve(savePath));
        writer.on('error', reject);
      });
    } catch (error) {
      console.error('Error in message.downloadAttachment():', error.message);
      throw error;
    }
  }
}

function getTime(timezone = null) {
  const tz = timezone || global.config.timezone || 'Asia/Dhaka';
  return moment().tz(tz).format('YYYY-MM-DD HH:mm:ss');
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  let result = [];
  if (days > 0) result.push(`${days}d`);
  if (hours > 0) result.push(`${hours}h`);
  if (minutes > 0) result.push(`${minutes}m`);
  if (secs > 0) result.push(`${secs}s`);

  return result.join(' ') || '0s';
}

function checkPermission(userId, role, chatId = null) {
  if (role === 0) return true;
  if (role === 2) return global.config.adminUID.includes(userId);
  if (role === 1) {
    const isOwner = global.config.adminUID.includes(userId);
    if (isOwner) return true;

    if (chatId && global.ST.threadAdmins.has(chatId)) {
      const cached = global.ST.threadAdmins.get(chatId);
      const chatAdmins = cached.admins || [];
      return chatAdmins.includes(userId);
    }
    return false;
  }
  return false;
}


function randomString(length = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getExtFromMimeType(mimeType) {
  const mimeMap = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/avi': 'avi',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'text/plain': 'txt'
  };
  return mimeMap[mimeType] || 'bin';
}

async function getStreamFromURL(url = '', pathName = '', options = {}) {
  if (!options && typeof pathName === 'object') {
    options = pathName;
    pathName = '';
  }
  try {
    if (!url || typeof url !== 'string') {
      throw new Error('The first argument (url) must be a string');
    }

    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      ...options
    });

    if (!pathName) {
      const ext = response.headers['content-type'] ? getExtFromMimeType(response.headers['content-type']) : 'noext';
      pathName = randomString(10) + '.' + ext;
    }

    response.data.path = pathName;
    return response.data;
  } catch (err) {
    throw err;
  }
}

async function downloadFile(url, savePath = null) {
  try {
    if (!savePath) {
      const tmpDir = path.join(__dirname, 'tmp');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      savePath = path.join(tmpDir, `${randomString(10)}_${path.basename(url)}`);
    }

    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(savePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(savePath));
      writer.on('error', reject);
    });
  } catch (error) {
    throw new Error(`Failed to download file: ${error.message}`);
  }
}


async function shortenURL(url) {
  try {
    const result = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    return result.data;
  }
  catch (err) {
    let error;
    if (err.response) {
      error = new Error();
      Object.assign(error, err.response.data);
    }
    else
      error = new Error(err.message);
  }
}

async function uploadImgbb(file /* stream or image url */) {
  let type = "file";
  try {
    if (!file)
      throw new Error('The first argument (file) must be a stream or a image url');
    if (regCheckURL.test(file) == true)
      type = "url";
    if (
      (type != "url" && (!(typeof file._read === 'function' && typeof file._readableState === 'object')))
      || (type == "url" && !regCheckURL.test(file))
    )
      throw new Error('The first argument (file) must be a stream or an image URL');

    const res_ = await axios({
      method: 'GET',
      url: 'https://imgbb.com'
    });

    const auth_token = res_.data.match(/auth_token="([^"]+)"/)[1];
    const timestamp = Date.now();

    const res = await axios({
      method: 'POST',
      url: 'https://imgbb.com/json',
      headers: {
        "content-type": "multipart/form-data"
      },
      data: {
        source: file,
        type: type,
        action: 'upload',
        timestamp: timestamp,
        auth_token: auth_token
      }
    });

    return res.data;
  }
  catch (err) {
    throw new CustomError(err.response ? err.response.data : err);
  }
}

async function fetchUserData(api, userId) {
  try {
    userId = String(userId);
    const user = await global.db.getUser(userId);

    try {
      const chat = await api.getChat(userId);
      let pfpUrl = user.pfpUrl || '';

      try {
        const photos = await api.getUserProfilePhotos(userId, { limit: 1 });
        if (photos.photos && photos.photos.length > 0) {
          const photo = photos.photos[0][photos.photos[0].length - 1];
          const file = await api.getFile(photo.file_id);
          pfpUrl = `https://api.telegram.org/file/bot${global.config.token}/${file.file_path}`;
        }
      } catch (pfpError) {
      }

      await global.db.updateUser(userId, {
        firstName: chat.first_name || '',
        lastName: chat.last_name || '',
        username: chat.username || '',
        pfpUrl: pfpUrl
      });

      return await global.db.getUser(userId);
    } catch (error) {
      return user;
    }
  } catch (error) {
    throw new Error(`Failed to fetch user data: ${error.message}`);
  }
}

class dipapis {
  constructor() {
    this.baseURL = "https://www.noobs-api.rf.gd/dipto";
  }
}



async function getStreamsFromAttachment(attachments) {
  const streams = [];

  for (const attachment of attachments) {
    try {
      const fileId = attachment.file_id || attachment.data?.file_id;
      if (!fileId) continue;

      const file = await global.bot.telegram.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${global.config.token}/${file.file_path}`;

      const response = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'stream'
      });

      streams.push(response.data);
    } catch (error) {
      console.error('Error getting stream from attachment:', error.message);
    }
  }

  return streams;
}

async function getUrlToSharpStream(url, options = {}) {
  let tempInputPath = null;

  try {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    tempInputPath = path.join(tmpDir, `temp_${randomString(10)}_input`);

    // Download the image
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(tempInputPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Convert to WebP buffer directly without saving to file
    const buffer = await sharp(tempInputPath)
      .webp({ quality: options.quality || 90 })
      .toBuffer();

    // Clean up temporary input file
    if (tempInputPath && fs.existsSync(tempInputPath)) {
      fs.unlinkSync(tempInputPath);
    }

    return buffer;
  } catch (error) {
    // Clean up on error
    if (tempInputPath && fs.existsSync(tempInputPath)) {
      fs.unlinkSync(tempInputPath);
    }
    throw new Error(`Failed to convert image to WebP: ${error.message}`);
  }
}

module.exports = {
  MessageUtils,
  getTime,
  formatUptime,
  checkPermission,
  shortenURL,
  uploadImgbb,
  getStreamFromURL,
  downloadFile,
  randomString,
  fetchUserData,
  dipapis,
  getStreamsFromAttachment,
  getExtFromMimeType,
  getUrlToSharpStream,
  Markup
};
