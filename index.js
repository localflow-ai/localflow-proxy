import express from 'express';
import cors from 'cors';
//import dotenv from 'dotenv';

import { createSession, getSession } from './sessionManager.js';
import { SalesforceConnector } from './connectors/salesforce.js';
import { OdooConnector } from './connectors/odoo.js';

//dotenv.config();
const app = express();
app.use(cors());
app.use(express.json()); // Needed for parsing JSON bodies
const PORT = 3000;

const connectorMap = {
    salesforce: SalesforceConnector,
    odoo: OdooConnector
};

const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(err => {
        console.error('[daquota proxy] internal error', err);
        res.status(500).json({ error: err.message || 'Internal server error' });
        next(err);
    });
};

// app.use((err, req, res, next) => {
//     console.error('[daquota proxy] internal error', err);
//     res.status(500).json({ error: err.message || 'Internal server error' });
// });

app.post('/session', asyncHandler(async (req, res) => {
    const { type, config } = req.body;
    console.log('[daquota proxy] create new session', type);
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

app.use((req, res, next) => {
    console.info('[daquota proxy] request', req.method, req.path);
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid token' });
    }

    const token = auth.split(' ')[1];
    const session = getSession(token, req);

    if (!session) {
        return res.status(403).json({ error: 'Session expired or invalid' });
    }

    req.session = session;
    //console.info('injected session', req.session);
    next();
});

app.get('/session', asyncHandler(async (req, res) => {
    const sessionInfo = await req.session.connector.getSessionInfo();
    console.log('[daquota proxy] sessionInfo', JSON.stringify(sessionInfo, null, 2));
    res.json(sessionInfo);
}));

app.post('/session/field-mapping', (req, res) => {
    const result = req.session.connector.createFieldMapping(req.body);
    res.json(result);
});

app.get('/metadata', asyncHandler(async (req, res) => {
    const result = await req.session.connector.listObjectTypes();
    res.json(result);
}));

app.get('/metadata/:objectType', asyncHandler(async (req, res) => {
    const result = await req.session.connector.getObjectMetadata(req.params.objectType);
    res.json(result);
}));

app.get('/data/:objectType', asyncHandler(async (req, res, next) => {
    const { fields, where, limit, order } = req.query;
    console.log('[daquota proxy] getData', req.params.objectType, fields, where, limit, order);
    const parsedFields = fields ? fields.split(',') : null;
    const result = await req.session.connector.getData(req.params.objectType, {
        fields: parsedFields,
        limit: limit ? parseInt(limit) : undefined,
        order: order ? JSON.parse(order) : undefined,
        where: where ? JSON.parse(where) : undefined
    });
    res.json(result);
}));

app.get('/data/:objectType/:id', asyncHandler(async (req, res) => {
    const fields = typeof req.query?.fields === 'string' ? req.query.fields : undefined;
    const parsedFields = fields ? fields.split(',') : undefined;
    const result = await req.session.connector.getRecordById(req.params.objectType, req.params.id, parsedFields);
    res.json(result);
}));

app.post('/data/:objectType', asyncHandler(async (req, res) => {
    const result = await req.session.connector.createRecord(req.params.objectType, req.body);
    res.json(result);
}));

app.put('/data/:objectType/:id', asyncHandler(async (req, res) => {
    const result = await req.session.connector.updateData(req.params.objectType, req.params.id, req.body);
    res.json({ success: true, result });
}));

app.delete('/data/:objectType/:id', asyncHandler(async (req, res) => {
    const result = await req.session.connector.deleteData(req.params.objectType, req.params.id);
    res.json({ success: true, result });
}));

app.get('/attachments/:objectType/:id', asyncHandler(async (req, res) => {
    const { objectType, id } = req.params;
    const { mimeTypePrefix } = req.query;
    const attachments = await req.session.connector.getAttachments(objectType, id, mimeTypePrefix);
    res.json(attachments);
}));

// TODO: not tested yet
app.post('/api/send-email', asyncHandler(async (req, res) => {
    const { toAddresses, subject, body, from } = req.body;

    const result = await req.session.connector.sendEmail({ toAddresses, subject, body, from });
    res.json({ success: true, result });
}));

app.listen(PORT, () => {
    console.log(`API Proxy running at http://localhost:${PORT}`);
});
