const { API_URL, API_TOKEN } = require('./daquota-proxy-test.config');
const { ProxyClient } = require('./ProxyClient');

const client = new ProxyClient(API_URL, API_TOKEN);
describe('Login API', () => {
    it('devrait retourner un token si les identifiants sont valides', async () => {
     
        console.log('start test')
            
        const objectTypes = await client.listObjectTypes();
        console.log('listObjectTypes', objectTypes)
        // const result = { token: 'fake-token-123', userId: 1 }
        // // Assertions
        // expect(result).toBeDefined();
        // expect(result.token).toBe('fake-token-123');
        // expect(result.userId).toBe(1);
    });

});