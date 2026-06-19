const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();

const { createSession, getSession, deleteSession, getSessionStats, getAllSessions } = require('./sessionManager.js');
const { SalesforceConnector } = require('./connectors/salesforce.js');
const { OdooConnector } = require('./connectors/odoo.js');
const { PublicConnector } = require('./connectors/public.js');
const { trackAccess } = require('./accessTracker.js');
const { encrypt, decrypt } = require('./encryption.js');
const { getOAuth2Token } = require('./oauth2.js');
const { spawn } = require('child_process');
const Bottleneck = require("bottleneck");

const { getLogger } = require('./logging');
const logger = getLogger('routes');
const { loadProxyConfig } = require('./config');

const DESCRIPTORS_FILE = process.env.API_CONFIG_FILE || path.join(__dirname, 'api-config.json');
let apiDescriptors = [];
let lastLoadTime = 0;
const nextAllowedTimes = new Map();

// Admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const startTime = Date.now();

// Event ring buffer — last 500 events, all types
const EVENT_RING_SIZE = 500;
const eventRing = [];
let eventIdCounter = 0;

function pushEvent(kind, data) {
    const event = { id: ++eventIdCounter, time: new Date().toISOString(), kind, ...data };
    eventRing.push(event);
    if (eventRing.length > EVENT_RING_SIZE) eventRing.shift();
    return event;
}

// Daily aggregate call counters (proxy-wide, not per-IP)
let dailyStats = { apiCalls: 0, genaiCalls: 0, date: new Date().toDateString() };

function bumpDailyStat(key) {
    const today = new Date().toDateString();
    if (today !== dailyStats.date) {
        dailyStats = { apiCalls: 0, genaiCalls: 0, date: today };
    }
    dailyStats[key]++;
}

function loadApiDescriptors() {
    logger.debug('Loading API descriptors from %s', DESCRIPTORS_FILE);
    if (!fs.existsSync(DESCRIPTORS_FILE)) {
        logger.debug('API descriptors file does not exist');
        return [];
    }
    try {
        const stats = fs.statSync(DESCRIPTORS_FILE);
        if (stats.mtimeMs > lastLoadTime) {
            const content = fs.readFileSync(DESCRIPTORS_FILE, 'utf8');
            apiDescriptors = JSON.parse(content);
            lastLoadTime = stats.mtimeMs;
            logger.info('Loaded API descriptors from %s', DESCRIPTORS_FILE);
        }
    } catch (err) {
        logger.error('Failed to load API descriptors: %s', err.message);
    }
    return apiDescriptors;
}

function saveApiDescriptors(descriptors) {
    try {
        fs.writeFileSync(DESCRIPTORS_FILE, JSON.stringify(descriptors, null, 2), 'utf8');
        apiDescriptors = descriptors;
        lastLoadTime = Date.now();
        logger.info('Saved API descriptors to %s', DESCRIPTORS_FILE);
    } catch (err) {
        logger.error('Failed to save API descriptors: %s', err.message);
        throw err;
    }
}

/**
 * Applies rewrite rules to a given URL.
 * Supports 'replace' actions currently.
 * * @param {string} url - The original URL string
 * @param {Array} rewriteRules - Array of rule arrays
 * @param {string} apiKey - Optional API key for dynamic replacement
 * @returns {string} - The rewritten URL
 */
const applyRewriteRules = (url, dataSource, apiKey) => {
    const rewriteRules = dataSource?.rewriteRules;
    if (!rewriteRules) {
        return url;
    }
    let rewrittenUrl = url;

    // Iterate through each rule-set (the outer array)
    rewriteRules.forEach(ruleSet => {
        // Iterate through the flat rule-set in increments of 3
        // [action, search, replace, action, search, replace...]
        for (let i = 0; i < ruleSet.length; i += 3) {
            const action = ruleSet[i];
            const search = ruleSet[i + 1];
            const replacement = ruleSet[i + 2];

            if (action === 'replace') {
                rewrittenUrl = rewrittenUrl.replace(search, replacement);
                if (apiKey && replacement.includes(dataSource.apiKeyRoutePlaceholder)) {
                    rewrittenUrl = rewrittenUrl.replace(dataSource.apiKeyRoutePlaceholder, apiKey);
                }
            }
        }
    });

    return rewrittenUrl;
};

const fetch = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));

const connectorMap = {
    salesforce: SalesforceConnector,
    odoo: OdooConnector,
    public: PublicConnector
};

const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// 1 request/sec, max 50 in queue, block the rest
const limiter = new Bottleneck({
    maxConcurrent: 1,                // Only process 1 at a time
    minTime: 1000,                   // Wait at least 1s between starts
    highWater: 50,                   // Max queue size
    strategy: Bottleneck.strategy.BLOCK // Refuse (503) if queue > 50
});

const throttler = (req, res, next) => {
    limiter.schedule(() => Promise.resolve())
        .then(() => next())
        .catch(() => {
            res.status(503).json({ error: "Server busy. Please try again later." });
        });
};

// Per-IP daily quota using a plain Map — avoids Bottleneck.Group's idle-limiter cleanup
// which would silently reset the quota whenever an IP goes quiet for a few minutes.
const _quotas = { genai: new Map(), api: new Map() };

function _consumeQuota(store, ip, limit) {
    const now = Date.now();
    let e = store.get(ip);
    if (!e || now >= e.resetAt) {
        e = { count: 0, resetAt: now + 86_400_000 };
        store.set(ip, e);
    }
    if (e.count >= limit) return { allowed: false, remaining: 0 };
    e.count++;
    return { allowed: true, remaining: limit - e.count };
}

// Returns the real client IP, respecting X-Forwarded-For set by a reverse proxy.
function getClientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return req.ip || req.socket.remoteAddress;
}

// Admin session — unauthenticated; must be before the auth middleware
router.post('/admin/session', express.json(), (req, res) => {
    if (!ADMIN_TOKEN) {
        return res.status(503).json({ error: 'Admin access not configured. Set ADMIN_TOKEN env var.' });
    }
    const { token } = req.body;
    if (!token || token !== ADMIN_TOKEN) {
        return res.status(401).json({ error: 'Invalid admin token' });
    }
    const adminConnector = {
        sessionInfo: { orgId: 'admin', userId: 'admin', username: 'admin' },
        getSessionInfo: async () => ({ orgId: 'admin', userId: 'admin', username: 'admin' }),
    };
    const sessionToken = createSession('admin', adminConnector);
    res.json({ token: sessionToken });
});

router.post('/session', express.json(), asyncHandler(async (req, res) => {
    const { type, config } = req.body;
    logger.info('create new session', type);
    const ConnectorClass = connectorMap[type?.toLowerCase()];
    if (!ConnectorClass) return res.status(400).json({ error: 'Unsupported connector type', details: 'Valid connector types are: salesforce, odoo' });

    try {
        const connector = new ConnectorClass();
        await connector.login(config);

        const token = createSession(type, connector);
        pushEvent('session', { ip: getClientIp(req), sessionType: type });
        res.json({ token });
    } catch (err) {
        res.status(401).json({ error: 'Authentication failed', detail: err.message });
    }
}));

router.get('/public/config', (req, res) => {
    const cfg = loadProxyConfig();
    res.json({
        // When true, the proxy never forwards file attachments to the LLM.
        // Clients must enforce metadata-only locally; the proxy rejects any
        // genai request that carries attachments (defense in depth, below).
        safeMode: cfg.safeMode === true,
        publicSessions: {
            enabled: cfg.allPublicSessions !== false,
            rateLimits: cfg.publicSessionLimiterConfiguration ?? { genaiPerIpPerDay: 40, apiPerIpPerDay: 5000 },
        },
    });
});

router.use(async (req, res, next) => {
    if (req.method === 'OPTIONS') {
        return next();
    }

    logger.info('request %s %s', req.method, req.path);

    const isProxyPath = req.path.includes('/common/api-proxy');
    const headerName = isProxyPath ? 'x-proxy-token' : 'authorization';

    const auth = req.headers[headerName];
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({
            error: `Missing or invalid token. Expected in header: ${headerName}`
        });
    }

    const token = auth.split(' ')[1];
    const session = getSession(token, req);

    if (!session) {
        return res.status(403).json({ error: 'Session expired or invalid' });
    }

    // --- Limiter for public connector ---
    if (session.type === 'public') {
        const cfg = loadProxyConfig();
        if (cfg.allPublicSessions === false) {
            return res.status(403).json({ error: 'Public sessions are currently disabled.' });
        }
        const isApi   = req.path.includes('api-proxy');
        const isGenai = req.path.includes('genai');
        if (isApi || isGenai) {
            const rl = cfg.publicSessionLimiterConfiguration ?? {};
            const limit = isGenai ? (rl.genaiPerIpPerDay ?? 40) : (rl.apiPerIpPerDay ?? 5000);
            const clientIp = getClientIp(req);
            const { allowed, remaining } = _consumeQuota(isGenai ? _quotas.genai : _quotas.api, clientIp, limit);
            logger.debug(`IP: ${clientIp} | ${isGenai ? 'GenAI' : 'API'} quota remaining: ${remaining}`);
            if (!allowed) {
                logger.warn('Rate limit triggered for IP %s on %s', clientIp, req.path);
                return res.status(429).json({
                    error: 'Too many requests',
                    detail: `Public session ${isGenai ? 'GenAI' : 'API'} rate limit exceeded.`
                });
            }
        }
    }
    // ---------------------------------

    req.session = session;
    // Resolve the effective permission set once per request (config hot-reloads).
    // Candidate user keys (uid, login, email…) — connectors nest identity under
    // sessionInfo.context.user. `groups` is always [] today (future connector).
    const si = (session.connector && session.connector.sessionInfo) || {};
    const u = (si.context && si.context.user) || {};
    const userKeys = [si.userId, si.username, u.email, u.login, u.name]
        .filter(x => x != null).map(String);
    req.permissions = (session.type === 'admin')
        ? null  // admin bypasses capability checks
        : resolvePermissions(session.type, userKeys, si.groups || []);
    next();
});

router.get('/permissions', (req, res) => {
    res.json(req.permissions || EMPTY_PERMISSIONS());
});

const adminOnly = (req, res, next) => {
    if (req.session?.type !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

router.use('/admin', adminOnly);

/**
 * API Proxy Endpoint
 * Logic: Forwards request to target ?url=... while filtering sensitive headers
 * Authenticated: Requires valid session token in Authorization header
 */
router.all('/common/api-proxy', express.raw({ limit: '50mb', type: '*/*' }), asyncHandler(async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Missing target url' });

    const descriptors = loadApiDescriptors();
    const dataSource = descriptors.find(ds => {
        const baseUrls = Array.isArray(ds.baseUrl) ? ds.baseUrl : [ds.baseUrl];
        return baseUrls.some(u => targetUrl.startsWith(u));
    });

    if (!dataSource) {
        return res.status(403).json({ error: 'Not allowed' });
    }

    // --- Authorization ---
    if (!permHas(req, 'api.use')) return denyPerm(res, 'api.use');
    if (req.permissions && !(req.permissions.apis.includes('*') || req.permissions.apis.includes(dataSource.id))) {
        return res.status(403).json({ error: `API not allowed: ${dataSource.id}` });
    }

    if (dataSource.waitMs) {
        const waitMs = parseInt(dataSource.waitMs, 10);
        if (!isNaN(waitMs) && waitMs > 0) {
            const now = Date.now();
            let nextAllowed = nextAllowedTimes.get(dataSource.id) || 0;
            if (nextAllowed < now) nextAllowed = now;
            const waitTime = nextAllowed - now;
            nextAllowedTimes.set(dataSource.id, nextAllowed + waitMs);
            if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
        }
    }

    const requestHeaders = {};

    let apiKey = req.headers['x-proxy-api-key'];
    if (dataSource.apiKeyQueryParam || dataSource.apiKeyQueryParamGetOnly || dataSource.apiKeyHeader || dataSource.apiKeyRoutePlaceholder || dataSource.apiKeyBodyParam) {
        if (!apiKey) {
            apiKey = dataSource.apiKey;
        } else {
            apiKey = decrypt(apiKey, req.session.connector.sessionInfo.orgId);
        }

        if (apiKey) {
            if (dataSource.apiKeyQueryParam) {
                const url = new URL(targetUrl);
                url.searchParams.set(dataSource.apiKeyQueryParam, apiKey);
                targetUrl = url.toString();
            }
            if (dataSource.apiKeyQueryParamGetOnly && req.method.toUpperCase() === 'GET') {
                const url = new URL(targetUrl);
                url.searchParams.set(dataSource.apiKeyQueryParamGetOnly, apiKey);
                targetUrl = url.toString();
            }
        }
    }

    if (dataSource.oAuth2TokenUrl) {
        try {
            logger.info('Fetching OAuth2 token for data source %s', dataSource.id);
            const token = await getOAuth2Token(dataSource);
            logger.info('Obtained OAuth2 token for data source %s: %s', dataSource.id, token.replace(/.(?=.{4})/g, '*'));
            apiKey = `Bearer ${token}`; 
        } catch (e) {
            return res.status(401).json({ error: 'OAuth2 Authentication failed', message: e.message });
        }
    }    

    const finalUrl = applyRewriteRules(targetUrl, dataSource, apiKey);
    logger.info('Proxying %s: %s -> %s', req.method, targetUrl, finalUrl);

    const forbiddenRequestHeaders = [
        'host', 'origin', 'referer', 'cookie', 'connection', 'content-length', 'authorization'
    ];

    const forbiddenRequestHeadersPrexixes = [
        'x-forwarded-', 'x-proxy-', 'sec-'
    ];

    for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();

        if (forbiddenRequestHeaders.includes(lowerKey)) continue;
        if (forbiddenRequestHeadersPrexixes.some(p => lowerKey.startsWith(p))) continue;

        requestHeaders[lowerKey] = value;
    }

    if (apiKey && dataSource.apiKeyHeader) {
        requestHeaders[dataSource.apiKeyHeader.toLowerCase()] = apiKey;
    }
    requestHeaders['user-agent'] = dataSource.requiredUserAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    if (dataSource.requiredReferer) {
        requestHeaders['referer'] = dataSource.requiredReferer;
    }
    if (dataSource.requiredOrigin) {
        requestHeaders['origin'] = dataSource.requiredOrigin;
    }

    delete requestHeaders['host'];

    const fetchOptions = {
        method: req.method,
        headers: requestHeaders,
        redirect: 'follow',
        compress: true
    };

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.body && req.body.length > 0) {
        let body = req.body;

        if (dataSource.apiKeyBodyParam && apiKey) {
            try {
                const jsonBody = body && body.length > 0 ? JSON.parse(body.toString()) : {};
                jsonBody[dataSource.apiKeyBodyParam] = apiKey;
                body = Buffer.from(JSON.stringify(jsonBody));
            } catch (e) {
                logger.warn('Proxy: Could not inject apiKeyBodyParam (body not JSON)');
            }
        }

        if (body && body.length > 0) {
            fetchOptions.body = body;
        }
    }

    try {
        logger.debug('Fetch options, %s', JSON.stringify({
            method: fetchOptions.method,
            headers: fetchOptions.headers,
            hasBody: !!fetchOptions.body
        }));
        const abortController = new AbortController();
        const abortTimer = setTimeout(() => abortController.abort(), 20000);
        fetchOptions.signal = abortController.signal;
        const response = await fetch(finalUrl, fetchOptions).finally(() => clearTimeout(abortTimer));
        res.status(response.status);

        pushEvent('api-proxy', { ip: getClientIp(req), url: targetUrl, apiName: dataSource?.name ?? null, status: response.status });
        bumpDailyStat('apiCalls');

        const forbiddenResponseHeaders = [
            'access-control-allow-origin',
            'access-control-allow-credentials',
            'access-control-allow-headers',
            'access-control-allow-methods',
            'transfer-encoding',
            'connection',
            'www-authenticate',
            'content-encoding',
            'content-length'
        ];

        response.headers.forEach((value, name) => {
            const lowerName = name.toLowerCase();
            if (lowerName.includes('access-control')) return;
            if (!forbiddenResponseHeaders.includes(lowerName)) {
                res.setHeader(name, value);
            }
        });

        if (!response.headers.has('content-type')) {
            res.setHeader('Content-Type', '');
        }

        if (req.method.toLowerCase() !== 'head') {
            response.body.pipe(res);
        } else {
            res.end();
        }

    } catch (err) {
        logger.error('Proxy Error: %s', err.message);
        pushEvent('api-proxy', { ip: getClientIp(req), url: targetUrl, apiName: dataSource?.name ?? null, status: 502 });
        bumpDailyStat('apiCalls');
        res.status(502).json({ error: 'Bad Gateway', message: err.message });
    }
}));

router.use(express.json({ limit: '50mb' }));
router.use(express.urlencoded({ limit: '50mb', extended: true }));

router.get('/common/api-config', (req, res) => {
    const descriptors = loadApiDescriptors();
    res.json(descriptors.map(ds => ({
        id: ds.id,
        name: ds.name,
        topic: ds.topic,
        description: ds.description,
        baseUrl: ds.baseUrl,
        force: ds.force,
        prepaid: ds.prepaid,
        prompt: ds.prompt,
        apiKeyQueryParam: ds.apiKeyQueryParam,
        apiKeyQueryParamGetOnly: ds.apiKeyQueryParamGetOnly,
        apiKeyBodyParam: ds.apiKeyBodyParam,
        apiKeyHeader: ds.apiKeyHeader,
        apiKeyRoutePlaceholder: ds.apiKeyRoutePlaceholder,
        apiKey: ds.apiKey ? '***' : undefined, // Mask API key in response
    })));
});

router.get('/session', asyncHandler(async (req, res) => {
    const sessionInfo = await req.session.connector.getSessionInfo();
    logger.info('sessionInfo', JSON.stringify(sessionInfo, null, 2));
    res.json(sessionInfo);
}));

router.post('/session/field-mapping', (req, res) => {
    const result = req.session.connector.createFieldMapping('$global', req.body);
    res.json(result);
});

router.post('/session/field-mapping/:objectType', (req, res) => {
    const result = req.session.connector.createFieldMapping(req.params.objectType, req.body);
    res.json(result);
});

router.post('/session/object-type-mapping', (req, res) => {
    const result = req.session.connector.createObjectTypeMapping(req.body);
    res.json(result);
});

router.get('/common/access-stats', asyncHandler(async (req, res) => {
    const sessionInfo = req.session.connector.sessionInfo;
    const scope = req.query.scope || 'default';
    const userId = scope === 'org' ? 'org_' + sessionInfo.orgId : sessionInfo?.userId || sessionInfo?.username || 'unknown';
    const resource = req.query.resource;
    const readOnly = req.query.read === 'true';
    const weight = parseInt(req.query.weight) || 1;

    const stats = trackAccess(userId, resource, readOnly, weight);
    res.json(stats);
}));

router.post('/common/encrypt', (req, res) => {
    const text = req.body.message;
    if (!text) {
        return res.status(400).json({ error: 'Missing message query parameter' });
    }
    const sessionInfo = req.session.connector.sessionInfo;
    logger.info('OrgId: %s', sessionInfo.orgId);
    if (!sessionInfo.orgId) {
        return res.status(400).json({ error: 'Invalid session' });
    }
    const encrypted = encrypt(text, sessionInfo.orgId);
    logger.info('Encrypted: %s', encrypted);
    res.json({ encrypted });
});

router.post('/common/decrypt', (req, res) => {
    const encrypted = req.body.message;
    const sessionInfo = req.session.connector.sessionInfo;
    if (!sessionInfo.orgId) {
        return res.status(400).json({ error: 'Invalid session' });
    }
    const decrypted = decrypt(encrypted, sessionInfo.orgId);
    res.json({ decrypted });
});

// ---------------------------------------------------------------------------
// LLM configs — admin-managed, keys/baseUrls never sent to clients
// ---------------------------------------------------------------------------

const LLM_CONFIGS_FILE = path.join(__dirname, 'llm-configs.json');
let llmConfigs = [];
let llmConfigsLoadTime = 0;

function loadLlmConfigs() {
    try {
        if (!fs.existsSync(LLM_CONFIGS_FILE)) return [];
        const stats = fs.statSync(LLM_CONFIGS_FILE);
        if (stats.mtimeMs > llmConfigsLoadTime) {
            llmConfigs = JSON.parse(fs.readFileSync(LLM_CONFIGS_FILE, 'utf8'));
            llmConfigsLoadTime = stats.mtimeMs;
            logger.info('Loaded LLM configs from %s', LLM_CONFIGS_FILE);
        }
    } catch (err) {
        logger.error('Failed to load LLM configs: %s', err.message);
    }
    return llmConfigs;
}

// --- Authorization / permissions (see docs/permissions.md) ----------------
const PERMISSIONS_FILE = process.env.PERMISSIONS_FILE || path.join(__dirname, 'permissions.json');
let permissionsConfig = null;
let permissionsLoadTime = 0;

function loadPermissionsConfig() {
    try {
        if (!fs.existsSync(PERMISSIONS_FILE)) return null;
        const stats = fs.statSync(PERMISSIONS_FILE);
        if (stats.mtimeMs > permissionsLoadTime) {
            permissionsConfig = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf8'));
            permissionsLoadTime = stats.mtimeMs;
            logger.info('Loaded permissions from %s', PERMISSIONS_FILE);
        }
    } catch (err) {
        logger.error('Failed to load permissions: %s', err.message);
        return null; // fail closed
    }
    return permissionsConfig;
}

const ALL_CAPABILITIES = [
    'ai.use', 'ai.attachImage', 'ai.attachFile', 'ai.byok', 'pdf.extract',
    'api.use', 'crm.read', 'data.uploadTabular', 'data.uploadOther',
    'analysis.runLocal', 'analysis.share', 'chat.paste',
];
// Deny-by-default empty set (also the fail-closed result for a broken file).
const EMPTY_PERMISSIONS = () => ({ capabilities: [], limits: { maxPromptChars: 0, maxUploadBytes: 0, genaiPerDay: 0, apiPerDay: 0 }, models: [], apis: [] });
// Legacy/unconfigured: no permissions.json at all ⇒ no restrictions (opt-in feature).
const ALLOW_ALL = () => ({ capabilities: [...ALL_CAPABILITIES], limits: { maxPromptChars: null, maxUploadBytes: null, genaiPerDay: null, apiPerDay: null }, models: ['*'], apis: ['*'] });

// Resolve the effective permission set for a session: public | authenticated
// base, then (future) groups, then per-user additive. Deny-by-default within a
// configured file; permissive when no file exists; fail closed on a broken file.
// `userKeys` is an ordered list of identifiers (uid, login/username, email…) —
// the per-user layer matches on the first one present in `users`, so admins can
// key by whichever is convenient (e.g. an email).
function resolvePermissions(type, userKeys, groups) {
    if (!fs.existsSync(PERMISSIONS_FILE)) return ALLOW_ALL();   // feature not configured → legacy behavior
    const cfg = loadPermissionsConfig();
    if (!cfg) return EMPTY_PERMISSIONS();

    const layers = [];
    const base = type === 'public' ? cfg.public : cfg.authenticated;
    if (base) layers.push(base);
    for (const g of (groups || [])) { if (cfg.groups && cfg.groups[g]) layers.push(cfg.groups[g]); }
    if (type !== 'public' && cfg.users) {
        for (const k of (userKeys || [])) { if (cfg.users[k]) { layers.push(cfg.users[k]); break; } }
    }

    const eff = EMPTY_PERMISSIONS();
    const caps = new Set(), models = new Set(), apis = new Set();
    for (const layer of layers) {
        (layer.capabilities || []).forEach(c => caps.add(c));
        if (layer.limits) eff.limits = { ...eff.limits, ...layer.limits }; // most-specific wins
        (layer.models || []).forEach(m => models.add(m));
        (layer.apis || []).forEach(a => apis.add(a));
    }
    eff.capabilities = [...caps];
    eff.models = [...models];
    eff.apis = [...apis];
    return eff;
}

// null req.permissions = admin session → bypass all capability checks.
function permHas(req, cap) { return !req.permissions || req.permissions.capabilities.includes(cap); }
function denyPerm(res, cap) { return res.status(403).json({ error: `Not authorized: ${cap}` }); }

const LIMIT_KEYS = ['maxPromptChars', 'maxUploadBytes', 'genaiPerDay', 'apiPerDay'];

// Persist the permissions document (admin console). Mirrors saveApiDescriptors:
// write + refresh the in-memory cache so the new policy applies immediately.
function savePermissionsConfig(cfg) {
    fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    permissionsConfig = cfg;
    permissionsLoadTime = Date.now();
    logger.info('Saved permissions to %s', PERMISSIONS_FILE);
}

// Validate one permission layer (public/authenticated/a group/a user override).
function _validateLayer(layer, where) {
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) return `${where} must be an object`;
    if (layer.capabilities !== undefined) {
        if (!Array.isArray(layer.capabilities)) return `${where}.capabilities must be an array`;
        for (const c of layer.capabilities) {
            if (!ALL_CAPABILITIES.includes(c)) return `${where}.capabilities has unknown capability "${c}"`;
        }
    }
    if (layer.limits !== undefined && layer.limits !== null) {
        if (typeof layer.limits !== 'object' || Array.isArray(layer.limits)) return `${where}.limits must be an object`;
        for (const [k, v] of Object.entries(layer.limits)) {
            if (!LIMIT_KEYS.includes(k)) return `${where}.limits has unknown key "${k}"`;
            if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
                return `${where}.limits.${k} must be a non-negative number or null`;
            }
        }
    }
    for (const key of ['models', 'apis']) {
        if (layer[key] !== undefined && (!Array.isArray(layer[key]) || layer[key].some(x => typeof x !== 'string'))) {
            return `${where}.${key} must be an array of strings`;
        }
    }
    return null;
}

// Validate the whole permissions document. Returns an error string or null.
function validatePermissionsDoc(doc) {
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'permissions must be an object';
    const allowed = ['public', 'authenticated', 'groups', 'users'];
    for (const k of Object.keys(doc)) {
        if (!allowed.includes(k)) return `unknown top-level key "${k}" (allowed: ${allowed.join(', ')})`;
    }
    for (const single of ['public', 'authenticated']) {
        if (doc[single] != null) { const err = _validateLayer(doc[single], single); if (err) return err; }
    }
    for (const map of ['groups', 'users']) {
        if (doc[map] != null) {
            if (typeof doc[map] !== 'object' || Array.isArray(doc[map])) return `${map} must be an object`;
            for (const [k, layer] of Object.entries(doc[map])) {
                const err = _validateLayer(layer, `${map}["${k}"]`); if (err) return err;
            }
        }
    }
    return null;
}

// Resolves the built-in API key for a given session type.
// apiKey forms:
//   "key"              → available to all sessions (legacy / shorthand for { "*": "key" })
//   { "*": "key" }     → available to all sessions
//   { "public": "key" }→ only for public sessions
//   { "!public": "key"}→ all sessions except public
// Exact match > wildcard > negation. BYOK always takes precedence (handled by caller).
function resolveBuiltInKey(cfg, sessionType) {
    const raw = cfg.apiKey;
    if (!raw) return null;
    if (typeof raw === 'string') return raw || null;
    if (raw[sessionType]) return raw[sessionType];
    if (raw['*']) return raw['*'];
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('!') && k.slice(1) !== sessionType) return v || null;
    }
    return null;
}

router.get('/common/llm-configs', asyncHandler(async (req, res) => {
    const configs = loadLlmConfigs();
    const safe = configs.map(({ id, displayName, protocol, model, isDefault }) =>
        ({ id, displayName, protocol, model, isDefault }));
    res.json(safe);
}));

// ---------------------------------------------------------------------------
// LLM proxy — routes to Gemini / OpenAI / Anthropic based on protocol
// ---------------------------------------------------------------------------

router.post('/common/genai', asyncHandler(async (req, res) => {
    try {
        const request = req.body;
        const sessionInfo = req.session.connector.sessionInfo;
        if (!sessionInfo.orgId) {
            return res.status(400).json({ error: 'Invalid session' });
        }

        // Safe mode: the proxy must never forward file contents to the LLM.
        // Reject any request carrying attachments, regardless of what the
        // client requested — the user cannot override a proxy-level policy.
        if (loadProxyConfig().safeMode === true
            && Array.isArray(request.messages)
            && request.messages.some(m => Array.isArray(m.attachments) && m.attachments.length > 0)) {
            return res.status(403).json({ error: 'Attachments are not allowed: this proxy runs in safe mode (data stays local).' });
        }

        // --- Authorization (see docs/permissions.md) ---
        const perms = req.permissions;   // null for admin = bypass
        if (!permHas(req, 'ai.use')) return denyPerm(res, 'ai.use');
        if (perms) {
            const atts = (request.messages || []).flatMap(m => Array.isArray(m.attachments) ? m.attachments : []);
            for (const a of atts) {
                const isImage = String(a.mimeType || '').startsWith('image/');
                if (isImage && !permHas(req, 'ai.attachImage')) return denyPerm(res, 'ai.attachImage');
                if (!isImage && !permHas(req, 'ai.attachFile')) return denyPerm(res, 'ai.attachFile');
            }
            if (request.apiKey && !permHas(req, 'ai.byok')) return denyPerm(res, 'ai.byok');
            if (request.modelId && !(perms.models.includes('*') || perms.models.includes(request.modelId))) {
                return res.status(403).json({ error: `Model not allowed: ${request.modelId}` });
            }
            if (perms.limits.maxPromptChars != null) {
                const chars = (request.messages || []).reduce((n, m) => n + (m.content ? m.content.length : 0), 0);
                if (chars > perms.limits.maxPromptChars) {
                    return res.status(413).json({ error: `Message exceeds the ${perms.limits.maxPromptChars}-character limit.` });
                }
            }
        }

        let protocol, model, apiKey, baseUrl;

        if (!request.modelId) return res.status(400).json({ error: 'Missing modelId' });

        const configs = loadLlmConfigs();
        const cfg = configs.find(c => c.id === request.modelId);
        if (!cfg) return res.status(400).json({ error: `Unknown modelId: ${request.modelId}` });

        protocol = cfg.protocol;
        model = cfg.model;
        baseUrl = cfg.baseUrl;
        // BYOK takes precedence; otherwise use the built-in key for this session type
        apiKey = request.apiKey
            ? decrypt(request.apiKey, sessionInfo.orgId)
            : resolveBuiltInKey(cfg, req.session.type);
        if (!apiKey) return res.status(400).json({ error: `No API key for model '${request.modelId}' with session type '${req.session.type}'. Please provide your own key.` });

        logger.info('LLM proxy request protocol=%s model=%s', protocol, model);

        let llmResponse;
        if (protocol === 'gemini') {
            llmResponse = await _proxyGemini(request, model, apiKey);
        } else if (protocol === 'openai') {
            llmResponse = await _proxyOpenAI(request, model, apiKey, baseUrl);
        } else if (protocol === 'anthropic') {
            llmResponse = await _proxyAnthropic(request, model, apiKey, baseUrl);
        } else {
            return res.status(400).json({ error: `Unknown protocol: ${protocol}` });
        }

        pushEvent('genai', { ip: getClientIp(req), model, status: 200 });
        bumpDailyStat('genaiCalls');
        res.json(llmResponse);
    } catch (err) {
        logger.error('LLM Proxy Error: %s', err.message);
        res.status(500).json({ error: err.message });
    }
}));

async function _proxyGemini(request, model, apiKey) {
    const modelId = model || 'gemini-3-flash-preview';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
    const body = {
        system_instruction: { parts: [{ text: request.system }] },
        contents: request.messages.map(m => {
            const parts = [];
            if (m.content) parts.push({ text: m.content });
            for (const a of m.attachments || []) {
                parts.push({ inline_data: { mime_type: a.mimeType, data: a.data } });
            }
            if (parts.length === 0) parts.push({ text: '' });
            return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        }),
        generation_config: {
            temperature: request.options?.temperature ?? 0.5,
            ...(request.options?.thinking ? { thinking_config: { thinking_level: 'high', include_thoughts: true } } : {}),
            ...(request.options?.json    ? { response_mime_type: 'application/json' } : {}),
        },
    };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Gemini [${res.status}]: ${err.error?.message ?? res.statusText}`);
    }
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    return {
        text:    parts.filter(p => !p.thought && p.text).map(p => p.text).join(''),
        thoughts: parts.filter(p =>  p.thought && p.text).map(p => p.text).join('') || undefined,
    };
}

async function _proxyOpenAI(request, model, apiKey, baseUrl) {
    const base = baseUrl || 'https://api.openai.com';
    const body = {
        model: model || 'gpt-4o',
        messages: [
            { role: 'system', content: request.system },
            ...request.messages.map(m => {
                if (!m.attachments || m.attachments.length === 0) return { role: m.role, content: m.content };
                const parts = [];
                if (m.content) parts.push({ type: 'text', text: m.content });
                for (const a of m.attachments) {
                    const dataUrl = `data:${a.mimeType};base64,${a.data}`;
                    if (a.mimeType.startsWith('image/')) parts.push({ type: 'image_url', image_url: { url: dataUrl } });
                    else parts.push({ type: 'file', file: { filename: a.name, file_data: dataUrl } });
                }
                return { role: m.role, content: parts };
            }),
        ],
        temperature: request.options?.temperature ?? 0.5,
    };
    if (request.options?.json)    body.response_format = { type: 'json_object' };
    if (request.options?.thinking) body.thinking = { type: 'enabled' };
    const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`OpenAI [${res.status}]: ${err.error?.message ?? res.statusText}`);
    }
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    return { text: msg?.content ?? '', thoughts: msg?.reasoning_content || undefined };
}

async function _proxyAnthropic(request, model, apiKey, baseUrl) {
    const base = baseUrl || 'https://api.anthropic.com';
    const thinking = request.options?.thinking ?? false;
    const body = {
        model: model || 'claude-opus-4-5',
        system: request.system,
        messages: request.messages.map(m => {
            if (!m.attachments || m.attachments.length === 0) return { role: m.role, content: m.content };
            const blocks = [];
            if (m.content) blocks.push({ type: 'text', text: m.content });
            for (const a of m.attachments) {
                if (a.mimeType.startsWith('image/')) blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mimeType, data: a.data } });
                else if (a.mimeType === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
                else blocks.push({ type: 'text', text: `[Attachment ${a.name} (${a.mimeType}) could not be inlined]` });
            }
            return { role: m.role, content: blocks };
        }),
        max_tokens: thinking ? 16000 : 8192,
        temperature: thinking ? 1 : (request.options?.temperature ?? 0.5),
    };
    if (thinking) body.thinking = { type: 'enabled', budget_tokens: 10000 };
    const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Anthropic [${res.status}]: ${err.error?.message ?? res.statusText}`);
    }
    const data = await res.json();
    const blocks = data.content ?? [];
    return {
        text:    blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join(''),
        thoughts: blocks.filter(b => b.type === 'thinking').map(b => b.thinking ?? '').join('') || undefined,
    };
}

const normalizeForFuzzy = (str) => {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove accents
        .replace(/[^a-z0-9]/g, "");      // Remove punctuation/spaces
};

function extractWithPdfplumber(buffer) {
    return new Promise((resolve, reject) => {
        const py = spawn('python3', [path.join(__dirname, 'scripts/extract_pdf.py')]);
        let stdout = '';
        let stderr = '';
        py.stdout.on('data', d => { stdout += d; });
        py.stderr.on('data', d => { stderr += d; });
        // Absorb EPIPE silently — happens when Python exits before reading all stdin.
        // The 'close' handler below will surface the actual error via stderr/exit code.
        py.stdin.on('error', () => {});
        py.stdin.write(buffer);
        py.stdin.end();
        py.on('close', code => {
            if (code !== 0) return reject(new Error(stderr.trim() || 'PDF extraction script failed'));
            try {
                const result = JSON.parse(stdout);
                if (result.error) return reject(new Error(result.error));
                resolve(result);
            } catch (e) {
                reject(new Error('Invalid JSON from PDF extractor'));
            }
        });
        py.on('error', err => reject(new Error(`Failed to start Python: ${err.message}`)));
    });
}

router.post('/common/extract-pdf', throttler,
    (req, res, next) => {
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/pdf') || ct.includes('application/octet-stream')) {
            express.raw({ type: '*/*', limit: '50mb' })(req, res, next);
        } else {
            next();
        }
    },
    asyncHandler(async (req, res) => {
    // --- Authorization ---
    if (!permHas(req, 'pdf.extract')) return denyPerm(res, 'pdf.extract');

    const ct = req.headers['content-type'] || '';
    const isBinaryUpload = ct.includes('application/pdf') || ct.includes('application/octet-stream');

    let buffer;
    let searchString;

    if (isBinaryUpload) {
        if (!req.body || !req.body.length) return res.status(400).json({ error: 'Missing PDF file in request body' });
        buffer = req.body;
        if (req.permissions && req.permissions.limits.maxUploadBytes != null && buffer.length > req.permissions.limits.maxUploadBytes) {
            return res.status(413).json({ error: `File exceeds the ${req.permissions.limits.maxUploadBytes}-byte limit.` });
        }
        searchString = req.query.searchString;
    } else {
        const { url, searchString: bodySearchString } = req.body;
        searchString = bodySearchString;
        if (!url) return res.status(400).json({ error: 'Missing PDF URL or file' });

        // 1. Fetch PDF
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.statusText}`);
        buffer = Buffer.from(await response.arrayBuffer());
    }

    // 2. Extract text via pdfplumber (layout-preserving, handles complex tables)
    const { pages: extractedPages, metadata: pdfMeta } = await extractWithPdfplumber(buffer);
    const pagesContent = extractedPages.map(p => ({
        text: p.text,
        normalized: normalizeForFuzzy(p.text)
    }));

    // 3. Multi-Criteria Search Logic
    let finalContent = "";
    const searchTerms = searchString
        ? (Array.isArray(searchString) ? searchString : searchString.split(','))
            .map(term => normalizeForFuzzy(term.trim()))
            .filter(term => term.length > 0)
        : [];

    if (searchTerms.length > 0) {
        const matchedIndices = new Set();
        pagesContent.forEach((page, i) => {
            const hasMatch = searchTerms.some(term => page.normalized.includes(term));
            if (hasMatch) {
                if (i > 0) matchedIndices.add(i - 1);
                matchedIndices.add(i);
                if (i < pagesContent.length - 1) matchedIndices.add(i + 1);
            }
        });

        const sortedIndices = Array.from(matchedIndices).sort((a, b) => a - b);
        let lastIdx = -1;
        sortedIndices.forEach(idx => {
            if (lastIdx !== -1 && idx !== lastIdx + 1) {
                finalContent += `\n\n---\n[Omitted Content: Pages ${lastIdx + 2} to ${idx}]\n---\n\n`;
            }
            finalContent += `## Page ${idx + 1}\n\n${pagesContent[idx].text}\n\n`;
            lastIdx = idx;
        });
    } else {
        finalContent = pagesContent.map((p, i) => `## Page ${i + 1}\n\n${p.text}`).join('\n\n');
    }

    // 4. Enhanced Response with Metadata
    const returnedPages = (finalContent.match(/## Page/g) || []).length;
    pushEvent('pdf', { ip: getClientIp(req), pages: returnedPages });
    res.json({
        success: true,
        metadata: pdfMeta,
        returnedPages,
        content: finalContent.trim() || "No matches found for the given search criteria."
    });
}));

router.get('/common/extract-pdf/status', (req, res) => {
    const counts = limiter.counts(); // Gets internal bottleneck stats

    res.json({
        active: counts.running,      // Should be 0 or 1 based on our maxConcurrent
        queued: counts.queued,       // How many are currently waiting
        capacityRemaining: 50 - counts.queued,
        isFull: counts.queued >= 50,
        settings: {
            maxConcurrent: 1,
            minTime: "1000ms",
            queueLimit: 50
        }
    });
});

// CRM/ERP data access requires the crm.read capability (see docs/permissions.md).
router.use(['/metadata', '/data', '/attachments'], (req, res, next) => {
    if (!permHas(req, 'crm.read')) return denyPerm(res, 'crm.read');
    next();
});

router.get('/metadata', asyncHandler(async (req, res) => {
    const result = await req.session.connector.listObjectTypes();
    res.json(result);
}));

router.get('/metadata/:objectType', asyncHandler(async (req, res) => {
    const result = await req.session.connector.getObjectMetadata(req.params.objectType);
    res.json(result);
}));

router.get('/metadata/object-type/:id', asyncHandler(async (req, res) => {
    const result = await req.session.connector.getObjectTypeFromId(req.params.id);
    res.json(result);
}));

router.get('/data/:objectType', asyncHandler(async (req, res, next) => {
    const { fields, where, limit, order } = req.query;
    logger.info('getData', req.params.objectType, fields, where, limit, order);
    const parsedFields = fields ? fields.split(',') : null;
    try {
        const result = await req.session.connector.getData(req.params.objectType, {
            fields: parsedFields,
            limit: limit ? parseInt(limit) : undefined,
            order: order ? JSON.parse(order) : undefined,
            where: where ? JSON.parse(where) : undefined
        });
        res.json(result);
    } catch (err) {
        logger.error('getData error: %s', err.message);
        return res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Wrong query parameters'
            }
        });
    }
}));

router.get('/data/:objectType/:id', asyncHandler(async (req, res) => {
    const fields = typeof req.query?.fields === 'string' ? req.query.fields : undefined;
    const parsedFields = fields ? fields.split(',') : undefined;
    const result = await req.session.connector.getRecordById(req.params.objectType, req.params.id, parsedFields);
    res.json(result);
}));

router.post('/data/:objectType', asyncHandler(async (req, res) => {
    const result = await req.session.connector.createRecord(req.params.objectType, req.body);
    res.json(result);
}));

router.put('/data/:objectType/:id', asyncHandler(async (req, res) => {
    const result = await req.session.connector.updateData(req.params.objectType, req.params.id, req.body);
    res.json(result);
}));

router.delete('/data/:objectType/:id', asyncHandler(async (req, res) => {
    const result = await req.session.connector.deleteData(req.params.objectType, req.params.id);
    res.json(result);
}));

router.get('/attachments/:objectType/:id', asyncHandler(async (req, res) => {
    const { objectType, id } = req.params;
    const { mimeTypePrefix } = req.query;
    const attachments = await req.session.connector.getAttachments(objectType, id, mimeTypePrefix);
    res.json(attachments);
}));

// TODO: not tested yet
router.post('/api/send-email', asyncHandler(async (req, res) => {
    const { toAddresses, subject, body, from } = req.body;

    const result = await req.session.connector.sendEmail({ toAddresses, subject, body, from });
    res.json({ success: true, result });
}));

// ─── Admin routes (all require admin session via router.use('/admin', adminOnly) above) ───

router.get('/admin/events', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const kind = req.query.kind;
    let events = kind ? eventRing.filter(e => e.kind === kind) : eventRing;
    res.json(events.slice(-limit).reverse());
});

router.get('/admin/stats', async (req, res) => {
    const sessionStats = getSessionStats();
    const eventCounts = {};
    for (const e of eventRing) {
        eventCounts[e.kind] = (eventCounts[e.kind] || 0) + 1;
    }
    res.json({
        uptime: Math.floor((Date.now() - startTime) / 1000),
        sessions: { total: sessionStats.total, active: sessionStats.active, byType: sessionStats.byType },
        events: { total: eventRing.length, byKind: eventCounts },
        rateLimit: {
            publicApi:   { callsToday: dailyStats.apiCalls,   limitPerIpPerDay: loadProxyConfig().publicSessionLimiterConfiguration?.apiPerIpPerDay   ?? 5000 },
            publicGenai: { callsToday: dailyStats.genaiCalls, limitPerIpPerDay: loadProxyConfig().publicSessionLimiterConfiguration?.genaiPerIpPerDay ?? 40   },
        },
    });
});

router.get('/admin/config', (req, res) => {
    res.json(loadProxyConfig());
});

router.get('/admin/sessions', (req, res) => {
    res.json(getAllSessions());
});

router.get('/admin/api-config', (req, res) => {
    res.json(loadApiDescriptors());
});

router.post('/admin/api-config', (req, res) => {
    const descriptors = loadApiDescriptors();
    const newConfig = { ...req.body, id: req.body.id || crypto.randomUUID() };
    descriptors.push(newConfig);
    saveApiDescriptors(descriptors);
    res.status(201).json(newConfig);
});

router.put('/admin/api-config/:id', (req, res) => {
    const descriptors = loadApiDescriptors();
    const idx = descriptors.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    descriptors[idx] = { ...descriptors[idx], ...req.body, id: req.params.id };
    saveApiDescriptors(descriptors);
    res.json(descriptors[idx]);
});

router.delete('/admin/api-config/:id', (req, res) => {
    const descriptors = loadApiDescriptors();
    const idx = descriptors.findIndex(d => d.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    descriptors.splice(idx, 1);
    saveApiDescriptors(descriptors);
    res.status(204).end();
});

// ─── Permissions (authorization) config — see docs/permissions.md ───
// The whole document is read/written at once. `configured: false` means no
// permissions.json exists → legacy behaviour (everyone gets full access).
// All three verbs return the SAME shape (incl. the canonical `capabilities`
// list) so the console can apply any response without re-fetching.
const permissionsPayload = (configured, permissions) =>
    ({ configured, permissions, capabilities: ALL_CAPABILITIES, limitKeys: LIMIT_KEYS });

router.get('/admin/permissions', (req, res) => {
    const configured = fs.existsSync(PERMISSIONS_FILE);
    res.json(permissionsPayload(configured, configured ? loadPermissionsConfig() : null));
});

router.put('/admin/permissions', (req, res) => {
    const err = validatePermissionsDoc(req.body);
    if (err) return res.status(400).json({ error: err });
    try {
        savePermissionsConfig(req.body);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
    res.json(permissionsPayload(true, req.body));
});

// Removing the file reverts to legacy "no restrictions". Destructive — the UI
// confirms first.
router.delete('/admin/permissions', (req, res) => {
    try {
        if (fs.existsSync(PERMISSIONS_FILE)) fs.unlinkSync(PERMISSIONS_FILE);
        permissionsConfig = null;
        permissionsLoadTime = 0;
        logger.info('Deleted %s — reverted to legacy allow-all', PERMISSIONS_FILE);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
    res.json(permissionsPayload(false, null));
});

router.use((err, req, res, next) => {
    console.error('[daquota proxy] internal error', err);

    // Salesforce (jsforce) errors often have `errorCode` and `message`
    if (err.errorCode) {
        return res.status(400).json({
            success: false,
            error: {
                code: err.errorCode,
                message: err.message,
                fields: err.fields || []
            }
        });
    }

    // Generic error fallback
    if (!res.headersSent) {
        res.status(500).json({
            success: false,
            error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: err.message || 'Internal server error'
            }
        });
    }
});

module.exports = router;
