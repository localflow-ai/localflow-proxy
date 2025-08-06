import jsforce from 'jsforce';
import crypto from 'crypto';
import fetch from 'node-fetch'

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

export class SalesforceConnector {
  constructor() {
    this.conn = null;
    this.sessionInfo = null;
  }

  async login({ username, password, token, loginUrl, clientId, clientSecret, refreshToken, signedRequest }) {
    this.sessionInfo = { username, loginUrl, clientId, signedRequest };
    if (username && password) {
      // Username/password login
      this.conn = new jsforce.Connection({
        loginUrl: loginUrl || 'https://login.salesforce.com',
      });
      await this.conn.login(username, password + (token || ''));
      this.sessionInfo.instanceUrl = this.conn.instanceUrl;
      this.sessionInfo.accessToken = this.conn.accessToken;
      this.sessionInfo.userId = this.conn.userInfo.id;
      this.sessionInfo.orgId = this.conn.userInfo.organizationId;
    } else if (clientId && clientSecret && refreshToken) {
      // OAuth2 login using refresh token
      const oauth2 = new jsforce.OAuth2({
        loginUrl: loginUrl || 'https://login.salesforce.com',
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
        console.log('[SalesforceConnector] signed request', signedRequestData);
        console.log('[SalesforceConnector] instanceUrl (from signed request)', signedRequestData.client?.instanceUrl);
        console.log('[SalesforceConnector] accessToken (from signed request)', signedRequestData.client?.accessToken);

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

        console.log('[SalesforceConnector] Logged in via Signed Request');
        console.log('[SalesforceConnector] instanceUrl:', this.conn.instanceUrl);
        console.log('[SalesforceConnector] accessToken:', this.conn.accessToken);

      } catch (error) {
        console.error('Error processing signed request:', error);
        throw new Error(`Failed to process Salesforce signed request: ${error.message}`);
      }
    } else {
      throw new Error('Missing required Salesforce credentials: either username/password or clientId/clientSecret/refreshToken');
    }
  }

  async getSessionInfo() {
    return this.sessionInfo;
  }

  async getContext() {
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
      const profile = await this.conn.sobject("Profile").retrieve(user.ProfileId);
      context.user = {
        id: user.Id,
        name: user.Username,
        firstName: user.FirstName,
        lastName: user.LastName,
        email: user.Email,
        locale: user.LocaleSidKey,
        timezone: user.TimeZoneSidKey,
        language: user.LanguageLocaleKey,
        isAdmin: profile.Name.toLowerCase().includes('admin'),
      };
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

    }
    return context;
  }

  async listObjectTypes() {
    const result = await this.conn.describeGlobal();
    return result.sobjects.map(obj => ({
      name: obj.name,
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
    const result = await this.conn.sobject(objectType).describe();
    return {
      name: result.name,
      fields: result.fields.map(field => ({
        name: field.name,
        label: field.label,
        type: field.type,
        referenceTo: field.referenceTo,
        relationshipName: field.relationshipName,
        required: field.nillable === false,
        length: field.length || 255,
        calculated: field.calculated,
        createable: field.createable,
        updateable: field.updateable,
      }))
    };
  }

  // buildSOQLWhere(where) {
  //   if (!where || typeof where !== 'object') return '';

  //   const parts = [];

  //   for (const key in where) {
  //     const value = where[key];

  //     if (key === '$or' && Array.isArray(value)) {
  //       const orParts = value.map(buildSOQLWhere).filter(Boolean);
  //       parts.push(`(${orParts.join(' OR ')})`);
  //     } else if (key === '$not') {
  //       const notPart = buildSOQLWhere(value);
  //       if (notPart) parts.push(`NOT (${notPart})`);
  //     } else if (typeof value === 'object' && value !== null) {
  //       const [operator, operand] = Object.entries(value)[0];
  //       switch (operator) {
  //         case '$like':
  //           parts.push(`${key} LIKE '${operand}'`);
  //           break;
  //         case '$neq':
  //           parts.push(`${key} != '${operand}'`);
  //           break;
  //         case '$gt':
  //           parts.push(`${key} > '${operand}'`);
  //           break;
  //         case '$lt':
  //           parts.push(`${key} < '${operand}'`);
  //           break;
  //         default:
  //           throw new Error(`Unsupported operator: ${operator}`);
  //       }
  //     } else {
  //       const val = typeof value === 'boolean' ? value : `'${value}'`;
  //       parts.push(`${key} = ${val}`);
  //     }
  //   }

  //   return parts.join(' AND ');
  // }

  async buildSOQLWhere(where) {
    if (!where || typeof where !== 'object') return '';

    const parts = [];

    for (const key in where) {
      const value = where[key];

      if (key === '$or' && Array.isArray(value)) {
        const orParts = await Promise.all(value.map(w => this.buildSOQLWhere(w)));
        parts.push(`(${orParts.filter(Boolean).join(' OR ')})`);
      } else if (key === '$not') {
        const notPart = await this.buildSOQLWhere(value);
        if (notPart) parts.push(`NOT (${notPart})`);
      } else if (typeof value === 'object' && value !== null) {
        const [operator, operand] = Object.entries(value)[0];

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
              const subWhereClause = await this.buildSOQLWhere(subWhere);
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
    const queryFields = fields ? fields.join(', ') : 'Id';
    const directionClause = order
      ? `ORDER BY ${Object.entries(order)
        .map(([field, dir]) => `${field} ${dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`)
        .join(', ')}`
      : '';

    const soql = `SELECT ${queryFields} FROM ${objectType} 
      ${where ? `WHERE ${await this.buildSOQLWhere(where)}` : ''} 
      ${directionClause} 
      ${limit ? `LIMIT ${limit}` : ''} 
    `;
    console.log('getData, soql', soql);
    const records = [];
    return new Promise((resolve, reject) => {
      const query = this.conn.query(soql)
        .on('record', (record) => {
          records.push(record);
        })
        .on('end', () => {
          console.log(`[daquota proxy] total in database: ${query.totalSize}`);
          console.log(`[daquota proxy] total fetched: ${query.totalFetched}`);
          resolve(records);
        })
        .on('error', (err) => {
          console.error('[daquota proxy] error reading ' + this.objectType, err);
          reject(err);
        })
        .run({ autoFetch: true, maxFetch: limit || 2000 }); // fetch more than 2000 records
    });

    return records;
  }

  async getRecordById(objectType, id, fields) {
    return this.conn.sobject(objectType).retrieve(id, fields);
  }

  async createRecord(objectType, data) {
    return new Promise((resolve, reject) => {
      this.conn.sobject(objectType).create(data, (err, result) => {
        if (err || !result.success) return reject(err || new Error('Failed to create record'));
        resolve(result);
      });
    });
  }

  async updateData(objectType, id, data) {
    return this.conn.sobject(objectType).update({ Id: id, ...data });
  }

  async deleteData(objectType, id) {
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

    console.log('getAttachments', files);
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