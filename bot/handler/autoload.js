const fs = require('fs');
const path = require('path');
const Logger = require('../../logger/logs');
const c = require('../../logger/color');
const { exec } = require('child_process');

const log = new Logger(global.config?.timezone || 'Asia/Dhaka');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function installMissingPackage(packageName) {
  return new Promise((resolve, reject) => {
    log.info(`📦 Installing missing package: ${c.yellow(packageName)}...`);

    exec(`npm install ${packageName}`, (error, stdout, stderr) => {
      if (error) {
        log.error(`Failed to install ${packageName}: ${error.message}`);
        reject(error);
        return;
      }

      log.success(`✓ Successfully installed ${c.green(packageName)}`);
      resolve();
    });
  });
}

async function tryInstallAndLoad(filePath, file, commandsPath) {
  try {
    delete require.cache[require.resolve(filePath)];
    const command = require(filePath);
    return { success: true, command };
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      const match = error.message.match(/Cannot find module '([^']+)'/);
      if (match) {
        const missingPackage = match[1];

        try {
          await installMissingPackage(missingPackage);

          delete require.cache[require.resolve(filePath)];
          const command = require(filePath);
          return { success: true, command };
        } catch (installError) {
          return { success: false, error: `Failed to install ${missingPackage}: ${installError.message}` };
        }
      }
    }
    return { success: false, error: error.message };
  }
}

async function loadCommands(showProgress = true) {
  const commandsPath = path.join(__dirname, '../../scripts', 'cmds');
  const loadedCommands = [];
  const errorCommands = [];

  if (!fs.existsSync(commandsPath)) {
    log.warn('Commands directory not found');
    return { loaded: [], errors: [] };
  }

  const files = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
  const disabledCommands = global.config.disabledCommands || [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (disabledCommands.includes(file)) {
      if (showProgress) {
        log.warn(`Skipping disabled command: ${file}`);
      }
      continue;
    }

    const filePath = path.join(commandsPath, file);
    const result = await tryInstallAndLoad(filePath, file, commandsPath);

    if (!result.success) {
      errorCommands.push({ file, error: result.error });
      if (showProgress) {
        log.error(`Failed to load command ${c.yellow(file)}: ${result.error}`);
      }
      continue;
    }

    try {
      const command = result.command;

      if (!command.config || !command.config.name) {
        throw new Error('Missing config or name');
      }

      if (!command.ST) {
        throw new Error('Missing ST() function');
      }

      // Check for duplicate command name
      if (global.ST.commands.has(command.config.name)) {
        const existingCmd = global.ST.commands.get(command.config.name);
        log.warn(`Skipping ${c.yellow(file)}: Command name "${command.config.name}" already exists in ${existingCmd.config.name}.js`);
        errorCommands.push({ file, error: `Duplicate command name: ${command.config.name}` });
        continue;
      }

      // Check for duplicate aliases
      let hasDuplicateAlias = false;
      if (command.config.aliases && Array.isArray(command.config.aliases)) {
        for (const alias of command.config.aliases) {
          if (global.ST.commands.has(alias)) {
            const existingCmd = global.ST.commands.get(alias);
            log.warn(`Skipping ${c.yellow(file)}: Alias "${alias}" already exists in ${existingCmd.config.name}.js`);
            errorCommands.push({ file, error: `Duplicate alias: ${alias}` });
            hasDuplicateAlias = true;
            break;
          }
        }
      }

      if (hasDuplicateAlias) {
        continue;
      }

      // Load command and aliases
      global.ST.commands.set(command.config.name, command);

      if (command.config.aliases && Array.isArray(command.config.aliases)) {
        command.config.aliases.forEach(alias => {
          global.ST.commands.set(alias, command);
        });
      }

      loadedCommands.push(file);

      // Call onLoad hook with Telegraf bot API
      if (command.onLoad && typeof command.onLoad === 'function' && global.bot) {
        try {
          // global.bot is now the Telegraf instance
          // Provide both the Telegraf instance and its telegram API
          await command.onLoad({ 
            api: global.bot.telegram || global.bot,
            bot: global.bot 
          });
        } catch (error) {
          log.error(`Error in onLoad for ${command.config.name}:`, error.message);
        }
      }

      if (showProgress) {
        await sleep(100);
        log.loading('Loading Commands', i + 1, files.length - disabledCommands.length);
      }
    } catch (error) {
      errorCommands.push({ file, error: error.message });
      if (showProgress) {
        log.error(`Failed to load command ${c.yellow(file)}: ${error.message}`);
      }
    }
  }

  return { loaded: loadedCommands, errors: errorCommands };
}

async function loadEvents(showProgress = true) {
  const eventsPath = path.join(__dirname, '../../scripts', 'events');
  const loadedEvents = [];
  const errorEvents = [];

  if (!fs.existsSync(eventsPath)) {
    log.warn('Events directory not found');
    return { loaded: [], errors: [] };
  }

  const files = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
  const disabledEvents = global.config.disabledEvents || [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (disabledEvents.includes(file)) {
      if (showProgress) {
        log.warn(`Skipping disabled event: ${file}`);
      }
      continue;
    }

    const filePath = path.join(eventsPath, file);
    const result = await tryInstallAndLoad(filePath, file, eventsPath);

    if (!result.success) {
      errorEvents.push({ file, error: result.error });
      if (showProgress) {
        log.error(`Failed to load event ${c.yellow(file)}: ${result.error}`);
      }
      continue;
    }

    try {
      const event = result.command;

      if (!event.config || !event.config.name) {
        throw new Error('Missing config or name');
      }

      if (!event.ST) {
        throw new Error('Missing ST() function');
      }

      global.ST.events.set(event.config.name, event);
      loadedEvents.push(file);

      if (showProgress) {
        await sleep(100);
        log.loading('Loading Events', i + 1, files.length - disabledEvents.length);
      }
    } catch (error) {
      errorEvents.push({ file, error: error.message });
      if (showProgress) {
        log.error(`Failed to load event ${c.yellow(file)}: ${error.message}`);
      }
    }
  }

  return { loaded: loadedEvents, errors: errorEvents };
}

function unloadCommand(commandName) {
  try {
    const command = global.ST.commands.get(commandName);

    if (!command) {
      return { success: false, message: 'Command not found' };
    }

    global.ST.commands.delete(commandName);

    if (command.config.aliases) {
      command.config.aliases.forEach(alias => {
        global.ST.commands.delete(alias);
      });
    }

    const commandFile = `${commandName}.js`;
    if (!global.config.disabledCommands.includes(commandFile)) {
      global.config.disabledCommands.push(commandFile);
      saveConfig();
    }

    return { success: true, message: `Command ${commandName} unloaded successfully` };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

function unloadEvent(eventName) {
  try {
    const event = global.ST.events.get(eventName);

    if (!event) {
      return { success: false, message: 'Event not found' };
    }

    global.ST.events.delete(eventName);

    const eventFile = `${eventName}.js`;
    if (!global.config.disabledEvents.includes(eventFile)) {
      global.config.disabledEvents.push(eventFile);
      saveConfig();
    }

    return { success: true, message: `Event ${eventName} unloaded successfully` };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function reloadCommand(commandName) {
  try {
    const commandsPath = path.join(__dirname, '../../scripts', 'cmds');
    const files = fs.readdirSync(commandsPath);
    const commandFile = files.find(f => f.replace('.js', '') === commandName);

    if (!commandFile) {
      return { success: false, message: 'Command file not found' };
    }

    delete require.cache[require.resolve(path.join(commandsPath, commandFile))];
    const command = require(path.join(commandsPath, commandFile));

    if (!command.config || !command.ST) {
      return { success: false, message: 'Invalid command structure' };
    }

    global.ST.commands.set(command.config.name, command);

    if (command.config.aliases) {
      command.config.aliases.forEach(alias => {
        global.ST.commands.set(alias, command);
      });
    }

    const index = global.config.disabledCommands.indexOf(commandFile);
    if (index > -1) {
      global.config.disabledCommands.splice(index, 1);
      saveConfig();
    }

    return { success: true, message: `Command ${commandName} reloaded successfully` };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function reloadEvent(eventName) {
  try {
    const eventsPath = path.join(__dirname, '../../scripts', 'events');
    const files = fs.readdirSync(eventsPath);
    const eventFile = files.find(f => f.replace('.js', '') === eventName);

    if (!eventFile) {
      return { success: false, message: 'Event file not found' };
    }

    delete require.cache[require.resolve(path.join(eventsPath, eventFile))];
    const event = require(path.join(eventsPath, eventFile));

    if (!event.config || !event.ST) {
      return { success: false, message: 'Invalid event structure' };
    }

    global.ST.events.set(event.config.name, event);

    const index = global.config.disabledEvents.indexOf(eventFile);
    if (index > -1) {
      global.config.disabledEvents.splice(index, 1);
      saveConfig();
    }

    return { success: true, message: `Event ${eventName} reloaded successfully` };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

function deleteCommandFile(fileName) {
  try {
    const commandsPath = path.join(__dirname, '../../scripts', 'cmds', fileName);

    if (!fs.existsSync(commandsPath)) {
      return { success: false, message: 'File not found' };
    }

    fs.unlinkSync(commandsPath);

    const commandName = fileName.replace('.js', '');
    global.ST.commands.delete(commandName);

    return { success: true, message: `Command file ${fileName} deleted successfully` };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

function deleteEventFile(fileName) {
  try {
    const eventsPath = path.join(__dirname, '../../scripts', 'events', fileName);

    if (!fs.existsSync(eventsPath)) {
      return { success: false, message: 'File not found' };
    }

    fs.unlinkSync(eventsPath);

    const eventName = fileName.replace('.js', '');
    global.ST.events.delete(eventName);

    return { success: true, message: `Event file ${fileName} deleted successfully` };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

function installCommandFile(fileName, code) {
  try {
    const commandsPath = path.join(__dirname, '../../scripts', 'cmds', fileName);

    fs.writeFileSync(commandsPath, code);

    return { success: true, message: `Command file ${fileName} installed successfully` };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

function installEventFile(fileName, code) {
  try {
    const eventsPath = path.join(__dirname, '../../scripts', 'events', fileName);

    fs.writeFileSync(eventsPath, code);

    return { success: true, message: `Event file ${fileName} installed successfully` };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

function saveConfig() {
  try {
    fs.writeFileSync('./config.json', JSON.stringify(global.config, null, 2));
  } catch (error) {
    log.error('Failed to save config:', error.message);
  }
}

// Function to handle restart command (adapted from r.js example)
function restartProject() {
  log.info('Restarting Project...');
  exec('pm2 restart index.js', (error, stdout, stderr) => {
    if (error) {
      log.error(`Error restarting project: ${error.message}`);
      return;
    }
    if (stderr) {
      log.error(`Restart stderr: ${stderr}`);
      return;
    }
    log.info('Project restarted successfully.');
  });
}

// Function to handle eval command (modified to only output code)
function evalCode(code) {
  try {
    const result = eval(code);
    if (typeof result !== 'object' && typeof result !== 'function') {
      return result;
    } else {
      return JSON.stringify(result, null, 2);
    }
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

// Placeholder for reaction handler - specific implementation needs to be in ST.js
function handleReaction(reaction, user) {
  // This function needs to be properly defined and called in ST.js
  // and potentially tied to specific bot logic for reaction detection.
  log.info(`Reaction detected: ${reaction.emoji.name} by ${user.username}`);
  // Add logic here to detect specific reactions and trigger actions.
}

module.exports = {
  loadCommands,
  loadEvents,
  unloadCommand,
  unloadEvent,
  reloadCommand,
  reloadEvent,
  deleteCommandFile,
  deleteEventFile,
  installCommandFile,
  installEventFile,
  restartProject,
  evalCode,
  handleReaction
};
