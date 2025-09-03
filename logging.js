// pino is fast and simple logging lib
const pino = require('pino');
const pinoMultiStream = require('pino-multi-stream');
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.APP_LOG_DIR ?? './daquota-proxy-logs';
if (!fs.existsSync(LOG_DIR)) {
    console.log("create log directory: " + LOG_DIR)
    fs.mkdirSync(LOG_DIR, { recursive: true })
}

const LOG_DEFAULT_LEVEL = 'info';
const LOG_FILE = path.join(LOG_DIR, `app${process.env.APP_LOG_VERSION ? '-' + process.env.APP_LOG_VERSION : ''}.log`);

const destination = [
    { level: LOG_DEFAULT_LEVEL, stream: pino.destination({ dest: LOG_FILE, sync: false }) },
    { level: LOG_DEFAULT_LEVEL, stream: pino.destination({ dest: 1 }) },
    // add multiple log destination per level here
];

// create global logger
const logger = pinoMultiStream({
    level: LOG_DEFAULT_LEVEL,
    streams: destination
});

// in case of crash, we want to loose no logs
process.on('exit', () => logger.flush());
process.on('SIGINT', () => { logger.flush(); process.exit(); });
process.on('SIGTERM', () => { logger.flush(); process.exit(); });

function setAllLoggersLevel(newLevelForAll = LOG_DEFAULT_LEVEL) {
    logger.level = newLevelForAll;
}

function getLogger(category, minLevel = LOG_DEFAULT_LEVEL) {
    return logger.child({
        category,
        _minLevel: minLevel,
    });
}

function getGlobalLogger(category, minLevel = LOG_DEFAULT_LEVEL) {
    return logger;
}

module.exports = {
    setAllLoggersLevel,
    getLogger,
    getGlobalLogger,
}