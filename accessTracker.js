const fs = require('fs');
const path = require('path');
const { getLogger } = require('./logging');

const logger = getLogger('access-tracker');
const DATA_DIR = process.env.DATA_DIR ?? './user-data';
const LIMITS_FILE = path.join(DATA_DIR, 'limits.json');

// Cache variables for hot-reloading limits
let cachedLimits = {};
let lastLimitsMtime = 0;

// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (err) {
        logger.error('Failed to create data directory:', err);
    }
}

// Time window constants in milliseconds
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WINDOW_24H = MS_PER_DAY;
const WINDOW_7D = 7 * MS_PER_DAY;
const WINDOW_30D = 30 * MS_PER_DAY;

/**
 * Internal helper to refresh limits cache if file has changed.
 * This allows "hot" updates to limits without restarting the server.
 */
function refreshLimits() {
    try {
        if (fs.existsSync(LIMITS_FILE)) {
            const stats = fs.statSync(LIMITS_FILE);
            if (stats.mtimeMs > lastLimitsMtime) {
                const content = fs.readFileSync(LIMITS_FILE, 'utf8');
                cachedLimits = JSON.parse(content);
                lastLimitsMtime = stats.mtimeMs;
                logger.info('Reloaded limits.json due to file update.');
            }
        }
    } catch (err) {
        logger.error(`Error reading limits.json: ${err.message}`);
    }
}

/**
 * Tracks access for a given user or org and returns counts + limits.
 * * @param {string} userId 
 * @param {string} [resourceType='default']
 * @param {boolean} [readOnly=false]
 * @param {number} [weight=1] Weight of the access (default 1). Set to 0 for read-only check.
 * @returns {Object} { resource, total, last24h, last7d, last30d, limit }
 */
function trackAccess(userId, resourceType = 'default', readOnly = false, weight = 1) {
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(DATA_DIR, `access_log_${safeUserId}.json`);

    // Check if limits.json has been updated on disk
    refreshLimits();

    let data = {};
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            data = JSON.parse(content);

            // Migration: if root has timestamps, move to default
            if (Array.isArray(data.timestamps)) {
                data = { [resourceType]: { total: data.total, timestamps: data.timestamps } };
            }
        }
    } catch (err) {
        logger.warn(`Error reading access log for user ${userId}: ${err.message}`);
    }

    const now = Date.now();
    if (!data[resourceType]) {
        data[resourceType] = { total: 0, timestamps: [] };
    }
    const bucket = data[resourceType];

    // Prune timestamps older than 30 days
    if (Array.isArray(bucket.timestamps)) {
        bucket.timestamps = bucket.timestamps.filter(ts => (now - ts) < WINDOW_30D);
    } else {
        bucket.timestamps = [];
    }

    if (!readOnly) {
        for (let i = 0; i < weight; i++) {
            bucket.timestamps.push(now);
        }        
        bucket.total = (bucket.total || 0) + weight;

        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (err) {
            logger.error(`Error writing access log for user ${userId}: ${err.message}`);
            throw new Error('Failed to save access stats');
        }
    }

    // Resolve limit for the current ID (User or Org)
    let limit = null;
    const settings = cachedLimits[userId];
    if (settings) {
        // Priority: Specific resource limit > Default limit for this ID > null
        limit = settings[resourceType] ?? settings['default'] ?? null;
    }

    return {
        resource: resourceType,
        total: bucket.total,
        last24h: bucket.timestamps.filter(ts => (now - ts) < WINDOW_24H).length,
        last7d: bucket.timestamps.filter(ts => (now - ts) < WINDOW_7D).length,
        last30d: bucket.timestamps.length,
        limit: limit
    };
}

module.exports = { trackAccess };