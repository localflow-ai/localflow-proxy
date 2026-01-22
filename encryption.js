const crypto = require('crypto');
require('dotenv').config();

const MASTER_KEY = Buffer.from(process.env.MASTER_ENCRYPTION_KEY, 'hex');
const ALGORITHM = 'aes-256-gcm';

function getOrgKey(orgId) {
    return crypto.createHash('sha256')
        .update(MASTER_KEY + orgId)
        .digest();
}

function encrypt(text, orgId) {
    const orgKey = getOrgKey(orgId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, orgKey, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag().toString('hex');
    
    // Format: iv:tag:ciphertext
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decrypt(cipherText, orgId) {
    try {
        const orgKey = getOrgKey(orgId);
        const [ivHex, tagHex, encryptedHex] = cipherText.split(':');
        
        const decipher = crypto.createDecipheriv(
            ALGORITHM, 
            orgKey, 
            Buffer.from(ivHex, 'hex')
        );
        
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        throw new Error("Decryption failed: Likely invalid OrgId or tampered data.");
    }
}

module.exports = { encrypt, decrypt };