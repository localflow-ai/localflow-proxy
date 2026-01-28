const express = require('express');
const cors = require('cors');
const router = express.Router();

router.use(cors({
    origin: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Proxy-Token'],
    credentials: true
}));

const { createSession, getSession } = require('./sessionManager.js');
const { SalesforceConnector } = require('./connectors/salesforce.js');
const { OdooConnector } = require('./connectors/odoo.js');
const { trackAccess } = require('./accessTracker.js');
const { encrypt, decrypt } = require('./encryption.js');

const { getLogger } = require('./logging');
const logger = getLogger('routes');

const fetch = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));

const connectorMap = {
    salesforce: SalesforceConnector,
    odoo: OdooConnector
};

const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

router.post('/session', asyncHandler(async (req, res) => {
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

router.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        return next();
    }

    logger.info('request %s %s', req.method, req.path);

    const auth = req.headers['x-proxy-token']; 
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid proxy token' });
    }

    const token = auth.split(' ')[1];
    const session = getSession(token, req);

    if (!session) {
        return res.status(403).json({ error: 'Session expired or invalid' });
    }

    req.session = session;
    next();
});

/**
 * API Proxy Endpoint
 * Logic: Forwards request to target ?url=... while filtering sensitive headers
 * Authenticated: Requires valid session token in Authorization header
 */
router.all('/common/api-proxy', asyncHandler(async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'Missing target url' });

    logger.info('Proxying %s: %s', req.method, targetUrl);

    // --- REQUEST HEADERS (Port of applyRequestHeaders) ---
    const forbiddenRequestHeaders = [
        'host', 'referer', 'x-forwarded-for', 'x-real-ip', 'cookie', 
        'connection', 'content-length' // Content-Length is recalculated by fetch
    ];
    
    const requestHeaders = {};
    Object.keys(req.headers).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (!forbiddenRequestHeaders.includes(lowerKey) && 
            !lowerKey.startsWith('sec-') && 
            lowerKey !== 'x-proxy-token') {
            requestHeaders[key] = req.headers[key];
        }
    });

    // Forced User-Agent from your PHP script
    requestHeaders['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

    const fetchOptions = {
        method: req.method,
        headers: requestHeaders,
        redirect: 'follow',
        // This allows node-fetch to handle decompression but we must strip headers later
        compress: true 
    };

    // --- BODY HANDLING ---
    // Instead of JSON.stringify(req.body), we use the raw stream if possible
    // or req.body if it's already parsed.
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (Object.keys(req.body).length > 0) {
            fetchOptions.body = JSON.stringify(req.body);
        }
    }

    try {
        const response = await fetch(targetUrl, fetchOptions);

        // --- RESPONSE HEADERS (Port of applyResponseHeaders) ---
        res.status(response.status);

        const forbiddenResponseHeaders = [
            'access-control-allow-origin', 
            'access-control-allow-credentials',
            'access-control-allow-headers',
            'access-control-allow-methods',
            'transfer-encoding', 
            'connection', 
            'www-authenticate',
            'content-encoding', // CRITICAL: node-fetch decompresses automatically
            'content-length'    // CRITICAL: length changes after decompression
        ];

        response.headers.forEach((value, name) => {
            const lowerName = name.toLowerCase();
            // Mimic PHP: if (strpos('Access-Control', $value) !== false) continue;
            if (lowerName.includes('access-control')) return;
            
            if (!forbiddenResponseHeaders.includes(lowerName)) {
                res.setHeader(name, value);
            }
        });

        // Ensure we don't send a default text/html content type if the target didn't provide one
        if (!response.headers.has('content-type')) {
            res.setHeader('Content-Type', '');
        }

        // --- STREAMING OUTPUT ---
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

    const stats = trackAccess(userId, resource, readOnly);
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
