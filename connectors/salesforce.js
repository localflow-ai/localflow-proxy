// import jsforce from 'jsforce';
// import crypto from 'crypto';
// import fetch from 'node-fetch'
// import { BaseConnector } from '../base-connector.js';
const jsforce = require('jsforce');
const crypto = require('crypto');
//const fetch = require('node-fetch');
const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { BaseConnector } = require('../base-connector.js');
const { getLogger } = require('../logging');

const logger = getLogger('salesforce-connector');

const mimeMap = {
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'pdf': 'application/pdf',
  'mp4': 'video/mp4',
  'webm': 'video/webm',
  'txt': 'text/plain',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'csv': 'text/csv'
};

function getMimeType(ext) {
  return mimeMap[ext.toLowerCase()] || 'application/octet-stream';
}

function decodeBase64UrlSafe(str) {
  // Salesforce uses URL-safe base64 (no padding, - and _)
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(str + padding, 'base64').toString('utf8');
}

class SalesforceConnector extends BaseConnector {
  constructor() {
    super();
    this.conn = null;
    this.sessionInfo = null;
  }

  async login({ username, password, token, loginUrl, url, clientId, clientSecret, refreshToken, signedRequest }) {
    this.sessionInfo = { username, loginUrl, url, clientId, signedRequest };
    if (username && password) {
      // Username/password login
      this.conn = new jsforce.Connection({
        loginUrl: url || loginUrl || 'https://login.salesforce.com',
      });
      await this.conn.login(username, password + (token || ''));
      this.sessionInfo.instanceUrl = this.conn.instanceUrl;
      this.sessionInfo.accessToken = this.conn.accessToken;
      this.sessionInfo.userId = this.conn.userInfo.id;
      this.sessionInfo.orgId = this.conn.userInfo.organizationId;
    } else if (clientId && clientSecret && refreshToken) {
      // OAuth2 login using refresh token
      const oauth2 = new jsforce.OAuth2({
        loginUrl: url || loginUrl || 'https://login.salesforce.com',
        clientId,
        clientSecret,
      });

      this.conn = new jsforce.Connection({ oauth2 });
      this.conn.refreshToken = refreshToken;

      // Refresh and initialize the access token
      await new Promise((resolve, reject) => {
        this.conn.refreshAccessToken((err, res) => {
          if (err) return reject(err);
          this.sessionInfo.instanceUrl = this.conn.instanceUrl;
          this.sessionInfo.accessToken = this.conn.accessToken;
          resolve(res);
        });
      });
    } else if (signedRequest) {
      // Salesforce Canvas Signed Request login
      try {
        const [encodedSig, encodedPayload] = signedRequest.split('.');

        if (!encodedSig || !encodedPayload) {
          throw new Error('Malformed signed request');
        }

        const payloadJson = decodeBase64UrlSafe(encodedPayload);
        const signedRequestData = JSON.parse(payloadJson);

        const accessToken = signedRequestData.client.oauthToken;
        const instanceUrl = signedRequestData.client.instanceUrl;
        logger.debug('signed request %s', signedRequestData);
        logger.debug('instanceUrl (from signed request) %s', signedRequestData.client?.instanceUrl);
        logger.debug('accessToken (from signed request) %s', signedRequestData.client?.accessToken);

        this.conn = new jsforce.Connection({
          instanceUrl,
          accessToken,
          //signedRequest: signedRequestData,
          //version: '64.0'
        });
        if (signedRequestData.context && signedRequestData.context.user) {
          this.sessionInfo.userId = signedRequestData.context.user.userId;
          this.sessionInfo.username = signedRequestData.context.user.userName; // Set username from signedRequest
        }
        if (signedRequestData.context && signedRequestData.context.organization) {
          this.sessionInfo.orgId = signedRequestData.context.organization.organizationId;
        }

        logger.debug('Logged in via Signed Request');
        logger.debug('instanceUrl: %s', this.conn.instanceUrl);
        logger.debug('accessToken: %s', this.conn.accessToken);

      } catch (error) {
        logger.error('Error processing signed request: %s', error);
        throw new Error(`Failed to process Salesforce signed request: ${error.message}`);
      }
    } else {
      throw new Error('Missing required Salesforce credentials: either username/password or clientId/clientSecret/refreshToken');
    }
  }

  async getSessionInfo() {
    if (!this.sessionInfo.context) {
      const context = {
        configuration: {
          userObject: 'User',
          userFields: ['Id', 'Name', 'FirstName', 'LastName', 'Email', 'Username', 'IsActive'],
          userWhere: { "IsActive": true, "UserType": 'Standard' },
          userNameField: 'Username',
          idField: 'Id'
        }
      };
      if (this.sessionInfo.userId) {
        const user = await this.conn.sobject("User").retrieve(this.sessionInfo.userId);
        let profile;
	try {
		profile = await this.conn.sobject("Profile").retrieve(user.ProfileId);
	} catch(e) {
		logger.error('Cannot get profile');
	}
        context.user = {
          id: user.Id,
          name: user.Username,
          firstName: user.FirstName,
          lastName: user.LastName,
          email: user.Email,
          locale: user.LocaleSidKey,
          timezone: user.TimeZoneSidKey,
          language: user.LanguageLocaleKey,
          isAdmin: profile ? profile.Name.toLowerCase().includes('admin') : false,
        };
	try {
        const permSets = await this.conn.query(`
          SELECT PermissionSet.Id, PermissionSet.Name
          FROM PermissionSetAssignment 
          WHERE Assignee.Id = '${this.sessionInfo.userId}'
        `);

        context.user.permissions = [
          { type: 'Profile', id: profile.Id, name: profile.Name },
          ...permSets.records.map(r => ({
            type: 'PermissionSet',
            id: r.PermissionSet.Id,
            name: r.PermissionSet.Name,
          }))
        ];
	} catch(e) {
		logger.error('Cannot get permission set');
	}

      }
      this.sessionInfo.context = context;
    }
    return this.sessionInfo;
  }

  async listObjectTypes() {
    const result = await this.conn.describeGlobal();
    return result.sobjects.map(obj => ({
      name: this.normalizeOutputObjectType(obj.name),
      label: obj.label,
      labelPlural: obj.labelPlural,
      keyPrefix: obj.keyPrefix,
      custom: obj.custom,
      layoutable: obj.layoutable,
      updateable: obj.updateable,
      createable: obj.createable,
    }));
  }

  async getObjectMetadata(objectType) {
    objectType = this.normalizeInputObjectType(objectType);
    const result = await this.conn.sobject(objectType).describe();
    return {
      name: result.name,
      label: result.label,
      labelPlural: result.labelPlural,
      custom: result.custom,
      layoutable: result.layoutable,
      updateable: result.updateable,
      createable: result.createable,
      fields: this.processFields(objectType, result.fields.map(field => ({
        name: field.name,
        label: field.label,
        labelPlural: field.labelPlural,
        type: field.type,
        referenceTo: this.normalizeOutputObjectType(field.referenceTo),
        relationshipName: field.relationshipName,
        picklistValues: field.picklistValues,
        required: field.nillable === false,
        length: field.length || 255,
        calculated: field.calculated,
        createable: field.createable,
        updateable: field.updateable,
      })))
    };
  }

  async getObjectTypeFromId(id) {
    try {
      console.debug('[backoffice-connector] get SObject type from record id', id);
      const prefix = id.substring(0, 3);
      const globalDesc = await this.conn.describeGlobal();

      for (const sobject of globalDesc.sobjects) {
        const sobjectDesc = await this.conn.sobject(sobject.name).describe();
        if (sobjectDesc.keyPrefix === prefix) {
          console.debug('[backoffice-connector] found', sobject.name);
          return sobject.name;
        }
      }
    } catch (error) {
      console.error('[backoffice-connector] error', error);
    }

    return null;
  }

  async buildSOQLWhere(objectType, where) {
    if (!where || typeof where !== 'object') return '';

    const parts = [];

    for (let key in where) {
      const value = where[key];

      if (key === '$or' && Array.isArray(value)) {
        const orParts = await Promise.all(value.map(w => this.buildSOQLWhere(objectType, w)));
        parts.push(`(${orParts.filter(Boolean).join(' OR ')})`);
      } else if (key === '$not') {
        const notPart = await this.buildSOQLWhere(objectType, value);
        if (notPart) parts.push(`NOT (${notPart})`);
      } else if (typeof value === 'object' && value !== null) {
        const [operator, operand] = Object.entries(value)[0];
        key = this.normalizeInputKey(objectType, key);
        switch (operator) {
          case '$like':
            parts.push(`${key} LIKE '${operand}'`);
            break;
          case '$neq':
            parts.push(`${key} != ${operand === null ? 'NULL' : `'${operand}'`}`);
            break;
          case '$eq':
            parts.push(`${key} = ${operand === null ? 'NULL' : typeof operand === 'boolean' ? operand : `'${operand}'`}`);
            break;
          case '$gt':
            parts.push(`${key} > '${operand}'`);
            break;
          case '$lt':
            parts.push(`${key} < '${operand}'`);
            break;
          case '$in':
            if (Array.isArray(operand)) {
              const inList = operand.map(v => `'${v}'`).join(', ');
              parts.push(`${key} IN (${inList})`);
            } else if (typeof operand === 'object' && operand.$select) {
              const { from, field, where: subWhere } = operand.$select;
              const subWhereClause = await this.buildSOQLWhere(objectType, subWhere);
              const subQuery = `SELECT ${field} FROM ${from}${subWhereClause ? ` WHERE ${subWhereClause}` : ''}`;
              parts.push(`${key} IN (${subQuery})`);
            } else {
              throw new Error(`Unsupported $in operand: ${JSON.stringify(operand)}`);
            }
            break;
          default:
            throw new Error(`Unsupported operator: ${operator}`);
        }
      } else {
        key = this.normalizeInputKey(objectType, key);
        if (value === null) {
          parts.push(`${key} = NULL`);
        } else {
          const val = typeof value === 'boolean' ? value : `'${value}'`;
          parts.push(`${key} = ${val}`);
        }
      }
    }

    return parts.join(' AND ');
  }

  /**
   * @param {string} objectType - The name of the SFDC object type (e.g. "Account", "Contact")
   * @param {Object} [options]
   * @param {string[]} [options.fields] - The names of the fields to retrieve
   * @param {Object} [options.where] - A filter object with the following structure:
   *   {
   *     [fieldName]: [value|{ $neq: value, $gt: value, $lt: value, $like: value }]
   *   }
   * 
   * Example of where (MongoDB style):
   * {
   *   "$or": [
   *       { "is_company": true },
   *       { "name": { "$like": "%abc%" } }
   *   ],
   *   "active": true,
   *   "$not": { "email": { "$like": "%spam%" } }
   * }
   * @param {number} [options.limit] - The maximum number of records to return
   * @param {string} [options.order] - The direction of the sort order (e.g. "ASC", "DESC")
   * @returns {Promise<Array<Object>>} - The list of records
   */
  async getData(objectType, { fields, where, limit, order } = {}) {
    objectType = this.normalizeInputObjectType(objectType);
    const queryFields = fields ? this.normalizeInputFieldNames(objectType, fields).join(', ') : 'Id';
    const directionClause = order
      ? `ORDER BY ${Object.entries(order)
        .map(([field, dir]) => `${this.normalizeInputKey(objectType, field)} ${dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`)
        .join(', ')}`
      : '';

    const soql = `SELECT ${queryFields} FROM ${objectType} 
      ${where ? `WHERE ${await this.buildSOQLWhere(objectType, where)}` : ''} 
      ${directionClause} 
      ${limit ? `LIMIT ${limit}` : ''} 
    `;
    logger.debug('getData, soql %s', soql);
    const records = [];
    return new Promise((resolve, reject) => {
      try {
        const query = this.conn.query(soql)
          .on('record', (record) => {
            records.push(record);
          })
          .on('end', () => {
            logger.debug('total in database: %d', query.totalSize);
            logger.debug('total fetched: %d', query.totalFetched);
            resolve({ records: this.normalizeOutputData(objectType, records), totalSize: query.totalSize, totalFetched: query.totalFetched });
          })
          .on('error', (err) => {
            logger.error('error querying %s: %s', this.objectType, err);
            reject('error querying ' + this.objectType);
          })
          .run({ autoFetch: true, maxFetch: limit || 2000 }); // fetch more than 2000 records
          query.catch?.(reject);
        } catch (err) {
          logger.error('error querying %s: %s', this.objectType);
          reject('error querying ' + this.objectType);
        }
    });
  }

  async getRecordById(objectType, id, fields) {
    objectType = this.normalizeInputObjectType(objectType);
    let result = await this.conn.sobject(objectType).retrieve(id, fields);
    return this.normalizeOutputData(objectType, result);
  }

  async createRecord(objectType, data) {
    objectType = this.normalizeInputObjectType(objectType);
    return this.conn.sobject(objectType).create(this.normalizeInputData(objectType, data));
    // return new Promise((resolve, reject) => {
    //   this.conn.sobject(objectType).create(this.normalizeInputData(objectType, data), (err, result) => {
    //     if (err || !result.success) return reject(err || new Error('Failed to create record'));
    //     resolve(result);
    //   });
    // });
  }

  async updateData(objectType, id, data) {
    objectType = this.normalizeInputObjectType(objectType);
    return this.conn.sobject(objectType).update(this.normalizeInputData(objectType, { Id: id, ...data }));
  }

  async deleteData(objectType, id) {
    objectType = this.normalizeInputObjectType(objectType);
    return this.conn.sobject(objectType).destroy(id);
  }

  async getAttachments(objectType, objectId, mimeTypePrefix = '') {

    // 1. Find ContentDocumentIds
    const linkResult = await this.conn.query(`
      SELECT ContentDocumentId 
      FROM ContentDocumentLink 
      WHERE LinkedEntityId = '${objectId}'
    `);

    const docIds = linkResult.records.map(r => r.ContentDocumentId);
    if (!docIds.length) return [];

    // 2. Get ContentVersion info
    const versionResult = await this.conn.query(`
      SELECT Id, Title, FileExtension, ContentDocumentId, VersionData, FileType
      FROM ContentVersion 
      WHERE ContentDocumentId IN (${docIds.map(id => `'${id}'`).join(',')})
    `);

    const filtered = versionResult.records.filter(v => {
      const mimeType = getMimeType(v.FileExtension);
      return mimeTypePrefix ? mimeType.startsWith(mimeTypePrefix) : true;
    });

    // 3. Download & convert to base64
    const files = await Promise.all(filtered.map(async version => {
      const response = await fetch(
        `${this.conn.instanceUrl}/services/data/v${this.conn.version}/sobjects/ContentVersion/${version.Id}/VersionData`,
        {
          headers: { Authorization: `Bearer ${this.conn.accessToken}` }
        }
      );

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const mimeType = getMimeType(version.FileExtension);

      return {
        id: version.Id,
        name: version.Title,
        fileExtension: version.FileExtension,
        contentType: mimeType,
        src: `data:${mimeType};base64,${base64}`
      };
    }));

    logger.debug('getAttachments %s', files);
    return files;
  }

  async sendEmail({ to, subject, body, from }) {
    const requestBody = {
      inputs: [
        {
          emailBody: body,
          emailAddresses: to,
          emailSubject: subject,
          senderType: "CurrentUser", // or "OrgWideEmailAddress"
        },
      ],
    };

    const response = await this.conn.request({
      method: 'POST',
      url: `/services/data/v${this.conn.version}/actions/standard/emailSimple`,
      body: JSON.stringify(requestBody),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    return response;
  }

}

module.exports = { SalesforceConnector };
