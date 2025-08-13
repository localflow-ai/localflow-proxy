export class BaseConnector {
    constructor() {
    }

    _normalizeMapping(mapping) {
        const normalizedMapping = {};
        Object.entries(mapping).forEach(([key, v]) => {
            if (key.includes('|')) {
                key = key.split('|');
            } else {
                key = [key];
            }
            if (v.includes('|')) {
                v = v.split('|')[0];
            }
            key.forEach(k => {
                if (k.includes('[')) {
                    // key is of the form "fieldName[index]", extract the index with regex
                    const [parentKey, index] = k.split(new RegExp('\\[|\\]')).filter(s => s);
                    normalizedMapping[parentKey] = v;
                    normalizedMapping[parentKey + '$$index'] = parseInt(index);
                } else {
                    if (k.includes('.')) {
                        const [parentKey, childKey] = k.split('.');
                        if (!normalizedMapping[parentKey]) {
                            normalizedMapping[parentKey] = [];
                        }
                        if (v.includes('[')) {
                            const [childKey, index] = v.split(new RegExp('\\[|\\]')).filter(s => s);
                            v = childKey;
                            normalizedMapping[k + '$$conf'] = { readonly: true };
                        }
                        normalizedMapping[parentKey].push(v);
                    }
                    normalizedMapping[k] = v;
                }
            });
        });
        return normalizedMapping;
    }

    /**
     * Creates a field mapping and a reversed mapping for output/input key translation.
     */
    async createFieldMapping(mapping) {
        console.log('[daquota proxy] creating mapping', mapping);

        if (!this.sessionInfo.mappings) this.sessionInfo.mappings = {};
        this.sessionInfo.mappings.fieldMapping = this._normalizeMapping(mapping);

        this.sessionInfo.mappings.fieldMappingReversed = this._normalizeMapping(Object.fromEntries(
            Object.entries(mapping).map(([k, v]) => [v, k])
        ));
        console.log('[daquota proxy] field mapping', this.sessionInfo.mappings.fieldMapping);
        console.log('[daquota proxy] reversed field mapping', this.sessionInfo.mappings.fieldMappingReversed);
        /*const test = [
            {
                "id": 14,
                "name": "Azure Interior",
                "street": "4557 De Silva St",
                "street2": false,
                "city": "Fremont",
                "state_id": [
                    13,
                    "California (US)"
                ],
                "zip": "94538",
                "country_id": [
                    233,
                    "United States"
                ],
                "is_company": true,
                "company_name": false,
                "phone": "(870)-931-0505"
            },
            {
                "id": 26,
                "name": "Brandon Freeman",
                "street": "4557 De Silva St",
                "street2": false,
                "city": "Fremont",
                "state_id": [
                    13,
                    "California (US)"
                ],
                "zip": "94538",
                "country_id": [
                    233,
                    "United States"
                ],
                "is_company": false,
                "company_name": false,
                "phone": "(355)-687-3262"
            }
        ]
        console.log('[daquota proxy] testing mapping', this.normalizeOutputData(test));
        console.log('[daquota proxy] testing mapping reversed', this.normalizeInputData(this.normalizeOutputData(test)));
        */
        return { success: true };
    }

    normalizeInputData(data, context = []) {
        //console.log('[daquota proxy] normalizeInputData', data, context);
        if (Array.isArray(data)) {
            return data.map(d => this.normalizeInputData(d));
        } else if (data && typeof data === 'object') {
            const result = {};
            const mapping = this.sessionInfo.mappings?.fieldMappingReversed;
            for (let [key, value] of Object.entries(data)) {
                const fullKey = [...context, key].join('.');
                //console.log('[daquota proxy] normalizeInputData, key, fullkey', key, fullKey, value);
                const mappedKey = this.normalizeInputKey(fullKey);
                if (mapping[fullKey + '$$conf'] && mapping[fullKey + '$$conf'].readonly) {
                    continue;
                }
                if (Array.isArray(mappedKey) && typeof value === 'object') {
                    // case of compound object
                    context.push(key);
                    const normalizedObect = this.normalizeInputData(value, context);
                    context.pop();
                    Object.assign(result, normalizedObect);
                    continue;
                }
                if (mapping && mapping[key + '$$index']) {
                    value = value[mapping[key + '$$index']];
                }
                if (mappedKey.includes('.')) {
                    const [parentKey, childKey] = mappedKey.split('.');
                    result[parentKey] = result[parentKey] || {};
                    if (!result[parentKey][childKey] === undefined) {
                        result[parentKey][childKey] = value;
                    } else {
                        result[parentKey][childKey] += ' ' + value;
                    }
                } else {
                    result[mappedKey] = value;
                }
            }
            return result;
        }
        return data;
    }

    normalizeOutputData(data) {
        if (Array.isArray(data)) {
            return data.map(d => this.normalizeOutputData(d));
        } else if (data && typeof data === 'object') {
            const result = {};
            const mapping = this.sessionInfo.mappings?.fieldMapping;
            for (let [key, value] of Object.entries(data)) {
                const mappedKey = this.normalizeOutputKey(key);
                if (mapping && mapping[key + '$$index']) {
                    value = value[mapping[key + '$$index']];
                }
                if (mappedKey.includes('.')) {
                    const [parentKey, childKey] = mappedKey.split('.');
                    result[parentKey] = result[parentKey] || {};
                    if (!result[parentKey][childKey]) {
                        result[parentKey][childKey] = value;
                    } else {
                        result[parentKey][childKey] += ' ' + value;
                    }
                } else {
                    result[mappedKey] = value;
                }
            }
            return result;
        }
        return data;
    }

    normalizeInputKey(key) {
        const reversed = this.sessionInfo.mappings?.fieldMappingReversed;
        return reversed?.[key] || key;
    }

    normalizeOutputKey(key) {
        const mapping = this.sessionInfo.mappings?.fieldMapping;
        return mapping?.[key] || key;
    }

    normalizeInputFieldNames(fields) {
        if (fields == null) return fields;
        return fields.reduce((normalized, f) => {
            const normalizedKey = this.normalizeInputKey(f);
            if (Array.isArray(normalizedKey)) {
                normalized.push(...normalizedKey);
            } else {
                normalized.push(normalizedKey);
            }
            return normalized;
        }, []);
    }

    processFields(objectName, fields) {
        const processedFields = [];
        const compoundTypes = new Set();
        fields.forEach(field => {
            const mappedFieldName = this.normalizeOutputKey(field.name);
            if (!mappedFieldName.includes('.')) {
                field.name = mappedFieldName;
                if (field.relationshipName) {
                    field.relationshipName = mappedFieldName;
                }
                processedFields.push(field);
                console.log('[daquota proxy] add field', objectName, field.name);
            } else {
                const compoundType = mappedFieldName.split('.')[0];
                if (!compoundTypes.has(compoundType)) {
                    compoundTypes.add(compoundType);
                    field.name = compoundType;
                    field.relationshipName = compoundType;
                    if (compoundType.endsWith('Address')) {
                        field.type = 'address';
                    }
                    processedFields.push(field);
                    console.log('[daquota proxy] add field', objectName, field.name);
                }
            }
        });
        return processedFields;
    }
}