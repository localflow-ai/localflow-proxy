const crypto = require('crypto');
const path = require('path');
// Explicitly point to the .env in the project root
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const keyHex = process.env.MASTER_ENCRYPTION_KEY;
if (!keyHex) {
    throw new Error("MASTER_ENCRYPTION_KEY is not defined in environment variables");
}
const MASTER_KEY = Buffer.from(keyHex, 'hex');
const ALGORITHM = 'aes-256-gcm';

function getOrgKey(orgId) {
    // Better way to combine Buffer and String for hashing
    return crypto.createHash('sha256')
        .update(Buffer.concat([MASTER_KEY, Buffer.from(orgId)]))
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