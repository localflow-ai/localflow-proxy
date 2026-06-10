require('dotenv').config();                                        // load .env
require('dotenv').config({ path: '.env.local', override: true }); // .env.local takes precedence

const express = require('express');
const cors = require('cors');
const routes = require('./routes.js');

const { getLogger } = require('./logging');
const logger = getLogger('index');

const app = express();
app.set('trust proxy', true);
app.use(cors({
    origin: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Proxy-Token', 'X-Proxy-API-Key', 'Range'],
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = process.env.PORT ?? 3000;

app.use('/', routes);

app.listen(PORT, () => {
    logger.info(`API Proxy running at http://localhost:${PORT}`);
});
