#!/usr/bin/env node

/**
 * DECRYPTION CLI TOOL (SECURE MODE)
 * * DESCRIPTION:
 * Decrypts a cipherText string using the project's internal decryption logic.
 * Like the encryption tool, this ONLY supports interactive mode.
 * * USAGE:
 * $ node bin/decrypt.js
 * * PRE-REQUISITES:
 * Ensure any environment variables required by encryption.js (e.g., MASTER_KEY)
 * are set in your terminal or .env file before running.
 */

const path = require('path');
const readline = require('readline');

// Dynamically resolve the path to the encryption module in the parent directory
const ENCRYPTION_MODULE = path.resolve(__dirname, '../encryption');

try {
    var { decrypt } = require(ENCRYPTION_MODULE);
} catch (e) {
    console.error(`\x1b[31mError: Could not load encryption module from ${ENCRYPTION_MODULE}\x1b[0m`);
    process.exit(1);
}

/**
 * Standard input helper
 */
async function ask(query) {
    const rl = readline.createInterface({ 
        input: process.stdin, 
        output: process.stdout 
    });
    return new Promise(resolve => {
        rl.question(query, (ans) => {
            rl.close();
            resolve(ans);
        });
    });
}

/**
 * Masked input helper (Optional for cipherText, but good practice if 
 * the encrypted string is sensitive/identifiable)
 */
async function askHidden(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const result = new Promise((resolve) => {
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer);
        });
        rl._writeToOutput = (stringToWrite) => {
            if (['\n', '\r', '\r\n'].includes(stringToWrite) || query.includes(stringToWrite)) {
                rl.output.write(stringToWrite);
            } else {
                rl.output.write('\x1b[35m*\x1b[0m'); // Magenta asterisks
            }
        };
    });
    return result;
}

/**
 * Main Execution
 */
async function run() {
    console.log('\n\x1b[1m\x1b[35m» SECURE DECRYPTION TOOL\x1b[0m');
    console.log('\x1b[2m(Direct arguments disabled for security)\x1b[0m\n');

    try {
        const orgId = await ask('Enter Org ID: ');
        if (!orgId) throw new Error('Org ID is required.');

        // We use hidden input even for the cipherText to be extra safe
        const cipherText = await askHidden('Enter CipherText (iv:tag:encrypted): ');
        if (!cipherText) throw new Error('CipherText is required.');

        console.log(''); // Newline after masked input

        const decrypted = decrypt(cipherText, orgId);
        
        console.log('\x1b[2m------------------------------------------\x1b[0m');
        console.log('\x1b[32m✔ Success! Decrypted result:\x1b[0m');
        console.log(`\x1b[1m\x1b[30m\x1b[42m ${decrypted} \x1b[0m`); // Highlighted result
        console.log('\x1b[2m------------------------------------------\x1b[0m\n');

    } catch (err) {
        // The catch block in your decrypt function rethrows, so we handle it here
        console.error(`\n\x1b[31m✘ ${err.message}\x1b[0m`);
        process.exit(1);
    }
}

run();