import Odoo from 'odoo-xmlrpc';
import { BaseConnector } from '../base-connector.js';
import xmlrpc from 'xmlrpc';

export class OdooConnector extends BaseConnector {
  constructor() {
    super();
    this.odoo = null;
    // this.inputKeyMap = {
    //   'Id': 'id',
    //   'Name': 'name',
    //   'Email': 'email',
    // };
    // this.outputKeyMap = {
    //   'id': 'Id',
    //   'name': 'Name',
    //   'email': 'Email',
    // };
  }

  async login({ url, db, username, password }) {
    this.sessionInfo = { url, db, username };
    this.odoo = new Odoo({ url, db, username, password });
    return new Promise((resolve, reject) => {
      this.odoo.connect(err => {
        if (err) return reject(err);

        // Manually set up a "common" client for authentication
        const common = xmlrpc.createClient({ url: `${url}/xmlrpc/2/common` });

        common.methodCall('authenticate', [db, username, password, {}], (err, uid) => {
          if (err) return reject(err);
          if (!uid) return reject(new Error('Invalid login credentials'));

          console.log('[OdooConnector] authenticated to Odoo', uid);
          this.sessionInfo.userId = uid;
          this.odoo.uid = uid; // Store for later use
          resolve();
        });

      });
    });

    // this.odoo.authenticate(db, username, password, (err, uid) => {
    //   if (err) return reject(err);

    //   console.log('[OdooConnector] connected to Odoo', uid);
    //   this.sessionInfo.userId = uid;
    //   this.odoo.uid = uid; // store in instance if needed
    //   resolve();
    // });
  }

  async execute_kw(model, method, args = [], kwargs = {}) {
    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(model, method, [args, kwargs], (err, value) => {
        if (err) return reject(err);
        resolve(value);
      });
    });
  }

  async getSessionInfo() {
    console.log('[OdooConnector] sessionInfo before filling', JSON.stringify(this.sessionInfo, null, 2));
    if (!this.sessionInfo.context) {
      const context = {
        configuration: {
          userObject: 'res.users',
          userFields: ['id', 'name', 'email', 'login', 'active'].map(f => this.normalizeOutputKey(f)),
          userWhere: { [this.normalizeOutputKey('active')]: true },
          userNameField: this.normalizeOutputKey('login'),
          idField: this.normalizeOutputKey('id')
        }
      };
      if (this.sessionInfo.userId) {
        const [user] = await this.execute_kw('res.users', 'read', [[this.sessionInfo.userId], ['id', 'name', 'email', 'login', 'groups_id']]);
        console.log('[OdooConnector] user', user);
        //const [groupSystemRef] = await this.execute_kw('ir.model.data', 'get_object_reference', [['group_system']]);
        //const groupSystemRef = await this.execute_kw('res.groups', 'search_read', [[['name', '=', 'group_system']], ['id']]);
        //console.log('[OdooConnector] groupSystemRef', groupSystemRef);

        const groups = await this.execute_kw('res.groups', 'read', [user.groups_id, ['id', 'name', 'category_id']]);
        console.log('[OdooConnector] groups', groups);

        context.user = {
          id: user.id,
          name: user.login,
          email: user.email,
          isAdmin: !!groups.find(g => g.name === 'Settings') //user.groups_id.includes(groupSystemRef[0]),
        };

        context.user.permissions = groups.map(g => ({
          type: 'Group',
          id: g.id,
          name: g.name,
          category: g.category_id?.[1] || null
        }));
      }
      this.sessionInfo.context = context;
    }
    console.log('[OdooConnector] sessionInfo', JSON.stringify(this.sessionInfo, null, 2));
    return this.sessionInfo;
  }

  async listObjectTypes() {
    console.log('listObjectTypes2');
    const inParams = [
      [],
      ['model', 'name', 'transient', 'state'],
    ];
    const models = await new Promise((resolve, reject) => {
      this.odoo.execute_kw('ir.model', 'search_read', [inParams], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    return models.map(m => {
      const objectType = m.model;
      const layoutable = (
        !m.transient &&
        m.state === 'base' &&
        !objectType.startsWith('ir.') &&
        !objectType.startsWith('base.') &&
        !objectType.startsWith('web.') &&
        !objectType.includes('.test')
      );
      return {
        name: m.model, // technical name
        label: m.name,
        labelPlural: m.name + 's',
        keyPrefix: '',     // Odoo doesn't use this — placeholder
        custom: false,      // Placeholder — customize if needed
        layoutable,
      };
    });
  }

  async getObjectMetadata(objectType) {
    // const fields = await new promise((resolve, reject) => {
    //   this.odoo.execute_kw(
    //     objecttype,
    //     'fields_get',
    //     [[]],
    //     (err, result) => {
    //       if (err) return reject(err);
    //       console.info('fields_get result', result);
    //       resolve(result);
    //     }
    //   );
    // });
    // Get fields
    const fieldParams = [[['model', '=', objectType]]];
    const fields = await new Promise((resolve, reject) => {
      this.odoo.execute_kw('ir.model.fields', 'search_read', [fieldParams], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    // Get model info (like abstract, transient, etc.)
    const modelParams = [[['model', '=', objectType]]];
    const [modelInfo] = await new Promise((resolve, reject) => {
      this.odoo.execute_kw('ir.model', 'search_read', [modelParams], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    // Infer layoutability using heuristics
    const layoutable = (
      modelInfo &&
      !modelInfo.transient &&
      !modelInfo.abstract &&
      modelInfo.state === 'base' &&
      !objectType.startsWith('ir.') &&
      !objectType.startsWith('base.') &&
      !objectType.startsWith('web.') &&
      !objectType.includes('.test')
    );

    return {
      ...modelInfo,
      name: objectType,
      layoutable,
      fields: this.processFields(objectType, fields.map((field) => ({
        ...field,
        name: field.name,
        relationshipName: field.name,
        label: field.field_description,
        type: this.normalizeOdooType(field.ttype),
        required: field.required,
        length: field.size || 255,
        updateable: this.isFieldWritable(field),
        createable: this.isFieldWritable(field),
        referenceTo: field.relation ? [field.relation] : undefined
      })))
    };
  }
  // Basic mapping from Odoo types to Salesforce-like types
  normalizeOdooType(ttype) {
    switch (ttype) {
      case 'char': return 'string';
      case 'text': return 'string';
      case 'boolean': return 'boolean';
      case 'integer': return 'int';
      case 'float': return 'double';
      case 'many2one': return 'reference';
      case 'datetime': return 'datetime';
      case 'date': return 'date';
      default: return 'string';
    }
  }

  isFieldWritable(field) {
    // `field` is an object with metadata about the field
    return !field.readonly &&
      (!field.compute || !!field.inverse) &&
      field.store !== false &&
      !['id', 'create_uid', 'create_date', 'write_uid', 'write_date'].includes(field.name);
  }

  async buildOdooDomain(where) {
    if (!where || typeof where !== 'object') return [];

    const domain = [];

    for (let key in where) {
      const value = where[key];

      if (key === '$or' && Array.isArray(value)) {
        // Flatten and prefix with |
        const parts = (await Promise.all(value.map(v => this.buildOdooDomain(v)))).flat();
        for (let i = 1; i < parts.length; i++) domain.unshift('|');
        domain.push(...parts);
      } else if (key === '$not') {
        const negated = await this.buildOdooDomain(value);
        for (const cond of negated) {
          domain.push(['!', cond]);
        }
      } else if (typeof value === 'object' && value !== null) {
        const [operator, operand] = Object.entries(value)[0];
        key = this.normalizeInputKey(key);

        switch (operator) {
          case '$like':
            domain.push([key, 'ilike', operand.replace(/%/g, '')]);
            break;
          case '$neq':
            domain.push([key, '!=', operand === null ? false : operand]);
            break;
          case '$gt':
            domain.push([key, '>', operand]);
            break;
          case '$lt':
            domain.push([key, '<', operand]);
            break;
          case '$in':
            if (Array.isArray(operand)) {
              domain.push([key, 'in', operand]);
            } else if (operand?.$select) {
              const { model, field, where: subWhere } = operand.$select;
              const subDomain = await this.buildOdooDomain(subWhere);
              const ids = await new Promise((resolve, reject) => {
                this.odoo.execute_kw(model, 'search_read', [subDomain, [field]], (err, result) => {
                  if (err) return reject(err);
                  resolve(result.map(r => r[field]));
                });
              });
              domain.push([key, 'in', ids]);
            } else {
              throw new Error(`Unsupported $in operand: ${JSON.stringify(operand)}`);
            }
            break;
          default:
            throw new Error(`Unsupported operator: ${operator}`);
        }
      } else if (value === null) {
        // Odoo domain for null is [('field', '=', false)]
        domain.push([key, '=', false]);
      } else {
        domain.push([key, '=', value]);
      }
    }

    return domain;
  }

  /**
   * Retrieves records from the specified Odoo model.
   *
   * @param {string} objectType - The name of the Odoo model (e.g. "res.partner")
   * @param {Object} [options] - Additional options
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
   *   }
   * 
   * @param {number} [options.limit] - The maximum number of records to return
   * @param {string} [options.order] - The field and direction of the sort order (e.g. { fieldName1: "ASC" | "DESC" })
   * @returns {Promise<Array<Object>>} - The list of records
   */
  async getData(objectType, { fields, where, limit, order } = {}) {
    console.log('getData', objectType, fields, where, limit, order);

    const orderString = order
      ? Object.entries(order)
        .map(([field, dir]) => `${this.normalizeInputKey(field)} ${dir.toUpperCase() === 'DESC' ? 'desc' : 'asc'}`)
        .join(', ')
      : undefined;

    const inParams = [await this.buildOdooDomain(where), this.normalizeInputFieldNames(fields), 0, limit || 2000];
    if (orderString) inParams.push(orderString);

    console.log('inParams', inParams);

    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(
        objectType,
        'search_read',
        [inParams],
        (err, result) => {
          if (err) return reject(err);
          resolve(this.normalizeOutputData(result));
        }
      );
    });
  }

  async getRecordById(objectType, id, fields = null) {
    const parsedId = parseInt(id, 10);
    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(
        objectType,
        'read',
        [[parsedId], { fields }],
        (err, result) => {
          if (err) return reject(err);
          resolve(this.normalizeOutputData(result[0]));
        }
      );
    });
  }

  async createRecord(objectType, data) {
    return new Promise((resolve, reject) => {
      console.log('createRecord', objectType, data);
      const inParams = [this.normalizeInputData(data)];
      console.log('createRecord', inParams);
      this.odoo.execute_kw(objectType, 'create', [inParams], (err, id) => {
        if (err) return reject(err);
        resolve({ id });
      });
    });
  }

  async updateData(objectType, id, data) {
    return new Promise((resolve, reject) => {
      console.log('updateData', objectType, id, data);
      const inParams = [[parseInt(id)], this.normalizeInputData(data)];
      console.log('updateData', inParams);
      this.odoo.execute_kw(objectType, 'write', [inParams], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  async deleteData(objectType, id) {
    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(objectType, 'unlink', [[[parseInt(id)]]], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  async getAttachments(objectType, objectId, mimeTypePrefix = '') {
    const domain = [['res_model', '=', objectType], ['res_id', '=', parseInt(objectId)]];
    if (mimeTypePrefix) {
      domain.push(['mimetype', 'ilike', mimeTypePrefix]);
    }

    const results = await this.execute_kw('ir.attachment', 'search_read', [
      domain,
      ['id', 'name', 'mimetype', 'datas']
    ]);

    return results.map(att => ({
      id: att.id,
      name: att.name,
      contentType: att.mimetype,
      src: `data:${att.mimetype};base64,${att.datas}`
    }));
  }

  async sendEmail({ to, subject, body, from }) {
    const emailValues = {
      subject,
      body_html: `<p>${body}</p>`,
      email_to: Array.isArray(to) ? to.join(',') : to,
      email_from: from || 'default@example.com',
    };

    const mailId = await this.executeKw('mail.mail', 'create', [emailValues]);
    await this.executeKw('mail.mail', 'send', [[mailId]]);

    return { success: true, mailId };
  }

}