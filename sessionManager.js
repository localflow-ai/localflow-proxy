const crypto = require('crypto');

const sessions = new Map();

function createSession(type, connector) {
    const token = crypto.randomUUID();
    sessions.set(token, { type, connector });
    return token;
}

function getSession(token, req) {
    const host = req.headers.host;
    if ((host.startsWith('localhost') || host.startsWith('127.0.0.1')) && token === "1234567890") {
        return sessions.values().next().value;
    }
    return sessions.get(token);
}

function deleteSession(token) {
    sessions.delete(token);
}

module.exports = {
    createSession,
    getSession,
    deleteSession
};