import crypto  from 'crypto';
import { getLogger } from './logging.js';

const sessions = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 24; // 24 hours idle timeout
const MAX_SESSIONS = 1000; // configurable limit
const CLEANUP_INTERVAL = 1000 * 60 * 10; // 10 minutes

const logger = getLogger('session-manager');

function createSession(type, connector) {
    const token = crypto.randomUUID();

    // If we reached the max, evict the oldest
    if (sessions.size >= MAX_SESSIONS) {
        evictOldestSession();
    }

    sessions.set(token, {
        type,
        connector,
        createdAt: Date.now(),
        lastAccess: null  // never accessed yet
    });

    return token;
}

function getSession(token, req) {
    const host = req.headers.host;

    // Local dev shortcut
    if ((host.startsWith('localhost') || host.startsWith('127.0.0.1')) && token === "1234567890") {
        return sessions.values().next().value;
    }

    const session = sessions.get(token);
    if (!session) return null;

    // Check TTL expiration
    if (session.lastAccess && Date.now() - session.lastAccess > SESSION_TTL) {
        sessions.delete(token);
        return null;
    }

    // Update last access (sliding expiration)
    session.lastAccess = Date.now();
    return session;
}

function deleteSession(token) {
    sessions.delete(token);
}

// Evict the oldest session (least recently used)
function evictOldestSession() {
    let oldestToken = null;
    let oldestTime = Infinity;

    for (const [token, session] of sessions.entries()) {
        if (!session.createdAt) {
            sessions.delete(token);
            return;
        } else {
            const time = session.lastAccess;
            if (time < oldestTime) {
                oldestTime = time;
                oldestToken = token;
            }
        }
    }

    if (oldestToken) {
        sessions.delete(oldestToken);
    } else {
        logger.error('No valid session found to evict');
    }
}

// Background cleanup of idle sessions
const intervalKey = (process.env.DAQUOTA_PROXY_VERSION ?? 'dev') + '_cleanSessionInterval';
if (global[intervalKey]) {
    clearInterval(global[intervalKey]);
}
global[intervalKey] = setInterval(() => {
    logger.debug('Running background cleanup of idle sessions');
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
        const last = session.lastAccess ?? session.createdAt;
        if (now - last > SESSION_TTL) {
            logger.info(`Cleaning up expired session: ${token}`);
            sessions.delete(token);
        }
    }
}, CLEANUP_INTERVAL);

export  {
    createSession,
    getSession,
    deleteSession
};
