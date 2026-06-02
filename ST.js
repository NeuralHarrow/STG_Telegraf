const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { showBanner } = require('./logger/banner');
const Logger = require('./logger/logs');
const c = require('./logger/color');
const autoload = require('./bot/handler/autoload');
const login = require('./bot/login/login');

global.ST = {
  commands: new Map(),
  events: new Map(),
  onReply: new Map(),
  onReaction: new Map(),
  onCallback: new Map(),
  cooldowns: new Map(),
  threadAdmins: new Map(),
  messageTracker: {
    data: new Map(),
    add: function(threadId, userId) {
      const key = `${threadId}_${userId}`;
      const current = this.data.get(key) || 0;
      this.data.set(key, current + 1);
    },
    get: function(threadId, userId) {
      const key = `${threadId}_${userId}`;
      return this.data.get(key) || 0;
    }
  }
};

global.config = require('./config.json');
global.utils = require('./utils');
global.fs = fs;
global.path = path;

// Initialize database
async function initDatabase() {
  const dbType = global.config.database?.type || 'json';

  if (dbType === 'mongodb') {
    const MongoDatabase = require('./database/mongodb');
    global.db = new MongoDatabase();
    const uri = global.config.database.uriMongodb;
    if (uri) {
      await global.db.connect(uri);
      log.success('Connected to MongoDB');
    } else {
      log.error('MongoDB URI not provided, falling back to JSON');
      const JsonDatabase = require('./database/jsondb');
      global.db = new JsonDatabase();
    }
  } else {
    const JsonDatabase = require('./database/jsondb');
    global.db = new JsonDatabase();
    log.success('Using JSON database');
  }
}

// Make autoload functions globally available
global.loadCommands = autoload.loadCommands;
global.loadEvents = autoload.loadEvents;
global.unloadCommand = autoload.unloadCommand;
global.unloadEvent = autoload.unloadEvent;
global.reloadCommand = autoload.reloadCommand;
global.reloadEvent = autoload.reloadEvent;
global.deleteCommandFile = autoload.deleteCommandFile;
global.deleteEventFile = autoload.deleteEventFile;
global.installCommandFile = autoload.installCommandFile;
global.installEventFile = autoload.installEventFile;

const log = new Logger(global.config.timezone);
global.log = log;

async function promptForToken() {
  while (true) {
    const token = await new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.question(c.cyan('Please enter your Telegram bot token: '), (input) => {
        rl.close();
        resolve(input);
      });
    });

    if (token && token.trim().length > 0) {
      global.config.token = token.trim();

      try {
        const configPath = path.join(__dirname, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(global.config, null, 2));
        log.success('Token saved to config.json successfully!');
        return;
      } catch (error) {
        log.error('Failed to save token:', error.message);
        log.info('Please try again...\n');
      }
    } else {
      log.error('Invalid token provided! Token cannot be empty.');
      log.info('Please try again...\n');
    }
  }
}

async function startBot() {
  showBanner();

  log.separator('═', 'cyan');
  log.info(`Starting ${c.bright(c.cyan('STG_Telegraf'))}...`);
  log.separator('═', 'cyan');

  if (!global.config.token) {
    log.warn('Bot token not found in config.json!');
    log.info('');
    await promptForToken();
    log.separator('═', 'cyan');
  }

  await sleep(500);

  log.info('Loading database...');
  await initDatabase();

  // Load and show database statistics
  const allUsers = await global.db.getAllUsers();
  const allThreads = await global.db.getAllThreads();
  const totalGCs = allThreads.filter(t => t.type === 'group' || t.type === 'supergroup').length;
  log.success(`Loaded ${c.bright(allUsers.length)} users and ${c.bright(totalGCs)} groups from database`);
  log.separator();

  log.info('Loading command modules...');
  const cmdResult = await autoload.loadCommands(true);

  if (cmdResult.errors.length > 0) {
    log.warn(`${cmdResult.errors.length} command(s) failed to load:`);
    cmdResult.errors.forEach(err => {
      log.error(`  └─ ${c.yellow(err.file)}: ${err.error}`);
    });
  }

  log.success(`Loaded ${c.bright(cmdResult.loaded.length)} commands successfully`);
  log.separator();

  await sleep(300);

  log.info('Loading event modules...');
  const eventResult = await autoload.loadEvents(true);

  if (eventResult.errors.length > 0) {
    log.warn(`${eventResult.errors.length} event(s) failed to load:`);
    eventResult.errors.forEach(err => {
      log.error(`  └─ ${c.yellow(err.file)}: ${err.error}`);
    });
  }

  log.success(`Loaded ${c.bright(eventResult.loaded.length)} events successfully`);
  log.separator('═', 'cyan');

  await sleep(300);

  // Start web server if enabled (BEFORE Telegram connection)
  if (global.config.dashBoard?.enable) {
    try {
      log.separator('═', 'cyan');
      log.info('Starting dashboard server...');
      const createServer = require('./bot/login/server');
      const startTime = Date.now();
      const server = await createServer();
      const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
      log.success(`Dashboard server loaded in ${loadTime}s`);
      log.separator('═', 'cyan');

      // Start auto-uptime
      if (global.config.autoUptime?.enable) {
        require('./bot/autoUptime');
      }
    } catch (error) {
      log.error('Failed to start dashboard server:', error.message);
    }
  }

  log.info('Connecting to Telegram...');
  const bot = await login();

  // Set global bot instance (Telegraf bot)
  global.bot = bot;

  log.separator('═', 'cyan');
  log.success('STG_Telegraf is now online! If there any issue use streport cmd');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('unhandledRejection', (error) => {
  log.error('Unhandled Rejection:', error.message);
});

process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error.message);
});

startBot().catch(error => {
  log.error('Failed to start bot:', error.message);
  process.exit(1);
});

module.exports = { autoload };
