const Odoo = require('odoo-xmlrpc');
const { BaseConnector } = require('../base-connector.js');
const xmlrpc = require('xmlrpc');
const { getLogger } = require('../logging');

const logger = getLogger('odoo-connector');

/**
 * Odoo Connector for interacting with Odoo API. BaseConnector defines some common functionality for all connectors, espacially mapping and normalization.
 */
class OdooConnector extends BaseConnector {
  constructor() {
    super();
    this.odoo = null;
  }

  async login({ url, db, username, password }) {
    this.sessionInfo = { url, db, username };
    this.odoo = new Odoo({ url, db, username, password });
    return new Promise((resolve, reject) => {
      this.odoo.connect((err, uid) => {
        if (err) {
          console.error('Failed to connect to Odoo', err);
          return reject(err);
        }
        logger.info(`authenticated to Odoo ${url} with uid ${uid}`);
        this.sessionInfo.userId = uid;
        this.odoo.uid = uid; // Store for later use
        resolve();
      });
    });
  }

  async execute_kw(model, method, args = []) {
    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(model, method, args, (err, value) => {
        if (err) return reject(err);
        resolve(value);
      });
    });
  }

  async getSessionInfo() {
    logger.debug('sessionInfo before filling %s', JSON.stringify(this.sessionInfo, null, 2));
    if (!this.sessionInfo.context) {
      const context = {
        configuration: {
          userObject: 'res.users',
          userFields: ['id', 'name', 'email', 'login', 'active'].map(f => this.normalizeOutputKey('res.users', f)),
          userWhere: { [this.normalizeOutputKey('res.users', 'active')]: true },
          userNameField: this.normalizeOutputKey('res.users', 'login'),
          idField: this.normalizeOutputKey('res.users', 'id')
        }
      };
      if (this.sessionInfo.userId) {
        const [user] = await this.execute_kw('res.users', 'read', [[[this.sessionInfo.userId], ['id', 'name', 'email', 'login', 'groups_id']]]);
        logger.debug('user %s', JSON.stringify(user, null, 2));

        const groups = await this.execute_kw('res.groups', 'read', [[user.groups_id, ['id', 'name', 'category_id']]]);
        logger.debug('groups %s', JSON.stringify(groups, null, 2));

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
    logger.debug('sessionInfo %s', JSON.stringify(this.sessionInfo, null, 2));
    return this.sessionInfo;
  }

  async listObjectTypes() {
    logger.debug('listObjectTypes');
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
        name: this.normalizeOutputObjectType(m.model), // technical name
        orgName: m.name,
        label: m.name,
        labelPlural: m.name + 's',
        keyPrefix: '',     // Odoo doesn't use this — placeholder
        custom: false,      // Placeholder — customize if needed
        layoutable,
      };
    });
  }

  async getObjectMetadata(objectType) {
    objectType = this.normalizeInputObjectType(objectType);
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
      label: modelInfo ? (modelInfo.name || objectType) : objectType,
      labelPlural: modelInfo ? (modelInfo.name + 's' || objectType + 's') : objectType + 's',
      fields: this.processFields(objectType, fields.map(field => {
        if (typeof field.selection === 'string') {
          try {
            field.selection = JSON.parse(field.selection.replace(/\(/g, '[').replace(/\)/g, ']').replace(/'/g, '"'));
          } catch (e) {
            logger.error('Failed to parse field.selection for %s: %s %s', field.name, field.selection, e);
          }
        } else {
          if (!(typeof field.selection === 'boolean' || Array.isArray(field.selection))) {
            logger.warn('Unexpected field.selection type for %s: %s', field.name, field.selection);
          }
        }
        return {
          ...field,
          name: field.name,
          relationshipName: field.name,
          label: field.field_description,
          type: this.normalizeOdooType(field.ttype),
          picklistValues: Array.isArray(field.selection) ? field.selection.map(([value, label]) => ({ value, label })) : undefined,
          required: field.required,
          length: field.size || 255,
          updateable: this.isFieldWritable(field),
          createable: this.isFieldWritable(field),
          referenceTo: field.relation ? [this.normalizeOutputObjectType(field.relation)] : []
        }
      }))
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

  async buildOdooDomain(objectType, where) {
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
        const negated = await this.buildOdooDomain(objectType, value);
        for (const cond of negated) {
          domain.push(['!', cond]);
        }
      } else if (typeof value === 'object' && value !== null) {
        const [operator, operand] = Object.entries(value)[0];
        key = this.normalizeInputKey(objectType, key);

        switch (operator) {
          case '$like':
            domain.push([key, 'ilike', operand]);
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
              const subDomain = await this.buildOdooDomain(objectType, subWhere);
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
        key = this.normalizeInputKey(objectType, key);
        domain.push([key, '=', false]);
      } else {
        key = this.normalizeInputKey(objectType, key);
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
    logger.debug('getData %s %s %s %s %s', objectType, fields, JSON.stringify(where), limit, order);
    objectType = this.normalizeInputObjectType(objectType);

    const orderString = order
      ? Object.entries(order)
        .map(([field, dir]) => `${this.normalizeInputKey(objectType, field)} ${dir.toUpperCase() === 'DESC' ? 'desc' : 'asc'}`)
        .join(', ')
      : undefined;

    const relatedFields = fields?.filter(f => f.includes('.')) || [];
    fields = fields?.filter(f => !f.includes('.'));

    const inParams = [await this.buildOdooDomain(objectType, where), this.normalizeInputFieldNames(objectType, fields), 0, limit || 2000];
    if (orderString) inParams.push(orderString);

    logger.debug('inParams %s', JSON.stringify(inParams));

    const result = await this.execute_kw(
      objectType,
      'search_read',
      [inParams]
    );

    if (relatedFields.length) {
      const relationNames = Array.from(new Set(relatedFields.map(f => f.split('.')[0])));
      logger.debug('relationNames %s', relationNames);
      const relations = await this.execute_kw('ir.model.fields', 'search_read', [[
        [['model', '=', objectType], ['name', 'in', relationNames]],
        ['name', 'relation']
      ]]);
      logger.debug('relations %s', JSON.stringify(relations));
      for (const relationName of relationNames) {
        const relation = relations.find(r => r.name === relationName);
        if (!relation) continue;
        const relatedObjectType = relation.relation;
        if (!relatedObjectType) continue;
        const fieldsToFetch = Array.from(new Set(relatedFields.filter(f => f.startsWith(relationName + '.')).map(f => f.split('.')[1])))
          .map(f => this.normalizeInputKey(relatedObjectType, f));
        const recordsWithRelation = result.filter(r => r[relationName]);
        const ids = recordsWithRelation.map(r => r[relationName][0]);
        logger.debug('fieldsToFetch %s', JSON.stringify(fieldsToFetch));
        logger.debug('ids %s', JSON.stringify(ids));
        const relatedResult = await this.execute_kw(
          relatedObjectType,
          'read', [[ids, fieldsToFetch]]
        );
        logger.debug('relatedResult %s', JSON.stringify(relatedResult));
        recordsWithRelation.forEach((r, i) => {
          Object.assign(r, {
            [relationName]: this.normalizeOutputData(relatedObjectType, { id: ids[i], ...relatedResult[i] })
          });
        });
      }
    }

    logger.debug('returning %s object(s)', result.length);
    return { records: this.normalizeOutputData(objectType, result), totalSize: undefined, totalFetched: result.length };
  }

  async getRecordById(objectType, id, fields = null) {
    objectType = this.normalizeInputObjectType(objectType);
    const parsedId = parseInt(id, 10);
    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(
        objectType,
        'read',
        [[parsedId], { fields }],
        (err, result) => {
          if (err) return reject(err);
          resolve(this.normalizeOutputData(objectType, result[0]));
        }
      );
    });
  }

  async createRecord(objectType, data) {
    objectType = this.normalizeInputObjectType(objectType);
    return new Promise((resolve, reject) => {
      logger.debug('createRecord %s %s', objectType, JSON.stringify(data));
      const inParams = [this.normalizeInputData(objectType, data)];
      logger.debug('createRecord %s', JSON.stringify(inParams));
      this.odoo.execute_kw(objectType, 'create', [inParams], (err, id) => {
        // TODO: check if it is the right contract
        if (err) return reject(err);
        resolve({ id });
      });
    });
  }

  async updateData(objectType, id, data) {
    objectType = this.normalizeInputObjectType(objectType);
    return new Promise((resolve, reject) => {
      logger.debug('updateData %s %s %s', objectType, id, JSON.stringify(data));
      const inParams = [[parseInt(id)], this.normalizeInputData(objectType, data)];
      logger.debug('updateData %s', JSON.stringify(inParams));
      this.odoo.execute_kw(objectType, 'write', [inParams], (err, result) => {
        if (err) return reject({ success: false, error: err });
        resolve({ success: true, result });
      });
    });
  }

  async deleteData(objectType, id) {
    objectType = this.normalizeInputObjectType(objectType);
    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(objectType, 'unlink', [[[parseInt(id)]]], (err, result) => {
        if (err) return reject({ success: false, error: err });
        resolve({ success: true, result });
      });
    });
  }

  async getAttachments(objectType, objectId, mimeTypePrefix = '') {
    objectType = this.normalizeInputObjectType(objectType);
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

module.exports = { OdooConnector };
