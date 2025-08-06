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

app.post('/session', async (req, res) => {
    const { type, config } = req.body;
    console.log('[daquota proxy] create new session', type, config);
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
});

app.get('/session', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const session = getSession(token, req).getSessionInfo();
    if (!session) return res.status(403).json({ error: 'Session expired or invalid' });

    res.json(session);
});

app.use((req, res, next) => {
    console.info('intercept', req.path);
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

app.get('/metadata', async (req, res) => {
    try {
        console.log('GetMetadata');
        const result = await req.session.connector.listObjectTypes();
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/metadata/:objectType', async (req, res) => {
    try {
        console.log('GetMetadata', req.params.objectType);
        const result = await req.session.connector.getObjectMetadata(req.params.objectType);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/data/:objectType', async (req, res) => {
    try {
        const { fields, where, limit, order } = req.query;
        console.log('getData', req.params.objectType, fields, limit, JSON.stringify(order));
        const parsedFields = fields ? fields.split(',') : null;
        const result = await req.session.connector.getData(req.params.objectType, {
            fields: parsedFields,
            limit: limit ? parseInt(limit) : undefined,
            order: order ? JSON.parse(order) : undefined,
            where: where ? JSON.parse(where) : undefined
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/data/:objectType/:id', async (req, res) => {
    try {
        const fields = typeof req.query?.fields === 'string' ? req.query.fields : undefined;
        const parsedFields = fields ? fields.split(',') : undefined;
        const result = await req.session.connector.getRecordById(req.params.objectType, req.params.id, parsedFields);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/data/:objectType', async (req, res) => {
    try {
        const result = await req.session.connector.createRecord(req.params.objectType, req.body);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/data/:objectType/:id', async (req, res) => {
    try {
        const result = await req.session.connector.updateData(req.params.objectType, req.params.id, req.body);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/data/:objectType/:id', async (req, res) => {
    try {
        const result = await req.session.connector.deleteData(req.params.objectType, req.params.id);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/attachments/:objectType/:id', async (req, res) => {
    try { 
        const { objectType, id } = req.params;
        const { mimeTypePrefix } = req.query;
        const attachments = await req.session.connector.getAttachments(objectType, id, mimeTypePrefix);
        res.json(attachments);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/context', async (req, res) => {
  try {
    const context = await req.session.connector.getContext();
    res.json(context);
  } catch (err) {
    console.error('Error in /context/context:', err);
    res.status(500).json({ error: 'Failed to fetch context' });
  }
});

// TODO: not tested yet
app.post('/api/send-email', async (req, res) => {
  try {
    const { toAddresses, subject, body, from } = req.body;

    const result = await req.session.connector.sendEmail({ toAddresses, subject, body, from });
    res.json({ success: true, result });
  } catch (err) {
    console.error('Email send failed:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
    console.log(`API Proxy running at http://localhost:${PORT}`);
});
