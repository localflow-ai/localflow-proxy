const { API_URL, API_TOKEN } = require('./daquota-proxy-test.config');
const { ProxyClient } = require('./ProxyClient');

//read -s daquotaPass
//DAQUOTA_PROXY_TEST_USERNAME="louis.grignon@protonmail.com" DAQUOTA_PROXY_TEST_PASS="$daquotaPass" npm test

const config = {
    "url": "https://localflow.fr",
    "db": "odoo",
    "clientId": "",
    "username": process.env.DAQUOTA_PROXY_TEST_USERNAME,
    "password": process.env.DAQUOTA_PROXY_TEST_PASS,
}

const client = new ProxyClient(API_URL);
describe('Proxy', () => {
    let client;

    beforeEach(async () => {
        client = new ProxyClient('http://localhost:3000'); // Remplace par ton URL de base
        const result = await client.connect('odoo', config);
        console.log('login result: ', result);
        expect(result).toBeDefined();
        expect(result.token).toBeDefined();
        expect(client.isConnected()).toBe(true);
    });

    describe('Session', () => {
        it('can get session info', async () => {
            const info = await client.getSessionInfo();
            console.log('getSessionInfo result', info)
            expect(info).toBeDefined();
            expect(info.db).toBe(config.db);
            expect(info.url).toBe(config.url);
            expect(info.username).toBe(config.username);
            expect(info.userId).toBeDefined();
        });
    });
    function deepDiff(obj1, obj2, path = "", differences = []) {
        // Si les valeurs sont strictement égales, pas de différence
        if (obj1 === obj2) {
            return differences;
        }

        // Si l'un des deux n'est pas un objet ou est null
        if (typeof obj1 !== 'object' || obj1 === null || typeof obj2 !== 'object' || obj2 === null) {
            differences.push({
                path: path || "root",
                value1: obj1,
                value2: obj2,
            });
            return differences;
        }

        // Récupère les clés des deux objets
        const keys1 = Object.keys(obj1);
        const keys2 = Object.keys(obj2);

        // Vérifie les clés présentes dans obj1 mais pas dans obj2
        for (const key of keys1) {
            if (!keys2.includes(key)) {
                differences.push({
                    path: path ? `${path}.${key}` : key,
                    value1: obj1[key],
                    value2: undefined,
                });
            }
        }

        // Vérifie les clés présentes dans obj2 mais pas dans obj1
        for (const key of keys2) {
            if (!keys1.includes(key)) {
                differences.push({
                    path: path ? `${path}.${key}` : key,
                    value1: undefined,
                    value2: obj2[key],
                });
            }
        }

        // Compare les valeurs pour les clés communes
        const commonKeys = keys1.filter(key => keys2.includes(key));
        for (const key of commonKeys) {
            const currentPath = path ? `${path}.${key}` : key;
            deepDiff(obj1[key], obj2[key], currentPath, differences);
        }

        return differences;
    }



    describe('Odoo mapping scenario', () => {
        it('can create and get mapping', async () => {

            const objectTypeMapping = {
                "fr.localflow.geodata": "LocalFlow__GeoData__c",
                "res.partner": "Account"
            };
            const result1 = await client.createObjectTypeMapping(objectTypeMapping);
            expect(result1).toBeDefined();
            console.log("create object type mapping result", result1)

            const fieldMapping = {
                "id": "Id",
                "name": "Name",
                "email": "Email",
                "street": "DefaultAddress.street",
                "city": "DefaultAddress.city|DefaultCity",
                "state_id[1]": "DefaultAddress.state",
                "zip": "DefaultAddress.postalCode",
                "country_id[1]": "DefaultAddress.country",
                "partner_latitude": "DefaultAddress.latitude|DefaultLatitude",
                "partner_longitude": "DefaultAddress.longitude|DefaultLongitude"
            };
            const result2 = await client.createFieldMapping(fieldMapping);
            expect(result2).toBeDefined();
            console.log("create field mapping result", result2)

            const fieldMappingGeoData = {
                "content": "LocalFlow__Content__c",
                "type": "LocalFlow__Type__c"
            };
            const result3 = await client.createFieldMapping('fr.localflow.geodata', fieldMappingGeoData);
            expect(result3).toBeDefined();
            console.log("create field mapping result for geodata", result3)

            const resultSession = await client.getSessionInfo();
            console.log('getSessionInfo result after mapping', resultSession)
            expect(resultSession).toBeDefined();
            const expected = {
                "url": "https://localflow.fr",
                "db": "odoo",
                "username": config.username,
                "userId": 2,
                "mappings": {
                    "objectTypeMapping": {
                        "fr.localflow.geodata": "LocalFlow__GeoData__c"
                    },
                    "objectTypeMappingReversed": {
                        "LocalFlow__GeoData__c": "fr.localflow.geodata"
                    },
                    "fieldMapping": {
                        "$global": {
                            "id": "Id",
                            "name": "Name",
                            "email": "Email",
                            "street": "DefaultAddress.street",
                            "city": "DefaultAddress.city",
                            "state_id": "DefaultAddress.state",
                            "state_id$$index": 1,
                            "zip": "DefaultAddress.postalCode",
                            "country_id": "DefaultAddress.country",
                            "country_id$$index": 1,
                            "partner_latitude": "DefaultAddress.latitude",
                            "partner_longitude": "DefaultAddress.longitude"
                        },
                        "fr.localflow.geodata": {
                            "content": "LocalFlow__Content__c",
                            "type": "LocalFlow__Type__c"
                        }
                    },
                    "fieldMappingReversed": {
                        "$global": {
                            "Id": "id",
                            "Name": "name",
                            "Email": "email",
                            "DefaultAddress": [
                                "street",
                                "city",
                                "state_id",
                                "zip",
                                "country_id",
                                "partner_latitude",
                                "partner_longitude"
                            ],
                            "DefaultAddress.street": "street",
                            "DefaultAddress.city": "city",
                            "DefaultCity": "city",
                            "DefaultAddress.state$$conf": {
                                "readonly": true
                            },
                            "DefaultAddress.state": "state_id",
                            "DefaultAddress.postalCode": "zip",
                            "DefaultAddress.country$$conf": {
                                "readonly": true
                            },
                            "DefaultAddress.country": "country_id",
                            "DefaultAddress.latitude": "partner_latitude",
                            "DefaultLatitude": "partner_latitude",
                            "DefaultAddress.longitude": "partner_longitude",
                            "DefaultLongitude": "partner_longitude"
                        },
                        "fr.localflow.geodata": {
                            "LocalFlow__Content__c": "content",
                            "LocalFlow__Type__c": "type"
                        }
                    }
                },
                "context": {
                    "configuration": {
                        "userObject": "res.users",
                        "userFields": [
                            "Id",
                            "Name",
                            "Email",
                            "login",
                            "active"
                        ],
                        "userWhere": {
                            "active": true
                        },
                        "userNameField": "login",
                        "idField": "Id"
                    },
                    "user": {
                        "id": 2,
                        "name": config.username,
                        "email": config.username,
                        "isAdmin": true,
                        "permissions": [
                            {
                                "type": "Group",
                                "id": 2,
                                "name": "Access Rights",
                                "category": "Administration"
                            },
                            {
                                "type": "Group",
                                "id": 8,
                                "name": "Access to export feature",
                                "category": "Technical"
                            },
                            {
                                "type": "Group",
                                "id": 3,
                                "name": "Bypass HTML Field Sanitize",
                                "category": null
                            },
                            {
                                "type": "Group",
                                "id": 9,
                                "name": "Contact Creation",
                                "category": "Extra Rights"
                            },
                            {
                                "type": "Group",
                                "id": 15,
                                "name": "Editor and Designer",
                                "category": "Website"
                            },
                            {
                                "type": "Group",
                                "id": 1,
                                "name": "Internal User",
                                "category": "User types"
                            },
                            {
                                "type": "Group",
                                "id": 12,
                                "name": "Mail Template Editor",
                                "category": "Technical"
                            },
                            {
                                "type": "Group",
                                "id": 6,
                                "name": "Multi Currencies",
                                "category": "Extra Rights"
                            },
                            {
                                "type": "Group",
                                "id": 17,
                                "name": "Multi-website",
                                "category": "Technical"
                            },
                            {
                                "type": "Group",
                                "id": 14,
                                "name": "Restricted Editor",
                                "category": "Website"
                            },
                            {
                                "type": "Group",
                                "id": 4,
                                "name": "Settings",
                                "category": "Administration"
                            },
                            {
                                "type": "Group",
                                "id": 7,
                                "name": "Technical Features",
                                "category": "Extra Rights"
                            }
                        ]
                    }
                }
            };
            const diffs = deepDiff(expected, resultSession, undefined)
            console.log("diff", diffs)
        });
    });


    describe('Metadata', () => {
        it('can list object types', async () => {
            const types = await client.listObjectTypes();
            console.log('listObjectTypes result', types?.length ?? 0)
            expect(types).toBeDefined();
            expect(Array.isArray(types)).toBe(true);
        });

        it('can get metadata for a specific object type', async () => {
            const metadata = await client.getMetadata('contact');
            expect(metadata).toBeDefined();
            expect(metadata.fields).toBeDefined();
        });
    });

    // describe('Data', () => {
    //     it('can get data with options', async () => {
    //         const { records, totalSize } = await client.getData('contact', {
    //             fields: ['name', 'email'],
    //             limit: 10,
    //             where: { active: true }
    //         });
    //         expect(records).toBeDefined();
    //         expect(totalSize).toBeDefined();
    //     });

    //     it('can get data by ID', async () => {
    //         const record = await client.getDataById('contact', '123');
    //         expect(record).toBeDefined();
    //         expect(record.id).toBe('123');
    //     });

    //     it('can create data', async () => {
    //         const newData = { name: 'Test', email: 'test@example.com' };
    //         const result = await client.createData('contact', newData);
    //         expect(result).toBeDefined();
    //         expect(result.id).toBeDefined();
    //     });

    //     it('can update data', async () => {
    //         const updates = { name: 'Updated Name' };
    //         const result = await client.updateData('contact', '123', updates);
    //         expect(result).toBeDefined();
    //     });

    //     it('can delete data', async () => {
    //         const result = await client.deleteData('contact', '123');
    //         expect(result).toBeDefined();
    //     });
    // });

    // describe('Attachments', () => {
    //     it('can get attachments', async () => {
    //         const attachments = await client.getAttachments('contact', '123');
    //         expect(attachments).toBeDefined();
    //         expect(Array.isArray(attachments)).toBe(true);
    //     });
    // });

    // describe('Email', () => {
    //     it('can send email', async () => {
    //         await expect(
    //             client.sendEmail(
    //                 ['test@example.com'],
    //                 'Test Subject',
    //                 'Test Body',
    //                 'me@example.com'
    //             )
    //         ).resolves.not.toThrow();
    //     });
    // });

    // describe('Data Mappers', () => {
    //     it('can normalize input data', () => {
    //         client.setInputDataMapper(data => ({ ...data, normalized: true }));
    //         const data = { name: 'Test' };
    //         const normalized = client.normalizeInputData(data);
    //         expect(normalized.normalized).toBe(true);
    //     });

    //     it('can normalize output data', () => {
    //         client.setOutputDataMapper(data => ({ ...data, normalized: true }));
    //         const data = { name: 'Test' };
    //         const normalized = client.normalizeOutputData(data);
    //         expect(normalized.normalized).toBe(true);
    //     });
    // });

});