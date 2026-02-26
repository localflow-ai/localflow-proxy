const { BaseConnector } = require('../base-connector.js');
const { getLogger } = require('../logging');

const logger = getLogger('public-connector');

/**
 * Public Connector for providing a safe "empty" environment.
 * Implements the same interface as OdooConnector but returns mocked empty data.
 */
class PublicConnector extends BaseConnector {
  constructor() {
    super();
    this.sessionInfo = { type: 'public', url: 'mock://public', orgId: 'publicOrgId-mocked-org' };
  }

  async login(config) {
    logger.info('Public session initialized');
    this.sessionInfo.userId = 0;
    return Promise.resolve();
  }

  // Mocked Metadata
  async getSessionInfo() {
    return {
      type: this.sessionInfo.type,
      context: {
        user: { id: 0, name: 'Public User', email: 'public@example.com', isAdmin: false },
        permissions: [],
        configuration: {}
      }
    };
  }

  async listObjectTypes() {
    return [];
  }

  async getObjectMetadata(objectType) {
    return {
      name: objectType,
      layoutable: false,
      label: objectType,
      fields: []
    };
  }

  // Mocked Data Operations (Always returning empty or success)
  async getData(objectType, options = {}) {
    logger.debug('Public getData called for %s', objectType);
    return { 
      records: [], 
      totalSize: 0, 
      totalFetched: 0 
    };
  }

  async getRecordById(objectType, id, fields = null) {
    return null;
  }

  async createRecord(objectType, data) {
    logger.debug('Public createRecord mock - ID generated');
    return { id: Math.floor(Math.random() * 1000) };
  }

  async updateData(objectType, id, data) {
    return { success: true, result: true };
  }

  async deleteData(objectType, id) {
    return { success: true, result: true };
  }

  async getAttachments(objectType, objectId) {
    return [];
  }

  async sendEmail(params) {
    logger.info('Public email mock: Email "sent" to %s', params.to);
    return { success: true, mailId: 'mock-mail-id' };
  }
}

module.exports = { PublicConnector };