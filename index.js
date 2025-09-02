const express = require('express');
const cors = require('cors');
const routes = require('./routes.js');

//dotenv.config();
const app = express();
app.use(cors());
app.use(express.json()); // Needed for parsing JSON bodies
const PORT = 3000;

app.use('/', routes);

app.listen(PORT, () => {
    console.log(`API Proxy running at http://localhost:${PORT}`);
});
