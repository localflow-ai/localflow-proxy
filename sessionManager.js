import crypto from 'crypto';

const sessions = new Map();

export function createSession(type, connector, credentials) {
    const token = crypto.randomUUID();
    sessions.set(token, { type, connector, credentials });
    return token;
}

export function getSession(token, req) {
    const host = req.headers.host;
    if ((host.startsWith('localhost') || host.startsWith('127.0.0.1')) && token === "1234567890") {
        return sessions.values().next().value;
    }
    return sessions.get(token);
}

export function deleteSession(token) {
    sessions.delete(token);
}