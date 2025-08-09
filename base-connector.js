export class BaseConnector {
  constructor() {
  }

  /**
   * Creates a field mapping and a reversed mapping for output/input key translation.
   */
  async createFieldMapping(mapping) {
    if (!this.sessionInfo.mappings) this.sessionInfo.mappings = {};
    this.sessionInfo.mappings.fieldMapping = mapping;
    this.sessionInfo.mappings.fieldMappingReversed = Object.fromEntries(
      Object.entries(mapping).map(([k, v]) => [v, k])
    );
    return { success: true };
  }

  normalizeInputData(data) {
    if (Array.isArray(data)) {
      return data.map(d => this.normalizeInputData(d));
    } else if (data && typeof data === 'object') {
      const result = {};
      for (const [key, value] of Object.entries(data)) {
        const mappedKey = this.normalizeInputKey(key);
        result[mappedKey] = value;
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
      for (const [key, value] of Object.entries(data)) {
        const mappedKey = this.normalizeOutputKey(key);
        result[mappedKey] = value;
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
}