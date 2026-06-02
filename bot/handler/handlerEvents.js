const { MessageUtils, checkPermission } = require('../../utils');

async function sendBotStartNotification(api) {
  try {
    const config = global.config.botStartNotification;

    if (!config || !config.enabled) {
      return;
    }

    const moment = require('moment-timezone');
    const timezone = global.config.timezone || 'Asia/Dhaka';
    const startTime = moment().tz(timezone).format('YYYY-MM-DD HH:mm:ss');

    const notificationMessage = 
      `🤖 Bot Started Successfully!\n\n` +
      `✅ Status: Online\n` +
      `⏰ Time: ${startTime}\n` +
      `🌐 Timezone: ${timezone}\n` +
      `📍 Prefix: ${global.config.prefix}\n` +
      `👑 Bot Name: ${global.config.botName}`;

    // Send to admins
    if (config.sendToAdmins && global.config.adminUID && global.config.adminUID.length > 0) {
      for (const adminId of global.config.adminUID) {
        try {
          await api.sendMessage(adminId, notificationMessage);
          global.log.success(`Bot start notification sent to admin: ${adminId}`);
        } catch (error) {
          global.log.error(`Failed to send notification to admin ${adminId}: ${error.message}`);
        }
      }
    }

    // Send to specific threads
    if (config.sendToThreads && config.threadIds && config.threadIds.length > 0) {
      for (const threadId of config.threadIds) {
        try {
          await api.sendMessage(threadId, notificationMessage);
          global.log.success(`Bot start notification sent to thread: ${threadId}`);
        } catch (error) {
          global.log.error(`Failed to send notification to thread ${threadId}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    global.log.error('Error sending bot start notification:', error.message);
  }
}

async function fetchChatAdmins(ctx, chatId) {
  try {
    if (global.ST.threadAdmins.has(chatId)) {
      const cached = global.ST.threadAdmins.get(chatId);
      if (cached.timestamp && Date.now() - cached.timestamp < 300000) {
        return cached.admins;
      }
    }

    const admins = await ctx.telegram.getChatAdministrators(chatId);
    const adminIds = admins.map(admin => admin.user.id);

    global.ST.threadAdmins.set(chatId, {
      admins: adminIds,
      timestamp: Date.now()
    });

    return adminIds;
  } catch (error) {
    // Silently handle bot kicked errors
    if (error.message.includes('bot was kicked') ||
        error.message.includes('bot is not a member') ||
        error.message.includes('chat not found')) {
      global.ST.threadAdmins.delete(String(chatId));
      return [];
    }
    global.log.error('Error fetching chat admins:', error.message);
    return [];
  }
}

async function handleMessage(ctx) {
  try {
    const msg = ctx.message || ctx.editedMessage;
    if (!msg) return;

    // Detect and log event type
    const eventType = detectEventType(ctx);

    // Log ALL user messages immediately at the start
    if (msg.from && !msg.from.is_bot) {
      logUserMessage(msg, eventType);
    }

    // Ignore old messages if enabled
    if (global.config.ignoreOldMessages?.enabled && global.botStartTime) {
      const messageDate = msg.date;
      if (messageDate < global.botStartTime) {
        return; // Skip old messages
      }
    }

    // Don't skip media messages - they should be tracked
    const hasContent = msg.text || msg.caption || msg.photo || msg.video || msg.audio || msg.voice || msg.document || msg.sticker;
    if (!hasContent) {
      return;
    }

    global.bot = ctx.telegram;

    const event = msg;
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const messageText = (msg.text || msg.caption || '').trim();

    // Handle channel posts (no msg.from in channels)
    if (!msg.from) {
      return;
    }

    // Check if user is banned
    if (global.db && userId) {
      const isBanned = await global.db.isUserBanned(String(userId));
      if (isBanned) {
        return; // Silently ignore banned users
      }
    }

    // 🎯 CRITICAL: Track EVERY message (commands, replies, chat) FIRST
    if (!msg.from.is_bot && global.ST.events) {
      const message = new MessageUtils(ctx);
      const detectedEventType = detectEventType(ctx);

      for (const [eventName, event] of global.ST.events) {
        // Run events that match the detected type OR are generic 'message' handlers
        const eventTypeMatches = event.config.eventType === detectedEventType || 
                                  (event.config.eventType === 'message' && detectedEventType === 'message') ||
                                  event.config.eventType === 'all';

        if (eventTypeMatches && event.ST) {
          try {
            await event.ST({
              event: msg,
              api: ctx.telegram,
              message,
              ctx,
              eventType: detectedEventType
            });
          } catch (error) {
            global.log.error(`Error in ${eventName} event:`, error.message);
          }
        }
      }
    }

    // Check DM approval
    if (msg.chat.type === 'private' && global.config.dmApproval?.enabled) {
      if (!global.config.adminUID.includes(String(userId))) {
        const user = await global.db.getUser(String(userId));
        if (!user.dmApproved) {
          // Check if user already requested approval
          const existingApprovals = await global.db.getAllApprovals('dm');
          const hasRequested = existingApprovals.some(a => a.userId === String(userId));

          if (!hasRequested) {
            // Create approval request
            const approvalId = await global.db.addApproval('dm', {
              userId: String(userId),
              userName: msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : ''),
              username: msg.from.username || 'No username'
            });

            const message = new MessageUtils(ctx);
            await message.reply(
              `⏳ Your DM request is pending approval.\n\n` +
              `Please wait for the bot admin to approve your request.\n` +
              `Contact: ${global.config.ownerName}\n\n` +
              `You will be notified once approved.`
            );

            // Notify admins
            for (const adminId of global.config.adminUID) {
              try {
                await ctx.telegram.sendMessage(
                  adminId,
                  `🔔 New DM Approval Request\n\n` +
                  `👤 Name: ${msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '')}\n` +
                  `📝 Username: @${msg.from.username || 'No username'}\n` +
                  `🆔 User ID: ${userId}\n` +
                  `🕐 Time: ${new Date().toLocaleString()}\n\n` +
                  `Contact them: @${msg.from.username || userId}`,
                  {
                    reply_markup: {
                      inline_keyboard: [[
                        { text: '✅ Approve', callback_data: `approve_dm_${approvalId}` },
                        { text: '❌ Reject & Ban', callback_data: `reject_dm_${approvalId}` }
                      ]]
                    }
                  }
                );
              } catch (err) {
                global.log.error(`Failed to send DM approval to admin ${adminId}`);
              }
            }
          }
          return;
        }
      }
    }

    // Check group approval
    if ((msg.chat.type === 'group' || msg.chat.type === 'supergroup') && global.config.groupApproval?.enabled) {
      const thread = await global.db.getThread(String(chatId));
      if (!thread.approved && !global.config.adminUID.includes(String(userId))) {
        return; // Silently ignore messages in unapproved groups
      }
    }

    if (!global.config.allowInboxMode && msg.chat.type === 'private') {
      return;
    }

    // Initialize message utility first
    const message = new MessageUtils(ctx);
    global.message = message;

    // Check if user sends just "prefix" word
    if (messageText.toLowerCase() === 'prefix' && global.config.usePrefix) {
      let prefixInfo = `⚙️ Prefix Information:\n\n📍 Global Prefix: ${global.config.prefix}`;

      // Show custom prefix if in group and custom prefix exists
      if (chatId && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')) {
        const thread = await global.db.getThread(String(chatId));
        if (thread.customPrefix) {
          prefixInfo += `\n📍 This Group Prefix: ${thread.customPrefix}`;
        } else {
          prefixInfo += `\n📍 This Group Prefix: ${global.config.prefix} (default)`;
        }
      }

      prefixInfo += `\n\n💡 Use prefix command (${global.config.prefix}prefix) to change group prefix`;
      return message.reply(prefixInfo);
    }

    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
      await fetchChatAdmins(ctx, chatId);
    }

    if (msg.reply_to_message && msg.reply_to_message.from.is_bot) {
      const replyData = global.ST.onReply.get(msg.reply_to_message.message_id);
      console.log(`🔍 [HANDLER] Checking onReply for message ${msg.reply_to_message.message_id}`);
      console.log(`🔍 [HANDLER] Reply data found:`, replyData ? `Yes (${replyData.commandName})` : 'No');

      if (replyData) {
        const command = global.ST.commands.get(replyData.commandName);
        if (command && command.onReply) {
          console.log(`✅ [HANDLER] Executing onReply for command: ${replyData.commandName}`);
          await command.onReply({
            event: msg,
            api: ctx.telegram,
            Reply: replyData,
            args: messageText.split(' '),
            message,
            ctx
          });
        }
        return;
      }
    }

    const globalUsePrefix = global.config.usePrefix;
    let prefix = global.config.prefix;

    // Check for custom prefix in this chat
    if (global.config.allowCustomPrefix && chatId) {
      const thread = await global.db.getThread(String(chatId));
      if (thread.customPrefix) {
        prefix = thread.customPrefix;
      }
    }

    let commandName = '';
    let args = [];
    let isCommand = false;
    let isCommandAttempt = false;

    // First, try to detect command with prefix
    if (messageText.startsWith(prefix)) {
      const parts = messageText.slice(prefix.length).trim().split(' ');
      let potentialCommand = parts[0].toLowerCase();

      // Strip @botname mention from command (Telegram groups add this)
      if (potentialCommand.includes('@')) {
        potentialCommand = potentialCommand.split('@')[0];
      }

      commandName = potentialCommand;
      args = parts.slice(1);
      isCommandAttempt = true;

      // Check if command exists and if it uses prefix
      const command = global.ST.commands.get(commandName);
      if (command) {
        const commandUsePrefix = command.config.usePrefix !== undefined ? command.config.usePrefix : globalUsePrefix;
        if (commandUsePrefix) {
          isCommand = true;
        }
      }
    }

    // If no command found with prefix, try without prefix
    if (!isCommand && messageText && !messageText.startsWith(prefix)) {
      const parts = messageText.trim().split(' ');
      let potentialCommand = parts[0].toLowerCase();

      // Strip @botname mention from command (Telegram groups add this)
      if (potentialCommand.includes('@')) {
        potentialCommand = potentialCommand.split('@')[0];
      }

      const command = global.ST.commands.get(potentialCommand);

      if (command) {
        const commandUsePrefix = command.config.usePrefix !== undefined ? command.config.usePrefix : globalUsePrefix;
        if (!commandUsePrefix) {
          commandName = potentialCommand;
          args = parts.slice(1);
          isCommand = true;
        }
      }
    }

    if (messageText === '/start' && msg.chat.type === 'private') {
      const commands = Array.from(global.ST.commands.values());
      const uniqueCommands = [...new Map(commands.map(cmd => [cmd.config.name, cmd])).values()];

      const categories = {};
      uniqueCommands.forEach(cmd => {
        const category = cmd.config.category || 'general';
        if (!categories[category]) categories[category] = [];
        categories[category].push(cmd.config.name);
      });

      let startText = `👋 Welcome to ${global.config.botName}!\n\n`;
      startText += `📚 Available Commands (${uniqueCommands.length}):\n\n`;

      for (const [category, cmds] of Object.entries(categories)) {
        startText += `📂 ${category.toUpperCase()}\n`;
        startText += cmds.map(cmd => `  • ${prefix}${cmd}`).join('\n');
        startText += `\n\n`;
      }

      startText += `💡 Use ${prefix}help <command> for details\n`;
      startText += `⚙️ Prefix: ${prefix}\n`;
      startText += `👑 Owner: ${global.config.ownerName}`;

      return message.reply(startText);
    }

    // Show error message when user types just the prefix
    if (messageText === prefix && globalUsePrefix) {
      await message.reply(`❌ Command does not exist.\n\n💡 Use ${prefix}help to see all available commands.`);
      return;
    }

    if (isCommandAttempt && !commandName) {
      await message.reply(`❌ Command does not exist.\n\n💡 Use ${prefix}help to see all available commands.`);
      return;
    }

    if (commandName) {
      const command = global.ST.commands.get(commandName);

      if (!command && isCommandAttempt) {
        await message.reply(`❌ Command "${commandName}" does not exist.\n\n💡 Use ${prefix}help to see all available commands.`);
        return;
      }

      if (command) {
        const userName = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');

        if (global.config.onlyAdmin && !global.config.adminUID.includes(String(userId))) {
          const adminMessage = global.config.onlyAdminMessage || '⚠️ This bot is in admin-only mode. Only admins can use commands.';
          return message.reply(adminMessage);
        }

        if (!checkPermission(String(userId), command.config.role || 0, chatId)) {
          return message.reply('⚠️ You do not have permission to use this command.');
        }

        const cooldownKey = `${userId}_${command.config.name}`;
        const now = Date.now();
        const cooldownAmount = (command.config.cooldown || 0) * 1000;

        if (global.ST.cooldowns.has(cooldownKey)) {
          const expirationTime = global.ST.cooldowns.get(cooldownKey) + cooldownAmount;

          if (now < expirationTime) {
            const timeLeft = ((expirationTime - now) / 1000).toFixed(1);
            return message.reply(`⏳ Please wait ${timeLeft}s before using this command again.`);
          }
        }

        global.ST.cooldowns.set(cooldownKey, now);
        setTimeout(() => global.ST.cooldowns.delete(cooldownKey), cooldownAmount);

        try {
          if (command.ST) {
            await command.ST({
              event: msg,
              api: ctx.telegram,
              args,
              message,
              chatId,
              userId,
              ctx,
              db: global.db,
              // Additional aliases for flexibility
              telegram: ctx.telegram,
              bot: ctx.telegram
            });
            global.log.commandExecution(msg.from, msg.chat, commandName, true);
          }
        } catch (error) {
          // Don't log permission errors
          if (!error.message.includes('not enough rights')) {
            global.log.commandExecution(msg.from, msg.chat, commandName, false, error.message);
            message.reply(`❌ Error: ${error.message}`);
          }
        }
        return;
      }
    }

    // Run onChat handlers - only if not a command attempt and message has text
    if (!msg.from.is_bot && !isCommandAttempt && messageText) {
      const { commands } = global.ST;
      for (const [commandName, command] of commands.entries()) {
        if (command.onChat && typeof command.onChat === 'function') {
          try {
            const shouldContinue = await command.onChat({
              bot: ctx.telegram,
              message,
              msg,
              chatId,
              args: messageText.split(' '),
              db: global.db,
              ctx
            });
            if (shouldContinue === false) {
              break;
            }
          } catch (error) {
            // Silently handle onChat errors
          }
        }
      }
    }

  } catch (error) {
    global.log.error('Error in handleMessage:', error);
  }
}

// Detect event type from context
function detectEventType(ctx) {
  const msg = ctx.message || ctx.editedMessage || ctx.update;

  if (ctx.editedMessage) return 'message_edit';
  if (ctx.channelPost) return 'channel_post';
  if (ctx.editedChannelPost) return 'channel_post_edit';
  if (ctx.messageReaction) return 'reaction';
  if (ctx.callbackQuery) return 'callback_query';
  if (msg?.new_chat_members) return 'new_member';
  if (msg?.left_chat_member) return 'left_member';
  if (msg?.new_chat_title) return 'chat_title_changed';
  if (msg?.new_chat_photo) return 'chat_photo_changed';
  if (msg?.delete_chat_photo) return 'chat_photo_deleted';
  if (msg?.group_chat_created) return 'group_created';
  if (msg?.supergroup_chat_created) return 'supergroup_created';
  if (msg?.channel_chat_created) return 'channel_created';
  if (msg?.pinned_message) return 'message_pinned';
  if (msg?.voice_chat_started) return 'voice_chat_started';
  if (msg?.voice_chat_ended) return 'voice_chat_ended';
  if (msg?.poll) return 'poll';
  if (msg?.dice) return 'dice';

  return 'message';
}

// Log all user messages to console with detailed info
async function logUserMessage(msg, eventType = 'message') {
  try {
    if (!msg.from || msg.from.is_bot) return;

    const userName = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');
    const chatName = msg.chat.title || 'Private Chat';
    const chatType = msg.chat.type;
    let messageText = msg.text || msg.caption || '';

    // Detect message type
    let messageType = 'text';
    if (msg.photo) messageType = '📷 Photo';
    else if (msg.video) messageType = '🎥 Video';
    else if (msg.audio) messageType = '🎵 Audio';
    else if (msg.voice) messageType = '🎤 Voice';
    else if (msg.document) messageType = '📄 Document';
    else if (msg.sticker) messageType = '😀 Sticker';
    else if (msg.animation) messageType = '🎬 GIF';

    if (!messageText && messageType !== 'text') {
      messageText = `[${messageType}]`;
    } else if (messageText) {
      messageText = messageText.substring(0, 80);
    } else {
      messageText = '[Unknown message type]';
    }

    const moment = require('moment-timezone');
    const timezone = global.config.timezone || 'Asia/Dhaka';
    const localTime = moment().tz(timezone).format('YYYY-MM-DD HH:mm:ss');
  } catch (error) {
    // Silent error handling
  }
}

async function handleCallback(ctx) {
  try {
    const query = ctx.callbackQuery;
    const data = query.data;

    // Handle spain slot machine callbacks
    if (data && data.startsWith('spain_again_')) {
      const command = global.ST.commands.get('spain');
      if (command && command.onCallback) {
        const message = new MessageUtils(ctx);
        await command.onCallback({
          event: query,
          api: ctx.telegram,
          message,
          ctx
        });
      }
      return;
    }

    // Handle unban request callbacks
    if (data.startsWith('approve_unban_') || data.startsWith('reject_unban_')) {
      const parts = data.split('_');
      const action = parts[0];
      const requestId = parts.slice(2).join('_');

      const request = await global.db.getApproval(requestId);

      if (!request) {
        await ctx.answerCbQuery('❌ Request not found or already processed');
        return;
      }

      const user = await global.db.getUser(request.userId);
      const userName = user.firstName || 'Unknown';

      if (action === 'approve') {
        await global.db.unbanUser(request.userId);
        await global.db.removeApproval(requestId);

        await ctx.editMessageText(
          `✅ Unban Request Approved!\n\n` +
          `👤 User: ${userName}\n` +
          `🆔 User ID: ${request.userId}\n` +
          `📝 Reason: ${request.reason}\n` +
          `✓ Approved by: ${query.from.first_name}`
        );

        try {
          await ctx.telegram.sendMessage(
            request.userId,
            `🎉 Great news!\n\n` +
            `✅ Your unban request has been approved!\n` +
            `You can now use the bot again.\n\n` +
            `Type ${global.config.prefix}help to see all available commands.`
          );
        } catch (err) {
          // User might have blocked the bot
        }

        await ctx.answerCbQuery('✅ User unbanned successfully!');
      } else if (action === 'reject') {
        await global.db.removeApproval(requestId);

        await ctx.editMessageText(
          `❌ Unban Request Rejected\n\n` +
          `👤 User: ${userName}\n` +
          `🆔 User ID: ${request.userId}\n` +
          `📝 Reason: ${request.reason}\n` +
          `✗ Rejected by: ${query.from.first_name}`
        );

        try {
          await ctx.telegram.sendMessage(
            request.userId,
            `❌ Your unban request was rejected.\n\nYou remain banned from using this bot.`
          );
        } catch (err) {
          // User might have blocked the bot
        }

        await ctx.answerCbQuery('❌ Request rejected');
      }
      return;
    }

    // Handle approval callbacks
    if (data.startsWith('approve_group_') || data.startsWith('reject_group_')) {
      const parts = data.split('_');
      const action = parts[0];
      const approvalId = parts.slice(2).join('_');

      const approval = await global.db.getApproval(approvalId);

      if (!approval) {
        await ctx.answerCbQuery('❌ Approval request not found or already processed');
        return;
      }

      if (action === 'approve') {
        await global.db.updateThread(approval.chatId, { approved: true });
        await global.db.removeApproval(approvalId);

        await ctx.editMessageText(
          `✅ Group Approved!\n\n` +
          `📂 Group: ${approval.chatName}\n` +
          `🆔 Chat ID: ${approval.chatId}\n` +
          `👤 Added by: ${approval.addedByName}\n` +
          `✓ Approved by: ${query.from.first_name}`
        );

        try {
          await ctx.telegram.sendMessage(
            approval.chatId,
            `🎉 Great news!\n\n` +
            `✅ This group has been approved by the bot admin.\n` +
            `I'm now ready to serve this group!\n\n` +
            `Type ${global.config.prefix}help to see all available commands.`
          );
        } catch (err) {
          // Group might be inaccessible
        }

        await ctx.answerCbQuery('✅ Group approved successfully!');
      } else if (action === 'reject') {
        await global.db.removeApproval(approvalId);

        await ctx.editMessageText(
          `❌ Group Rejected\n\n` +
          `📂 Group: ${approval.chatName}\n` +
          `🆔 Chat ID: ${approval.chatId}\n` +
          `👤 Added by: ${approval.addedByName}\n` +
          `✗ Rejected by: ${query.from.first_name}`
        );

        try {
          await ctx.telegram.sendMessage(
            approval.chatId,
            `❌ Sorry, this group was not approved by the bot admin.\n\nThe bot will now leave this group.`
          );
          await ctx.telegram.leaveChat(approval.chatId);
        } catch (err) {
          // Group might be inaccessible
        }

        await ctx.answerCbQuery('❌ Group rejected and bot left');
      }
      return;
    }

    if (data.startsWith('approve_dm_') || data.startsWith('reject_dm_')) {
      const parts = data.split('_');
      const action = parts[0];
      const approvalId = parts.slice(2).join('_');

      const approval = await global.db.getApproval(approvalId);

      if (!approval) {
        await ctx.answerCbQuery('❌ Approval request not found or already processed');
        return;
      }

      if (action === 'approve') {
        await global.db.updateUser(approval.userId, { dmApproved: true });
        await global.db.removeApproval(approvalId);

        await ctx.editMessageText(
          `✅ DM Approved!\n\n` +
          `👤 User: ${approval.userName}\n` +
          `🆔 User ID: ${approval.userId}\n` +
          `✓ Approved by: ${query.from.first_name}`
        );

        try {
          await ctx.telegram.sendMessage(
            approval.userId,
            `🎉 Great news!\n\n` +
            `✅ Your DM access has been approved!\n` +
            `You can now use the bot in private messages.\n\n` +
            `Type ${global.config.prefix}help to see all available commands.`
          );
        } catch (err) {
          // User might have blocked the bot
        }

        await ctx.answerCbQuery('✅ DM access approved!');
      } else if (action === 'reject') {
        await global.db.banUser(approval.userId, 'DM access rejected', String(query.from.id));
        await global.db.removeApproval(approvalId);

        await ctx.editMessageText(
          `❌ DM Rejected & User Banned\n\n` +
          `👤 User: ${approval.userName}\n` +
          `🆔 User ID: ${approval.userId}\n` +
          `✗ Rejected by: ${query.from.first_name}`
        );

        try {
          await ctx.telegram.sendMessage(
            approval.userId,
            `❌ Sorry, your DM access was rejected.\n\nYou have been banned from using this bot.`
          );
        } catch (err) {
          // User might have blocked the bot
        }

        await ctx.answerCbQuery('❌ DM rejected and user banned');
      }
      return;
    }

    // Handle MJ/Niji button callbacks
    if (data.startsWith('mj_btn_') || data.startsWith('niji_btn_')) {
      const commandName = data.startsWith('mj_btn_') ? 'mj' : 'niji';
      const command = global.ST.commands.get(commandName);

      if (command && command.onCallback) {
        const message = new MessageUtils(ctx);
        await command.onCallback({
          event: query,
          api: ctx.telegram,
          message,
          ctx
        });
      }
      return;
    }

    // Handle other callbacks stored in global.ST.onCallback
    if (global.ST.onCallback.has(data)) {
      const callbackData = global.ST.onCallback.get(data);
      const command = global.ST.commands.get(callbackData.commandName);

      if (command && command.onCallback) {
        const message = new MessageUtils(ctx);
        await command.onCallback({
          event: query,
          api: ctx.telegram,
          message,
          callbackData,
          ctx
        });
      }
      return;
    }

  } catch (error) {
    global.log.error('Error in handleCallback:', error);
  }
}

async function handleNewMember(ctx) {
  try {
    const msg = ctx.message;
    const newMembers = msg.new_chat_members;

    if (!newMembers || newMembers.length === 0) return;

    const message = new MessageUtils(ctx);

    // Run new_member event handlers
    if (global.ST.events) {
      for (const [eventName, event] of global.ST.events) {
        if (event.config.eventType === 'new_member' && event.ST) {
          try {
            await event.ST({
              event: msg,
              api: ctx.telegram,
              message,
              newMembers,
              ctx
            });
          } catch (error) {
            global.log.error(`Error in ${eventName} event:`, error.message);
          }
        }
      }
    }
  } catch (error) {
    global.log.error('Error in handleNewMember:', error);
  }
}

async function handleLeftMember(ctx) {
  try {
    const msg = ctx.message;
    const leftMember = msg.left_chat_member;

    if (!leftMember) return;

    const message = new MessageUtils(ctx);

    // Run left_member event handlers
    if (global.ST.events) {
      for (const [eventName, event] of global.ST.events) {
        if (event.config.eventType === 'left_member' && event.ST) {
          try {
            await event.ST({
              event: msg,
              api: ctx.telegram,
              message,
              leftMember,
              ctx
            });
          } catch (error) {
            global.log.error(`Error in ${eventName} event:`, error.message);
          }
        }
      }
    }
  } catch (error) {
    global.log.error('Error in handleLeftMember:', error);
  }
}

async function handleReaction(ctx) {
  try {
    const reaction = ctx.messageReaction;

    if (!reaction) return;

    const messageId = reaction.message_id;
    const chatId = reaction.chat.id;
    const userId = reaction.user.id;

    // Check admin reaction unsend feature
    if (global.config.adminReactionUnsend?.enabled) {
      const isAdmin = global.config.adminUID.includes(String(userId));

      if (isAdmin && reaction.new_reaction && reaction.new_reaction.length > 0) {
        const reactionEmojis = reaction.new_reaction
          .filter(r => r.type === 'emoji')
          .map(r => r.emoji);

        const unsendEmoji = global.config.adminReactionUnsend.emoji || '👎';


        if (reactionEmojis.includes(unsendEmoji)) {

          try {
            await ctx.telegram.deleteMessage(chatId, messageId);

            return;
          } catch (error) {
            if (error.message.includes('message to delete not found')) {

            } else if (error.message.includes('not enough rights')) {

            } else {
            }
          }
        } else {
        }
      }
    }

    // Run reaction event handlers
    if (global.ST.events) {
      for (const [eventName, event] of global.ST.events) {
        if (event.config.eventType === 'reaction' && event.ST) {
          try {
            await event.ST({
              event: reaction,
              api: ctx.telegram,
              ctx
            });
          } catch (error) {
            global.log.error(`Error in ${eventName} event:`, error.message);
          }
        }
      }
    }

    // Check onReaction handlers in commands
    if (global.ST.onReaction.size > 0) {
      for (const [commandName, handler] of global.ST.onReaction) {
        try {
          await handler({
            reaction,
            api: ctx.telegram,
            messageId,
            chatId,
            userId,
            ctx
          });
        } catch (error) {
          global.log.error(`Error in ${commandName} onReaction:`, error.message);
        }
      }
    }
  } catch (error) {
    global.log.error('Error in handleReaction:', error);
  }
}

module.exports = {
  handleMessage,
  handleCallback,
  handleNewMember,
  handleLeftMember,
  handleReaction,
  sendBotStartNotification
};
