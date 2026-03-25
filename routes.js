const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { createSession, getSession } = require('./sessionManager.js');
const { SalesforceConnector } = require('./connectors/salesforce.js');
const { OdooConnector } = require('./connectors/odoo.js');
const { PublicConnector } = require('./connectors/public.js');
const { trackAccess } = require('./accessTracker.js');
const { encrypt, decrypt } = require('./encryption.js');
const pdf = require('pdf-parse');
const Bottleneck = require("bottleneck");

const { getLogger } = require('./logging');
const logger = getLogger('routes');

const DESCRIPTORS_FILE = process.env.API_CONFIG_FILE || path.join(__dirname, 'api-config.json');
let apiDescriptors = [];
let lastLoadTime = 0;
const nextAllowedTimes = new Map();

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

// Create a group of limiters
const publicGroup = new Bottleneck.Group({
    reservoir: 30,           // Initial "tokens" (max calls)
    reservoirRefreshAmount: 30,
    reservoirRefreshInterval: 60 * 60 * 1000 * 24, // Reset every 24 hours

    // Strategy: fail immediately when the reservoir is empty
    rejectOnDrop: true
});

// Optional: Log when an IP is blocked
publicGroup.on('failed', (error, jobInfo) => {
    logger.warn('Rate limit job failed for IP: %s', jobInfo.options.id);
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
        res.json({ token });
    } catch (err) {
        res.status(401).json({ error: 'Authentication failed', detail: err.message });
    }
}));

router.post('/external-signup', express.json(), asyncHandler(async (req, res) => {
    const { tenant, login, password, token } = req.body;

    try {
        const odoo = new OdooConnector();

        await odoo.login({
            url: `https://odoo.localflow.fr`,
            db: tenant,
            username: 'renaud.pawlak@localflow.fr',
            password: '***REMOVED***' // 'nur1A' + tenant + '*'
        });

        const result = await odoo.execute_kw('res.users', 'signup', [
            [
                { login: login, password: password },
                token
            ],
        ]);

        res.json({ success: true, result });
    } catch (err) {
        // Odoo returns errors if the token is expired or login is wrong
        res.status(400).json({ error: err.message });
    }
}));

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
        const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

        try {
            // schedule() will check the reservoir for this specific IP limiter
            // If the IP has exceeded 100 calls, it will throw a Bottleneck Error
            await publicGroup.key(clientIp).schedule(() => Promise.resolve());
        } catch (err) {
            logger.warn('Rate limit triggered for IP %s', clientIp);
            return res.status(429).json({
                error: 'Too many requests',
                detail: 'Public session rate limit exceeded.'
            });
        }
    }
    // ---------------------------------

    req.session = session;
    next();
});

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

    console.log("FINAL OUTBOUND HEADERS:", requestHeaders);

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
        const response = await fetch(finalUrl, fetchOptions);
        res.status(response.status);

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

router.post('/common/genai', asyncHandler(async (req, res) => {
    try {
        const { encryptedApiKey, model, ...geminiPayload } = req.body;

        logger.info('Received Gemini proxy request for model %s', model || 'gemini-3-flash-preview');

        if (!encryptedApiKey) {
            return res.status(400).json({ error: "Missing encrypted API key" });
        }

        const sessionInfo = req.session.connector.sessionInfo;
        if (!sessionInfo.orgId) {
            return res.status(400).json({ error: 'Invalid session' });
        }
        logger.info('Encrypted: %s', encryptedApiKey);
        logger.info('OrgId: %s', sessionInfo.orgId);
        // 1. Decrypt the user's key
        const apiKey = decrypt(encryptedApiKey, sessionInfo.orgId);

        logger.info('Decrypted API key: %s', apiKey.replace(/.(?=.{4})/g, '*'));

        const modelId = model || 'gemini-3-flash-preview';
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

        // 2. Forward to Gemini using your fetch wrapper
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload)
        });

        const data = await response.json();

        if (!response.ok) {
            logger.error('Gemini API error: %s', JSON.stringify(data));
        }

        // 3. Return the exact response from Gemini
        res.status(response.status).json(data);
    } catch (err) {
        console.error("Proxy Error:", err);
        res.status(500).json({ error: "Internal Server Error", details: err.message });
    }
}));

const normalizeForFuzzy = (str) => {
    if (!str) return "";
    return str.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove accents
        .replace(/[^a-z0-9]/g, "");      // Remove punctuation/spaces
};

async function pagerender(pageData) {
    const textContent = await pageData.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false
    });

    const items = textContent.items.sort((a, b) => {
        if (Math.abs(a.transform[5] - b.transform[5]) > 3) {
            return b.transform[5] - a.transform[5];
        }
        return a.transform[4] - b.transform[4];
    });

    let lastY = -1;
    let lastXEnd = -1;
    let text = '';

    for (let item of items) {
        let str = item.str;
        if (!str.replace(/\s+/g, '')) continue;

        // --- DÉTECTION DU STYLE ---
        const style = textContent.styles[item.fontName];
        const fontName = style ? (style.fontFamily || "").toLowerCase() : "";

        const isBold = fontName.includes('bold') || fontName.includes('black') || fontName.includes('heavy');
        const isItalic = fontName.includes('italic') || fontName.includes('oblique');

        let styledStr = str;
        if (isBold && isItalic) styledStr = `***${str.trim()}***`;
        else if (isBold) styledStr = `**${str.trim()}**`;
        else if (isItalic) styledStr = `*${str.trim()}*`;

        const currentY = item.transform[5];
        const currentX = item.transform[4];

        // --- GESTION DES LIGNES ---
        if (lastY !== -1 && Math.abs(currentY - lastY) > 3) {
            text += (Math.abs(currentY - lastY) > 12) ? '\n\n' : '\n';
            lastXEnd = -1;
        }

        // --- ESPACES ---
        if (lastXEnd !== -1 && (currentX - lastXEnd) > 1.0) {
            if (!text.endsWith(' ') && !styledStr.startsWith(' ')) {
                text += ' ';
            }
        }

        // --- STRUCTURE ---
        const isHeader = (str === str.toUpperCase() && str.length > 4) || /^[0-9A-Z]{1,2}[\.\-\)]\s/.test(str);
        if (isHeader && (text.endsWith('\n\n') || text === '')) {
            styledStr = `### ${styledStr}`;
        }
        if (/^[\u2022\u00b7\u25cf\-\*]/.test(str.trim())) {
            styledStr = `- ${str.trim().substring(1).trim()}`;
        }

        text += styledStr;
        lastY = currentY;
        lastXEnd = currentX + (item.width || 0);
    }

    // 1. Fusionne les blocs de gras adjacents : **M****odification** -> **Modification**
    // 2. Gère aussi les cas avec un espace : **M** **odification** -> **M modification**
    return text
        .replace(/\*\*\s*\*\*/g, '')  // Fusionne le gras
        .replace(/\*\s*\*/g, '')      // Fusionne l'italique
        .replace(/\*\*\*\s*\*\*\*/g, ''); // Fusionne le combo
}

router.post('/common/extract-pdf', throttler, asyncHandler(async (req, res) => {
    const { url, searchString } = req.body;

    if (!url) return res.status(400).json({ error: 'Missing PDF URL' });

    // 1. Fetch PDF
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch PDF: ${response.statusText}`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const pagesContent = [];

    // 2. Extraction via the optimized pagerender (Heuristics)
    const options = {
        pagerender: async (pageData) => {
            const text = await pagerender(pageData);
            pagesContent.push({
                text: text,
                normalized: normalizeForFuzzy(text)
            });
            return text;
        }
    };

    const data = await pdf(buffer, options);

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
    res.json({
        success: true,
        metadata: {
            title: data.info?.Title || "Unknown",
            author: data.info?.Author || "Unknown",
            creator: data.info?.Creator || "Unknown",
            producer: data.info?.Producer || "Unknown",
            creationDate: data.info?.CreationDate || null,
            modificationDate: data.info?.ModDate || null,
            totalPdfPages: data.numpages
        },
        returnedPages: (finalContent.match(/## Page/g) || []).length,
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
        logger.error('getData error', err);
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
