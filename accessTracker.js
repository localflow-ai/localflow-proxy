const fs = require('fs');
const path = require('path');
const { getLogger } = require('./logging');

const logger = getLogger('access-tracker');
const DATA_DIR = process.env.DATA_DIR ?? './user-data';

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
 * Tracks access for a given user.
 * Reads the user's access file, updates the count and timestamps, and saves it back.
 * @param {string} userId 
 * @param {string} [resourceType='default']
 * @param {boolean} [readOnly=false]
 * @returns {Object} { resource, total, last24h, last7d, last30d }
 */
function trackAccess(userId, resourceType = 'default', readOnly = false) {
    // Sanitize userId to ensure valid filename
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(DATA_DIR, `access_log_${safeUserId}.json`);

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

    // Prune timestamps older than 30 days to keep the file size manageable
    // while maintaining enough data for our longest window
    if (Array.isArray(bucket.timestamps)) {
        bucket.timestamps = bucket.timestamps.filter(ts => (now - ts) < WINDOW_30D);
    } else {
        bucket.timestamps = [];
    }

    if (!readOnly) {
        // Update counts
        bucket.timestamps.push(now);
        bucket.total = (bucket.total || 0) + 1;

        // Save back to file
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (err) {
            logger.error(`Error writing access log for user ${userId}: ${err.message}`);
            throw new Error('Failed to save access stats');
        }
    }

    // Calculate windowed counts
    // Since we've already pruned anything > 30d, last30d is just the array length
    return {
        resource: resourceType,
        total: bucket.total,
        last24h: bucket.timestamps.filter(ts => (now - ts) < WINDOW_24H).length,
        last7d: bucket.timestamps.filter(ts => (now - ts) < WINDOW_7D).length,
        last30d: bucket.timestamps.length
    };
}

module.exports = { trackAccess };