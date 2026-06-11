const fs = require('fs');
const path = require('path');
const { getLogger } = require('./logging');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const logger = getLogger('config');

let proxyConfig = {};
let configLoadTime = 0;

function loadProxyConfig() {
    try {
        if (!fs.existsSync(CONFIG_FILE)) return proxyConfig;
        const stats = fs.statSync(CONFIG_FILE);
        if (stats.mtimeMs > configLoadTime) {
            proxyConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            configLoadTime = stats.mtimeMs;
            logger.info('Loaded proxy config from %s', CONFIG_FILE);
        }
    } catch (err) {
        logger.error('Failed to load proxy config: %s', err.message);
    }
    return proxyConfig;
}

module.exports = { loadProxyConfig };
