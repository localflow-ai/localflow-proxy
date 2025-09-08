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

 
  



