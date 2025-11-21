/*
 * SQLConnector.js + PostgresConnector.js + SnowflakeConnector.js
 * Generated connector set compatible with the structure of your OdooConnector.
 *
 * Files included in this single document:
 *  - SQLConnector (generic implementation)
 *  - PostgresConnector (subclass)
 *  - SnowflakeConnector (subclass, read-only by default)
 *
 * Assumptions:
 *  - There exists ../base-connector.js exporting BaseConnector
 *  - There exists ../logging.js exporting getLogger
 *  - Subclasses must `npm install pg` (postgres) and `snowflake-sdk` (snowflake) if used
 *
 * Notes:
 *  - The SQLConnector uses INFORMATION_SCHEMA to list tables and columns.
 *  - It translates a Mongo-like where DSL into parameterized SQL.
 *  - Datamart/readOnly mode is supported: write operations return an error when readOnly=true.
 *  - Subclasses must implement login() and query(sql, params) methods.
 */

const { BaseConnector } = require('../base-connector.js');
const { getLogger } = require('../logging');

const logger = getLogger('sql-connector');

class SQLConnector extends BaseConnector {
    /**
     * options: { readOnly: boolean, defaultSchema: string }
     */
    constructor(options = {}) {
        super();
        this.client = null; // set by subclass login
        this.sessionInfo = {};
        this.readOnly = !!options.readOnly;
        this.defaultSchema = options.defaultSchema || null;

        // Dialect defaults (subclasses override as needed)
        this.dialect = {
            param: (i) => `$${i}`, // parameter placeholder factory
            quoteIdent: (ident) => `"${ident.replace(/\"/g, '"')}"`,
            likeOperator: 'ILIKE',
            supportsReturning: true,
            limitClause: (n) => `LIMIT ${n}`,
        };
    }

    /* ------------------------------
     * Methods subclasses MUST override
     * ------------------------------ */
    async login(/* connectionParams */) {
        throw new Error('Subclasses must implement login(params)');
    }

    /**
     * Execute a parameterized SQL statement and return rows (array of objects)
     * Subclasses must implement this to match their client API.
     */
    async query(_sql, _params) {
        throw new Error('Subclasses must implement query(sql, params)');
    }

    /* ------------------------------
     * Session / metadata helpers
     * ------------------------------ */
    async getSessionInfo() {
        if (!this.sessionInfo.context) {
            this.sessionInfo.context = {
                configuration: {
                    idField: 'id',
                }
            };
        }
        return this.sessionInfo;
    }

    /* ------------------------------
     * Object (table) discovery
     * ------------------------------ */
    async listObjectTypes() {
        logger.debug('listObjectTypes with schema %s', this.defaultSchema);
        const schemaFilter = this.defaultSchema ? `AND table_schema = ${this.dialect.param(1)}` : '';
        const params = this.defaultSchema ? [this.defaultSchema] : [];

        const sql = `SELECT table_schema, table_name
                 FROM information_schema.tables
                 WHERE table_type = 'BASE TABLE'
                 ${schemaFilter}
                 ORDER BY table_schema, table_name`;

        const rows = await this.query(sql, params);

        return rows.map(r => ({
            name: `${r.table_schema}.${r.table_name}`,
            orgName: r.table_name,
            label: r.table_name,
            labelPlural: r.table_name + 's',
            keyPrefix: '',
            custom: false,
            layoutable: true,
            schema: r.table_schema
        }));
    }

    /**
     * objectType may be 'schema.table' or 'table'
     */
    _parseObjectType(objectType) {
        if (!objectType) throw new Error('objectType is required');
        if (objectType.includes('.')) {
            const [schema, table] = objectType.split('.');
            return { schema, table };
        }
        return { schema: this.defaultSchema || 'public', table: objectType };
    }

    async getObjectMetadata(objectType) {
        const parsed = this._parseObjectType(objectType);
        const params = [parsed.schema, parsed.table];

        const sql = `SELECT column_name, data_type, is_nullable, character_maximum_length, numeric_precision, column_default
                 FROM information_schema.columns
                 WHERE table_schema = ${this.dialect.param(1)}
                   AND table_name = ${this.dialect.param(2)}
                 ORDER BY ordinal_position`;

        const rows = await this.query(sql, params);

        const fields = rows.map(c => ({
            name: c.column_name,
            label: c.column_name,
            type: this._mapSqlTypeToGeneric(c.data_type),
            required: c.is_nullable === 'NO',
            length: c.character_maximum_length || c.numeric_precision || null,
            updateable: true,
            createable: true,
            nativeType: c.data_type,
            defaultValue: c.column_default || null
        }));

        return {
            name: `${parsed.schema}.${parsed.table}`,
            label: parsed.table,
            fields
        };
    }

    _mapSqlTypeToGeneric(sqlType) {
        const t = sqlType.toLowerCase();
        if (t.includes('char') || t.includes('text') || t === 'varchar') return 'string';
        if (t.includes('int')) return 'int';
        if (t === 'boolean' || t === 'bool') return 'boolean';
        if (t.includes('decimal') || t.includes('numeric') || t.includes('real') || t.includes('double')) return 'double';
        if (t === 'date') return 'date';
        if (t.includes('time') || t.includes('timestamp')) return 'datetime';
        return 'string';
    }

    /* ------------------------------
     * Data retrieval
     * ------------------------------ */
    async getData(objectType, { fields, where, limit, order } = {}) {
        logger.debug('getData %s fields=%s where=%s limit=%s order=%s', objectType, JSON.stringify(fields), JSON.stringify(where), limit, JSON.stringify(order));
        const parsed = this._parseObjectType(objectType);
        const tableIdent = `${this.dialect.quoteIdent(parsed.schema)}.${this.dialect.quoteIdent(parsed.table)}`;

        // fields
        const fieldList = (fields && fields.length) ? fields.map(f => this._quoteField(parsed, f)).join(', ') : '*';

        // build where
        const context = { params: [], paramIndex: 1 };
        const whereClause = await this._buildWhere(parsed, where, context);
        const whereSql = whereClause ? `WHERE ${whereClause}` : '';

        // order
        let orderSql = '';
        if (order) {
            const orderParts = Object.entries(order).map(([k, dir]) => `${this._quoteField(parsed, k)} ${dir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`);
            orderSql = `ORDER BY ${orderParts.join(', ')}`;
        }

        const limitSql = limit ? ` ${this.dialect.limitClause(limit)}` : '';

        const sql = `SELECT ${fieldList} FROM ${tableIdent} ${whereSql} ${orderSql} ${limitSql}`;

        logger.debug('Executing SQL: %s params=%s', sql, JSON.stringify(context.params));
        const rows = await this.query(sql, context.params);

        return { records: rows, totalSize: undefined, totalFetched: rows.length };
    }

    async getRecordById(objectType, id, fields = null) {
        const parsed = this._parseObjectType(objectType);
        // assume primary key named id or the first column named id
        const idField = 'id';
        const res = await this.getData(objectType, { fields, where: { [idField]: id }, limit: 1 });
        return res.records[0] || null;
    }

    /* ------------------------------
     * Create / Update / Delete
     * ------------------------------ */
    async createRecord(objectType, data) {
        if (this.readOnly) throw new Error('Read-only connector: create not allowed');
        const parsed = this._parseObjectType(objectType);
        const cols = Object.keys(data);
        if (cols.length === 0) throw new Error('No data provided');

        const context = { params: [], paramIndex: 1 };
        const quotedCols = cols.map(c => this.dialect.quoteIdent(c));
        const placeholders = cols.map(() => this.dialect.param(context.paramIndex++));
        context.params.push(...cols.map(c => data[c]));

        const tableIdent = `${this.dialect.quoteIdent(parsed.schema)}.${this.dialect.quoteIdent(parsed.table)}`;
        const returning = this.dialect.supportsReturning ? 'RETURNING *' : '';
        const sql = `INSERT INTO ${tableIdent} (${quotedCols.join(',')}) VALUES (${placeholders.join(',')}) ${returning}`;

        const rows = await this.query(sql, context.params);
        // return id if present or full row
        return { id: rows && rows[0] ? (rows[0].id || null) : null, record: rows && rows[0] ? rows[0] : null };
    }

    async updateData(objectType, id, data) {
        if (this.readOnly) throw new Error('Read-only connector: update not allowed');
        const parsed = this._parseObjectType(objectType);
        const cols = Object.keys(data);
        if (cols.length === 0) throw new Error('No data provided');

        const context = { params: [], paramIndex: 1 };
        const setParts = cols.map(c => `${this.dialect.quoteIdent(c)} = ${this.dialect.param(context.paramIndex++)}`);
        context.params.push(...cols.map(c => data[c]));

        const tableIdent = `${this.dialect.quoteIdent(parsed.schema)}.${this.dialect.quoteIdent(parsed.table)}`;
        const idField = 'id';
        context.params.push(id);
        const whereClause = `${this.dialect.quoteIdent(idField)} = ${this.dialect.param(context.paramIndex++)}`;
        const returning = this.dialect.supportsReturning ? 'RETURNING *' : '';

        const sql = `UPDATE ${tableIdent} SET ${setParts.join(', ')} WHERE ${whereClause} ${returning}`;
        const rows = await this.query(sql, context.params);
        return { success: true, result: rows && rows[0] ? rows[0] : null };
    }

    async deleteData(objectType, id) {
        if (this.readOnly) throw new Error('Read-only connector: delete not allowed');
        const parsed = this._parseObjectType(objectType);
        const tableIdent = `${this.dialect.quoteIdent(parsed.schema)}.${this.dialect.quoteIdent(parsed.table)}`;
        const idField = 'id';
        const sql = `DELETE FROM ${tableIdent} WHERE ${this.dialect.quoteIdent(idField)} = ${this.dialect.param(1)} RETURNING *`;
        const rows = await this.query(sql, [id]);
        return { success: true, result: rows && rows[0] ? rows[0] : null };
    }

    /* ------------------------------
     * Attachments
     * ------------------------------ */
    async getAttachments(objectType, objectId, mimeTypePrefix = '') {
        // Generic SQL datastores usually don't store attachments in a standard way.
        // Implementers may override if they have attachment tables.
        return [];
    }

    /* ------------------------------
     * Utilities
     * ------------------------------ */
    _quoteField(parsed, field) {
        // If field contains dot (related) or functions, leave it as is for now
        if (field.includes('.')) {
            const parts = field.split('.');
            return parts.map(p => this.dialect.quoteIdent(p)).join('.');
        }
        return this.dialect.quoteIdent(field);
    }

    async _buildWhere(parsed, where, context) {
        if (!where || Object.keys(where).length === 0) return '';
        if (!context) context = { params: [], paramIndex: 1 };

        const clauses = [];

        for (const [key, value] of Object.entries(where)) {
            if (key === '$or' && Array.isArray(value)) {
                const parts = await Promise.all(value.map(v => this._buildWhere(parsed, v, context)));
                clauses.push(`(${parts.filter(Boolean).join(' OR ')})`);
            } else if (key === '$not') {
                const part = await this._buildWhere(parsed, value, context);
                if (part) clauses.push(`(NOT (${part}))`);
            } else {
                // simple field or nested object
                if (typeof value === 'object' && value !== null && !Array.isArray(value) && !('$select' in value)) {
                    // operator object
                    const [[op, operand]] = Object.entries(value);
                    const fieldSql = this._quoteField(parsed, key);

                    switch (op) {
                        case '$like': {
                            const param = this.dialect.param(context.paramIndex++);
                            context.params.push(String(operand).replace(/%/g, '%'));
                            clauses.push(`${fieldSql} ${this.dialect.likeOperator} ${param}`);
                            break;
                        }
                        case '$neq': {
                            const param = this.dialect.param(context.paramIndex++);
                            context.params.push(operand);
                            clauses.push(`${fieldSql} != ${param}`);
                            break;
                        }
                        case '$gt': {
                            const param = this.dialect.param(context.paramIndex++);
                            context.params.push(operand);
                            clauses.push(`${fieldSql} > ${param}`);
                            break;
                        }
                        case '$lt': {
                            const param = this.dialect.param(context.paramIndex++);
                            context.params.push(operand);
                            clauses.push(`${fieldSql} < ${param}`);
                            break;
                        }
                        case '$in': {
                            if (Array.isArray(operand)) {
                                if (operand.length === 0) {
                                    clauses.push('FALSE');
                                } else {
                                    const placeholders = operand.map(() => this.dialect.param(context.paramIndex++));
                                    context.params.push(...operand);
                                    clauses.push(`${fieldSql} IN (${placeholders.join(',')})`);
                                }
                            } else if (operand && operand.$select) {
                                // operand.$select: { model, field, where }
                                const { model, field, where: subWhere } = operand.$select;
                                // fetch the sub-select values using getData
                                const sub = await this.getData(model, { fields: [field], where: subWhere, limit: null });
                                const values = (sub.records || []).map(r => r[field]).filter(v => v !== undefined && v !== null);
                                if (values.length === 0) {
                                    clauses.push('FALSE');
                                } else {
                                    const placeholders = values.map(() => this.dialect.param(context.paramIndex++));
                                    context.params.push(...values);
                                    clauses.push(`${fieldSql} IN (${placeholders.join(',')})`);
                                }
                            } else {
                                throw new Error(`Unsupported $in operand: ${JSON.stringify(operand)}`);
                            }
                            break;
                        }
                        default:
                            throw new Error(`Unsupported operator: ${op}`);
                    }
                } else {
                    // direct equality or null
                    const fieldSql = this._quoteField(parsed, key);
                    if (value === null) {
                        clauses.push(`${fieldSql} IS NULL`);
                    } else {
                        const param = this.dialect.param(context.paramIndex++);
                        context.params.push(value);
                        clauses.push(`${fieldSql} = ${param}`);
                    }
                }
            }
        }

        return clauses.join(' AND ');
    }
}

/* -----------------------------------
 * PostgresConnector
 * ----------------------------------- */
class PostgresConnector extends SQLConnector {
    constructor(options = {}) {
        super(options);
        // postgres specifics
        this.dialect.param = (i) => `$${i}`;
        this.dialect.quoteIdent = (ident) => `"${ident.replace(/"/g, '"')}"`;
        this.dialect.likeOperator = 'ILIKE';
        this.dialect.supportsReturning = true;
        this.dialect.limitClause = (n) => `LIMIT ${n}`;
        this.client = null;
    }

    async login({ host = 'localhost', port = 5432, user, password, database }) {
        const { Client } = require('pg');
        this.client = new Client({ host, port, user, password, database });
        await this.client.connect();
        this.sessionInfo = { host, port, user, database };
        logger.info('Postgres connected to %s@%s/%s', user, host, database);
    }

    async query(sql, params = []) {
        if (!this.client) throw new Error('Not connected');
        const res = await this.client.query(sql, params);
        return res.rows;
    }
}

/* -----------------------------------
 * SnowflakeConnector
 * Note: Snowflake SDK uses callbacks; we wrap with promises.
 * This subclass defaults to readOnly=true in constructor unless explicitly overridden.
 * ----------------------------------- */
class SnowflakeConnector extends SQLConnector {
    constructor(options = {}) {
        options.readOnly = options.readOnly !== undefined ? options.readOnly : true;
        super(options);
        // Snowflake uses ? binds and double quotes for identifiers
        this.dialect.param = (i) => `?`;
        this.dialect.quoteIdent = (ident) => `"${ident.replace(/\"/g, '"')}"`;
        this.dialect.likeOperator = 'ILIKE';
        this.dialect.supportsReturning = false; // Snowflake doesn't support RETURNING
        this.dialect.limitClause = (n) => `LIMIT ${n}`;
        this.client = null;
        this.context = {};
    }

    async login({ account, username, password, warehouse, database, schema, role }) {
        const snowflake = require('snowflake-sdk');
        this.client = snowflake.createConnection({ account, username, password, warehouse, role });

        await new Promise((resolve, reject) => {
            this.client.connect((err, conn) => {
                if (err) return reject(err);
                resolve(conn);
            });
        });

        // Set default context
        this.context = { database, schema, warehouse };
        this.defaultSchema = schema || this.defaultSchema;
        this.sessionInfo = { account, username, database, schema };
        logger.info('Snowflake connected to %s@%s/%s', username, account, database);
    }

    async query(sql, params = []) {
        if (!this.client) throw new Error('Not connected');
        return await new Promise((resolve, reject) => {
            this.client.execute({
                sqlText: sql,
                binds: params,
                complete: (err, stmt, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            });
        });
    }
}


// --- Additional connectors: Oracle, SQLite, Trino/Presto, DuckDB, Firebolt ---


class OracleConnector extends SQLConnector {
    constructor() {
        super();
        this.dialect.like = 'LIKE';
        this.dialect.param = i => `:${i}`;
        this.dialect.quoteIdent = ident => `"${ident}"`;
    }
    async login({ user, password, connectString }) {
        const oracledb = require('oracledb');
        this.client = await oracledb.getConnection({ user, password, connectString });
    }
    async query(sql, params) {
        const binds = {};
        params.forEach((val, i) => binds[i + 1] = val);
        const result = await this.client.execute(sql, binds, { outFormat: require('oracledb').OUT_FORMAT_OBJECT });
        return result.rows;
    }
}


class SQLiteConnector extends SQLConnector {
    constructor() {
        super();
        this.dialect.like = 'LIKE';
        this.dialect.param = () => '?';
        this.dialect.quoteIdent = ident => `\"${ident}\"`;
    }
    async login({ filename }) {
        const sqlite3 = require('sqlite3');
        const { open } = require('sqlite');
        this.client = await open({ filename, driver: sqlite3.Database });
    }
    async query(sql, params) {
        return await this.client.all(sql, params);
    }
}


class TrinoConnector extends SQLConnector {
    constructor() {
        super();
        this.dialect.like = 'ILIKE';
        this.dialect.param = () => '?';
        this.dialect.quoteIdent = ident => `\"${ident}\"`;
    }
    async login({ host, port, user, password, catalog, schema }) {
        const trino = require('trino-client');
        this.client = new trino.Client({ server: `${host}:${port}`, user, password, catalog, schema });
    }
    async query(sql) {
        return await new Promise((resolve, reject) => {
            const rows = [];
            this.client.query(sql)
                .on('data', row => rows.push(row))
                .on('end', () => resolve(rows))
                .on('error', err => reject(err));
        });
    }
}


class DuckDBConnector extends SQLConnector {
    constructor() {
        super();
        this.dialect.like = 'ILIKE';
        this.dialect.param = () => '?';
        this.dialect.quoteIdent = ident => `\"${ident}\"`;
    }
    async login({ filename = ':memory:' }) {
        const duckdb = require('duckdb');
        const db = new duckdb.Database(filename);
        this.client = db;
        this.connection = db.connect();
    }
    async query(sql, params) {
        return await new Promise((resolve, reject) => {
            this.connection.all(sql, params || [], (err, rows) => err ? reject(err) : resolve(rows));
        });
    }
}


class FireboltConnector extends SQLConnector {
    constructor() {
        super();
        this.dialect.like = 'ILIKE';
        this.dialect.param = i => `$${i}`;
        this.dialect.quoteIdent = ident => `\"${ident}\"`;
    }
    async login({ account, username, password, database }) {
        const Firebolt = require('firebolt-sdk');
        this.client = await Firebolt.connect({ account, username, password, database });
    }
    async query(sql, params) {
        const command = this.client.createStatement({ query: sql, params });
        const result = await command.execute();
        return result.data;
    }
}

module.exports = { SQLConnector, PostgresConnector, SnowflakeConnector, ClickHouseConnector, OracleConnector, SQLiteConnector, TrinoConnector, DuckDBConnector, FireboltConnector };
