import express from 'express';
import cors from 'cors';
import routes from './routes.js';

import { getLogger } from './logging.js';
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
