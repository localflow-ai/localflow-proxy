import jsforce from 'jsforce';

export class SalesforceConnector {
  constructor() {
    this.conn = null;
  }

  async login({ username, password, token, loginUrl, clientId, clientSecret, refreshToken }) {
    if (username && password) {
      // Username/password login
      this.conn = new jsforce.Connection({
        loginUrl: loginUrl || 'https://login.salesforce.com',
      });
      await this.conn.login(username, password + (token || ''));
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
          resolve(res);
        }); 
      });
    } else {
      throw new Error('Missing required Salesforce credentials: either username/password or clientId/clientSecret/refreshToken');
    }
  }

  async listObjectTypes() {
    const result = await this.conn.describeGlobal();
    return result.sobjects.map(obj => ({
      name: obj.name,
      label: obj.label,
      labelPlural: obj.labelPlural,
      keyPrefix: obj.keyPrefix,
      custom: obj.custom
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
        required: field.nillable === false,
        length: field.length || 255
      }))
    };
  }

  async getData(objectType, { fields, limit, order } = {}) {
    const queryFields = fields ? fields.join(', ') : 'Id';
    const directionClause = order ? `ORDER BY CreatedDate ${order}` : '';

    const soql = `SELECT ${queryFields} FROM ${objectType} ${directionClause} ${limit ? `LIMIT ${limit}` : ''}`;
    const records = [];
    return new Promise((resolve, reject) => {
      const query = this.conn.query(soql)
        .on('record', (record) => {
          records.push(record);
        })
        .on('end', () => {
          console.log(`[daquota maps] total in database: ${query.totalSize}`);
          console.log(`[daquota maps] total fetched: ${query.totalFetched}`);
          resolve(records);
        })
        .on('error', (err) => {
          console.error('[daquota maps] error reading ' + this.objectType, err);
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
}