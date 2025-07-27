import Odoo from 'odoo-xmlrpc';

export class OdooConnector {
  constructor() {
    this.odoo = null;
  }

  async login({ url, db, username, password }) {
    this.sessionInfo = { url, db, username };
    this.odoo = new Odoo({ url, db, username, password });
    return new Promise((resolve, reject) => {
      this.odoo.connect(err => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async getSessionInfo() {
    return this.sessionInfo;
  }

  async listObjectTypes() {
    console.log('listObjectTypes2');
    const inParams = [
      [],
      ['model', 'name'],
    ];
    const models = await new Promise((resolve, reject) => {
      this.odoo.execute_kw('ir.model', 'search_read', [inParams], (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });

    return models.map(m => ({
      name: m.model, // technical name
      label: m.name,
      labelPlural: m.name + 's',
      keyPrefix: '',     // Odoo doesn't use this — placeholder
      custom: false      // Placeholder — customize if needed
    }));
  }

async getObjectMetadata(objectType) {
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
    fields: fields.map(field => ({
      ...field,
      name: field.name,
      label: field.field_description,
      type: this.normalizeOdooType(field.ttype),
      required: field.required,
      length: field.size || 255,
      updatable: this.isFieldWritable(field),
      referenceTo: field.relation ? [field.relation] : undefined
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

  async getData(objectType, { fields, limit, order } = {}) {
    const orderString = order ? (`create_date ${order.toUpperCase() === 'ASC' ? 'asc' : 'desc'}`) : undefined;
    const inParams = [[], fields, 0, limit || 2000, orderString];
    console.log('inParams', inParams);
    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(
        objectType,
        'search_read',
        [inParams],
        //, { limit: limit || 2000, order: orderString }
        // [[[]], {
        //   fields: fields,
        //   limit,
        //   order: orderString
        // }],
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
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
          resolve(result[0]);
        }
      );
    });
  }

  async createRecord(objectType, data) {
    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(objectType, 'create', [data], (err, id) => {
        if (err) return reject(err);
        resolve({ id });
      });
    });
  }

  async updateData(objectType, id, data) {
    return new Promise((resolve, reject) => {
      this.odoo.execute_kw(objectType, 'write', [[[parseInt(id)], data]], (err, result) => {
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

}