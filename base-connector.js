const { getLogger } = require('./logging');
const logger = getLogger('base-connector');

class BaseConnector {
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

    async createObjectTypeMapping(mapping) {
        logger.info('[daquota proxy] creating object type mapping', mapping);
        if (!this.sessionInfo.mappings) this.sessionInfo.mappings = {};
        if (!this.sessionInfo.mappings.objectTypeMapping) this.sessionInfo.mappings.objectTypeMapping = {};
        this.sessionInfo.mappings.objectTypeMapping = mapping;
        this.sessionInfo.mappings.objectTypeMappingReversed = Object.fromEntries(
            Object.entries(mapping).map(([k, v]) => [v, k])
        );
        logger.info('[daquota proxy] object type mapping', this.sessionInfo.mappings.objectTypeMapping);
        logger.info('[daquota proxy] reversed object type mapping', this.sessionInfo.mappings.objectTypeMappingReversed);
        return { success: true };
    }   

    /**
     * Creates a field mapping and a reversed mapping for output/input key translation.
     */
    async createFieldMapping(objectType, mapping) {
        logger.info('[daquota proxy] creating mapping', mapping);

        if (!this.sessionInfo.mappings) this.sessionInfo.mappings = {};
        if (!this.sessionInfo.mappings.fieldMapping) this.sessionInfo.mappings.fieldMapping = {};
        if (!this.sessionInfo.mappings.fieldMappingReversed) this.sessionInfo.mappings.fieldMappingReversed = {};
        this.sessionInfo.mappings.fieldMapping[objectType] = this._normalizeMapping(mapping);

        this.sessionInfo.mappings.fieldMappingReversed[objectType] = this._normalizeMapping(Object.fromEntries(
            Object.entries(mapping).map(([k, v]) => [v, k])
        ));
        logger.info('[daquota proxy] field mapping', this.sessionInfo.mappings.fieldMapping);
        logger.info('[daquota proxy] reversed field mapping', this.sessionInfo.mappings.fieldMappingReversed);
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
        logger.info('[daquota proxy] testing mapping', this.normalizeOutputData(test));
        logger.info('[daquota proxy] testing mapping reversed', this.normalizeInputData(this.normalizeOutputData(test)));
        */
        return { success: true };
    }

    normalizeInputData(objectType, data, context = []) {
        //logger.info('[daquota proxy] normalizeInputData', data, context);
        if (Array.isArray(data)) {
            return data.map(d => this.normalizeInputData(objectType, d));
        } else if (data && typeof data === 'object') {
            const result = {};
            const mapping = this.sessionInfo.mappings?.fieldMappingReversed;
            if (!mapping) {
                return data;
            } 
            for (let [key, value] of Object.entries(data)) {
                const fullKey = [...context, key].join('.');
                //logger.info('[daquota proxy] normalizeInputData, key, fullkey', key, fullKey, value);
                const mappedKey = this.normalizeInputKey(objectType, fullKey);
                if (mapping[fullKey + '$$conf'] && mapping[fullKey + '$$conf'].readonly) {
                    continue;
                }
                if (Array.isArray(mappedKey) && typeof value === 'object') {
                    // case of compound object
                    context.push(key);
                    const normalizedObject = this.normalizeInputData(objectType, value, context);
                    context.pop();
                    Object.assign(result, normalizedObject);
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

    normalizeOutputData(objectType, data) {
        if (Array.isArray(data)) {
            return data.map(d => this.normalizeOutputData(objectType, d));
        } else if (data && typeof data === 'object') {
            const result = {};
            const mapping = this.sessionInfo.mappings?.fieldMapping;
            if (!mapping) {
                return data;
            } 
            for (let [key, value] of Object.entries(data)) {
                const mappedKey = this.normalizeOutputKey(objectType, key);
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

    getFieldMapping(objectType) {
        return {
            ...this.sessionInfo.mappings?.fieldMapping.$global,
            ...this.sessionInfo.mappings?.fieldMapping[objectType]
        }
    }

    getFieldMappingReversed(objectType) {
        return {
            ...this.sessionInfo.mappings?.fieldMappingReversed.$global,
            ...this.sessionInfo.mappings?.fieldMappingReversed[objectType]
        }
    }

    normalizeInputKey(objectType, key) {
        const reversed = this.getFieldMappingReversed(objectType);
        return reversed?.[key] || key;
    }

    normalizeOutputKey(objectType, key) {
        const mapping = this.getFieldMapping(objectType);
        return mapping?.[key] || key;
    }

    normalizeInputObjectType(objectType) {
        const reversed = this.sessionInfo.mappings?.objectTypeMappingReversed;
        return reversed?.[objectType] || objectType;
    }

    normalizeOutputObjectType(objectType) {
        const mapping = this.sessionInfo.mappings?.objectTypeMapping;
        return mapping?.[objectType] || objectType;
    }

    normalizeInputFieldNames(objectType, fields) {
        if (fields == null) return fields;
        return fields.reduce((normalized, f) => {
            const normalizedKey = this.normalizeInputKey(objectType, f);
            if (Array.isArray(normalizedKey)) {
                normalized.push(...normalizedKey);
            } else {
                normalized.push(normalizedKey);
            }
            return normalized;
        }, []);
    }

    processFields(objectType, fields) {
        const processedFields = [];
        const compoundTypes = new Set();
        fields.forEach(field => {
            const mappedFieldName = this.normalizeOutputKey(objectType, field.name);
            if (!mappedFieldName.includes('.')) {
                if (field.name === field.relationshipName) {
                    field.relationshipName = mappedFieldName;
                }
                field.name = mappedFieldName;
                processedFields.push(field);
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
                }
            }
        });
        return processedFields;
    }
}

module.exports = { BaseConnector };