const express = require('express');
const cors = require('cors');
const routes = require('./routes.js');

const { getLogger } = require('./logging');
const logger = getLogger('index');

//dotenv.config();
const app = express();
app.use(cors());
app.use(express.json()); // Needed for parsing JSON bodies
const PORT = 3000;

app.use('/', routes);

app.listen(PORT, () => {
    logger.info(`API Proxy running at http://localhost:${PORT}`);
});
