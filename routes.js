const express = require('express');
const router = express.Router();

const { createSession, getSession } = require('./sessionManager.js');
const { SalesforceConnector } = require('./connectors/salesforce.js');
const { OdooConnector } = require('./connectors/odoo.js');

const connectorMap = {
    salesforce: SalesforceConnector,
    odoo: OdooConnector
};

const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

router.post('/session', asyncHandler(async (req, res) => {
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

router.use((req, res, next) => {
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

router.get('/session', asyncHandler(async (req, res) => {
    const sessionInfo = await req.session.connector.getSessionInfo();
    console.log('[daquota proxy] sessionInfo', JSON.stringify(sessionInfo, null, 2));
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

router.get('/metadata', asyncHandler(async (req, res) => {
    const result = await req.session.connector.listObjectTypes();
    res.json(result);
}));

router.get('/metadata/:objectType', asyncHandler(async (req, res) => {
    const result = await req.session.connector.getObjectMetadata(req.params.objectType);
    res.json(result);
}));

router.get('/data/:objectType', asyncHandler(async (req, res, next) => {
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
