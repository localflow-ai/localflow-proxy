const express = require('express');
const cors = require('cors');
const routes = require('./routes.js');

const { getLogger } = require('./logging');
const logger = getLogger('index');

//dotenv.config();
const app = express();
app.use(cors({
    origin: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Proxy-Token', 'X-Proxy-API-Key'],
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const PORT = 3000;

app.use('/', routes);

app.listen(PORT, () => {
    logger.info(`API Proxy running at http://localhost:${PORT}`);
});
