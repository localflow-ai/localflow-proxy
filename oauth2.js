const { getLogger } = require('./logging');
const logger = getLogger('oauth2');
const fetch = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));

const tokenCache = new Map(); // Stores { token: string, expires: number }

async function getOAuth2Token(ds) {
    const cached = tokenCache.get(ds.id);
    if (cached && cached.expires > Date.now() + 60000) return cached.token;

    logger.info('Fetching new OAuth2 token for %s', ds.id);
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', ds.oAuth2Login);
    params.append('client_secret', ds.oAuth2Password);
    params.append('scope', ds.oAuth2Scopes);

    const authRes = await fetch(ds.oAuth2TokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
    });

    if (!authRes.ok) throw new Error(`OAuth2 Failed: ${authRes.statusText}`);
    
    const data = await authRes.json();
    // Cache token (subtract 30s for safety)
    tokenCache.set(ds.id, {
        token: data.access_token,
        expires: Date.now() + (data.expires_in * 1000) - 30000
    });
    return data.access_token;
}

module.exports = { getOAuth2Token };