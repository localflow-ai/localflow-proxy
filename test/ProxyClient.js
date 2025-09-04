
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

module.exports = {
    ProxyClient
}