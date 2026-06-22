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

// Persist the global proxy config (admin console). Updates the in-memory cache
// so the change applies immediately, exactly like the file-watch hot-reload.
function saveProxyConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    proxyConfig = cfg;
    configLoadTime = Date.now();
    logger.info('Saved proxy config to %s', CONFIG_FILE);
}

// True unless public sessions are explicitly disabled. Accepts the legacy
// `allPublicSessions` key as a fallback for the renamed `allowPublicSessions`.
function publicSessionsAllowed(cfg) {
    const v = cfg.allowPublicSessions ?? cfg.allPublicSessions;
    return v !== false;
}

module.exports = { loadProxyConfig, saveProxyConfig, publicSessionsAllowed };
