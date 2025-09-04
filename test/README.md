# Proxy Connector Validation Specs

This document explains the proxy connector validation and provides basic testing information.

## Goals

The goals of the connector validation is to make sure that :
There is no regression when modifying a connector. So it will be used as a test suite before releasing a new connector version for instance, or during development when modifying the base connector utility functions to avoid side effects.
A new connector conforms to the expected contract and ensure the exact same API than other connectors, so that any connector can be substituted by another. In the long run, our platform will use that script to validate connectors provided by third parties (typically platform integrators). 

## Basic test scenario
As a first iteration we will implement the following basic scenario:

- Connection to the tested backoffice
- Configuration of the session (connector-specific)
- Get the session and check that the configuration applied
- Send a select request to find the LocalFlow company (KO if not found because all tested backoffice should have it)
- Create a configuration object
- Get the created object (KO if not found)
- Modify the configuration object
- Get the created object to check if modification applied (KO if not)
- Delete the configuration object and get it back (KO if found)

## Detailed HTTP requests to be performed
IMPORTANT NOTE: here we give the test as HTTP requests to the proxy, but it might be better to perform the test using the connectors directly.

A noter aussi le client suivant qui pourrait être utilisé pour appeler le proxy:

class ProxyClient {

    constructor(baseUrl, token) {
        this.baseUrl = baseUrl;
        this.token = token;
    }

    async connect(type = 'odoo', config = {}) {
        const res = await fetch(`${this.baseUrl}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, config })
        });

        if (res.error) {
            throw new Error(`Login failed: ${res.error} - ${res.detail}`);
        }

        const data = await res.json();
        this.token = data.token;
        return data;
    }

    isConnected() {
        return !!this.token;
    }

    async getSessionInfo() {
        const res = await fetch(`${this.baseUrl}/session`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    _headers() {
        if (!this.token) throw new Error('Not authenticated');
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`
        };
    }

    async _handleResponse(res) {
        if (!res.ok) {
            let message = res.statusText;
            try {
                const err = await res.json();
                message = err.error?.message || err.error || message;
            } catch {
                // fallback if response is not JSON
            }
            throw new Error(`[${res.status}] ${message}`);
        }
        return res.json();
    }

    setInputDataMapper(inputDataMapper) {
        this.inputDataMapper = inputDataMapper;
    }

    setOutputDataMapper(outputDataMapper) {
        this.outputDataMapper = outputDataMapper;
    }

    normalizeInputData(data) {
        if (this.inputDataMapper) {
            const normalizedData = this.inputDataMapper(data);
            Object.entries(normalizedData).forEach(([key, value]) => {
                if (value && typeof value === 'object') {
                    normalizedData[key] = this.normalizeInputData(value);
                }
            });
            return normalizedData;
        } else {
            return data;
        }
    }

    normalizeOutputData(data) {
        if (this.outputDataMapper) {
            const normalizedData = this.outputDataMapper(data);
            Object.entries(normalizedData).forEach(([key, value]) => {
                if (value && typeof value === 'object') {
                    normalizedData[key] = this.normalizeOutputData(value);
                }
            });
            return normalizedData;
        } else {
            return data;
        }
    }

    async createFieldMapping(objectTypeOrFieldMapping, fieldMapping) {
        let objectType;
        if (typeof objectTypeOrFieldMapping === 'object') {
            fieldMapping = objectTypeOrFieldMapping;
        }
        if (typeof objectTypeOrFieldMapping === 'string') {
            objectType = objectTypeOrFieldMapping;
        }
        const res = await fetch(`${this.baseUrl}/session/field-mapping` + (objectType ? `/${objectType}` : ''), {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(fieldMapping)
        });
        return this._handleResponse(res);
    }

    async createObjectTypeMapping(objectTypeMapping) {
        const res = await fetch(`${this.baseUrl}/session/object-type-mapping`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(objectTypeMapping)
        });
        return this._handleResponse(res);
    }

    async listObjectTypes() {
        const res = await fetch(`${this.baseUrl}/metadata`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    async getMetadata(objectType) {
        const res = await fetch(`${this.baseUrl}/metadata/${objectType}`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    /**
     * 
     * @param {string} objectType 
     * @param {{ fields?: string[], limit?: number, order?: string, where?: object }} [options]
     * 
     * Example of where (MongoDB style):
     * {
     *   "$or": [
     *       { "is_company": true },
     *       { "name": { "$like": "%abc%" } }
     *   ],
     *   "active": true,
     *   "$not": { "email": { "$like": "%spam%" } }
     *   }
     */
    async getData(objectType, { fields, where, limit, order } = {}) {
        const params = new URLSearchParams();
        if (fields) params.set('fields', fields.join(','));
        if (limit) params.set('limit', limit);
        if (order) params.set('order', JSON.stringify(order));
        if (where) params.set('where', JSON.stringify(where));

        const res = await fetch(`${this.baseUrl}/data/${objectType}?${params.toString()}`, {
            headers: this._headers()
        });

        const data = await this._handleResponse(res);
        console.debug(`[ProxyClient] getData(${objectType})`, data);
        return { 
            records: data.records.map(record => this.normalizeOutputData(record)), 
            totalSize: data.totalSize,
            totalFetched: data.totalFetched
        };
    }

    async getDataById(objectType, id) {
        const res = await fetch(`${this.baseUrl}/data/${objectType}/${id}`, {
            headers: this._headers()
        });
        const data = await this._handleResponse(res);
        return this.normalizeOutputData(data);
    }

    async createData(objectType, data) {
        data = this.normalizeInputData(data);
        const res = await fetch(`${this.baseUrl}/data/${objectType}`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(data)
        });
        return this._handleResponse(res);
    }

    async updateData(objectType, id, updates) {
        updates = this.normalizeInputData(updates);
        const res = await fetch(`${this.baseUrl}/data/${objectType}/${id}`, {
            method: 'PUT',
            headers: this._headers(),
            body: JSON.stringify(updates)
        });
        return this._handleResponse(res);
    }

    async deleteData(objectType, id) {
        const res = await fetch(`${this.baseUrl}/data/${objectType}/${id}`, {
            method: 'DELETE',
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    async getAttachments(objectType, objectId, mimeTypePrefix = '') {
        const res = await fetch(`${this.baseUrl}/attachments/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}${mimeTypePrefix ? `?mimeTypePrefix=${encodeURIComponent(mimeTypePrefix)}` : ''}`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    async sendEmail(toAddresses, subject, body, from) {
        const res = await fetch(`${this.baseUrl}/api/send-email`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({
                toAddresses,
                subject,
                body,
                from
            })
        });
    }
}

Connection to the tested backoffice



Endpoint:
POST: session

Payload:
{
  "type": "odoo",
  "config": {
    "url": "https://localflow.fr",
    "db": "odoo",
    "clientId": "",
    "username": "renaud.pawlak@localflow.fr",
    "password": "****"
  }
}

Expected output:
{"token":"****"}

All subsequent calls must pass the token in the header as Bearer.



Configuration of the session (connector-specific)
The goal of this configuration is to have objects and fields conforming to the default API, which is based on the salesforce model. Each connector will require a different configuration. The only connector that does not need any configuration is the Salesforce connector because it is the reference API.

Odoo Connector configuration (each endpoint must be called sequentially)



Endpoint 1:
POST: session/object-type-mapping

Payload: 
{
  "fr.localflow.geodata": "LocalFlow__GeoData__c"
  "res.partner": "Account"
}

Output:
{}



Endpoint 2:
POST: session/field-mapping
Payload: 
{
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
}

Output: 
{}



Endpoint 3:
POST: session/field-mapping/fr.localflow.geodata

Payload: 
{
  "content": "LocalFlow__Content__c",
  "type": "LocalFlow__Type__c"
}

Output:
{}



Get the session and check that the configuration applied
Endpoint:
GET: https://backoffice.daquota.io/session

Output:
{
  "url": "https://localflow.fr",
  "db": "odoo",
  "username": "renaud.pawlak@localflow.fr",
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
      "name": "renaud.pawlak@localflow.fr",
      "email": "renaud.pawlak@localflow.fr",
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
}

Checks to be specified.
Send a select request to find the LocalFlow company (KO if not found because all tested backoffice should have it)

Endpoint:
GET: data/Account?fields=Id%2CName&limit=2000&where=W 

With W = url-encoded of { “Name”: “LocalFlow” }

Output:
{
  "records": [
    {
      "Id": X,
      "Name": "LocalFlow",
    }
  ],
  "totalFetched": 1
}
Create a configuration object
Get the created object (KO if not found)
Modify the configuration object
Get the created object to check if modification applied (KO if not)
Delete the configuration object and get it back (KO if found)

 
  



