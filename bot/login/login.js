const { Telegraf } = require('telegraf');
const handleEvents = require('../handler/handlerEvents');
const fs = require('fs');
const path = require('path');
const { showCopyright } = require('../../logger/banner');

async function login() {
  try {
    // Show copyright message
    showCopyright();

    // Check if previous update was successful
    const updateSuccessFile = path.join(__dirname, '..', '..', 'tmp', 'last_update_success.txt');
    const packageVersion = require('../../package.json').version;

    if (fs.existsSync(updateSuccessFile)) {
      const lastSuccessVersion = fs.readFileSync(updateSuccessFile, 'utf-8').trim();
      if (lastSuccessVersion !== packageVersion) {
        global.log.warn('⚠️ Update verification failed, version mismatch detected');
        global.log.info('🔄 Initiating automatic restore...');

        try {
          const { autoRestore } = require('../../restoreBackup');
          autoRestore();
          global.log.success('✅ Auto-restore completed, restarting bot...');
          process.exit(2);
        } catch (restoreError) {
          global.log.error('❌ Auto-restore failed:', restoreError.message);
        }
      }
    }

    const token = global.config.token;

    // Initialize Telegraf bot
    const bot = new Telegraf(token);

    global.bot = bot;
    global.botStartTime = Math.floor(Date.now() / 1000); // Track when bot started

    // Add ctx.react() helper globally
    bot.use(async (ctx, next) => {
      ctx.react = async (emoji, isBig = false) => {
        try {
          const messageId = ctx.message?.message_id || ctx.callbackQuery?.message?.message_id;
          const chatId = ctx.chat?.id;

          if (!chatId || !messageId) return false;

          const reaction = [{ type: 'emoji', emoji: emoji.trim() }];
          await ctx.telegram.setMessageReaction(chatId, messageId, reaction, isBig);
          return true;
        } catch (error) {
          return false;
        }
      };
      await next();
    });

    // Error handling middleware
    bot.catch((err, ctx) => {
      global.log.error('Bot error:', err.message);
    });

    // Handle polling errors
    bot.telegram.webhookReply = false;

    // Message handler
    bot.on('message', async (ctx) => {
      await handleEvents.handleMessage(ctx);
    });

    // Callback query handler
    bot.on('callback_query', async (ctx) => {
      await handleEvents.handleCallback(ctx);
    });

    // New chat members handler
    bot.on('new_chat_members', async (ctx) => {
      await handleEvents.handleNewMember(ctx);
    });

    // Left chat member handler
    bot.on('left_chat_member', async (ctx) => {
      await handleEvents.handleLeftMember(ctx);
    });

    // Message reaction handler
    bot.on('message_reaction', async (ctx) => {
      await handleEvents.handleReaction(ctx);
    });

    // Check for updates FIRST
    try {
      const axios = require('axios');
      const currentVersion = require('../../package.json').version;
      const { data: versions } = await axios.get('https://raw.githubusercontent.com/sheikhtamimlover/STG_Telegraf/main/version.json');
      const indexCurrentVersion = versions.findIndex(v => v.version === currentVersion);

      if (indexCurrentVersion !== -1) {
        const versionsNeedToUpdate = versions.slice(indexCurrentVersion + 1);
        if (versionsNeedToUpdate.length > 0) {
          const c = require('../../logger/color');

          // Check if update was just published (within 5 minutes)
          const latestVersion = versions[versions.length - 1];
          if (latestVersion.publishedAt) {
            const publishTime = new Date(latestVersion.publishedAt).getTime();
            const currentTime = Date.now();
            const timeDiff = currentTime - publishTime;
            const minutesAgo = Math.floor(timeDiff / 60000);

            if (timeDiff < 5 * 60 * 1000) {
              const waitMinutes = 5 - minutesAgo;
              console.log(c.yellow(`⏳ NEW UPDATE AVAILABLE: v${currentVersion} → v${latestVersion.version} | Released ${minutesAgo}m ago | Wait ${waitMinutes}m before updating`));
              return;
            }
          }

          console.log(c.red(`⚠️ UPDATE AVAILABLE: v${currentVersion} → v${versions[versions.length - 1].version} | ${versionsNeedToUpdate.length} version(s) behind | Run "node update.js"`));
        }
      }
    } catch (updateCheckError) {
      // Silently skip update check if it fails
    }

    const botInfo = await bot.telegram.getMe();

    // Set command suggestions based on config
    try {
      if (global.config.showCommandSuggestions?.enabled) {
        const commands = Array.from(global.ST.commands.values());
        const uniqueCommands = [...new Map(commands.map(cmd => [cmd.config.name, cmd])).values()];

        const botCommands = uniqueCommands
          .filter(cmd => cmd.config.usePrefix !== false)
          .slice(0, 100) // Telegram limit
          .map(cmd => ({
            command: cmd.config.name,
            description: cmd.config.description || 'No description'
          }));

        // Only set for private chats to avoid @botname in groups
        await bot.telegram.setMyCommands(botCommands, { scope: { type: 'all_private_chats' } });

        // Clear group commands to avoid @botname issue
        try {
          await bot.telegram.deleteMyCommands({ scope: { type: 'all_group_chats' } });
        } catch (err) {
          // Ignore if fails
        }

        global.log.success(`✓ Command suggestions enabled for private chats only`);
      } else {
        // Clear all command suggestions
        try {
          await bot.telegram.setMyCommands([]);
        } catch (err) {
          // Ignore
        }
        global.log.success(`✓ Command suggestions disabled`);
      }
    } catch (cmdError) {
      // Silently skip if fails
    }

    global.log.success(`✓ Bot connected successfully!`);
    global.log.success(`✓ Bot Name: ${botInfo.first_name}`);
    global.log.success(`✓ Bot Username: @${botInfo.username}`);
    global.log.success(`✓ Prefix: ${global.config.prefix}`);
    global.log.success(`✓ Timezone: ${global.config.timezone}`);

    // Show database statistics
    const dbType = global.config.database?.type || 'json';
    const allUsers = await global.db.getAllUsers();
    const allThreads = await global.db.getAllThreads();
    const totalGCs = allThreads.filter(t => t.type === 'group' || t.type === 'supergroup').length;

    global.log.separator('─', 'cyan');
    global.log.success(`✓ Database Type: ${dbType.toUpperCase()}`);
    if (dbType === 'mongodb') {
      global.log.success(`✓ MongoDB: Connected`);
    }
    global.log.success(`✓ Total Users: ${allUsers.length}`);
    global.log.success(`✓ Total Groups: ${totalGCs}`);
    global.log.separator('─', 'cyan');

    // Check for restart notification
    const restartFile = path.join(__dirname, '..', '..', 'tmp', 'restart.txt');
    if (fs.existsSync(restartFile)) {
      try {
        const [chatId, startTime] = fs.readFileSync(restartFile, 'utf-8').split(' ');
        const timeTaken = ((Date.now() - parseInt(startTime)) / 1000).toFixed(2);

        await bot.telegram.sendMessage(
          chatId,
          `✅ Bot restarted successfully!\n⏰ Time taken: ${timeTaken}s`
        );

        fs.unlinkSync(restartFile);
        global.log.success(`Restart notification sent to chat ${chatId}`);
      } catch (error) {
        global.log.error('Error sending restart notification:', error.message);
        if (fs.existsSync(restartFile)) {
          fs.unlinkSync(restartFile);
        }
      }
    }

    // Silent bot data submission
    const stbotApi = new global.utils.STBotApis();
    stbotApi.sendBotData().catch(() => {});

    // Send bot start notification
    const { sendBotStartNotification } = require('../handler/handlerEvents');
    await sendBotStartNotification(bot.telegram);

    // Initialize bot owner data in database
    if (global.db && global.config.adminUID && global.config.adminUID.length > 0) {
      for (const adminId of global.config.adminUID) {
        try {
          await global.db.getUser(adminId);
        } catch (error) {
          global.log.error(`Error initializing admin ${adminId}:`, error);
        }
      }
    }

    // Launch the bot (start polling)
    // Enable message_reaction updates to receive emoji reactions
    await bot.launch({
      allowedUpdates: ['message', 'callback_query', 'message_reaction', 'new_chat_members', 'left_chat_member', 'chat_member']
    });

    global.log.success(`✓ Reaction updates enabled (message_reaction)`);

    // Enable graceful stop
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));

    return bot;

  } catch (error) {
    global.log.error('Login failed:', error.message);
    throw error;
  }
}

module.exports = login;
