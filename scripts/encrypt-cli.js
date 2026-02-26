#!/usr/bin/env node

/**
 * ENCRYPTION CLI TOOL (SECURE MODE)
 * * * DESCRIPTION:
 * Encrypts sensitive text using the project's internal encryption logic.
 * This script ONLY supports interactive mode to prevent secrets from 
 * being stored in the shell's command history.
 * * * USAGE:
 * $ node bin/encrypt.js
 * * * PRE-REQUISITES:
 * Ensure any environment variables required by encryption.js (e.g., MASTER_KEY)
 * are set in your terminal or .env file before running.
 */

const path = require('path');
const readline = require('readline');

// Dynamically resolve the path to the encryption module in the parent directory
const ENCRYPTION_MODULE = path.resolve(__dirname, '../encryption');

try {
    // Using var to ensure availability in the outer scope if needed, 
    // though const is preferred in modern Node.
    var { encrypt } = require(ENCRYPTION_MODULE);
} catch (e) {
    console.error(`\x1b[31mError: Could not load encryption module from ${ENCRYPTION_MODULE}\x1b[0m`);
    process.exit(1);
}

/**
 * Masked input helper for sensitive text
 */
async function askHidden(query) {
    const rl = readline.createInterface({ 
        input: process.stdin, 
        output: process.stdout 
    });

    const result = new Promise((resolve) => {
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer);
        });

        // Masking logic: intercepts the stream to hide keystrokes
        rl._writeToOutput = (stringToWrite) => {
            if (['\n', '\r', '\r\n'].includes(stringToWrite) || query.includes(stringToWrite)) {
                rl.output.write(stringToWrite);
            } else {
                rl.output.write('\x1b[33m*\x1b[0m'); // Feedback asterisks
            }
        };
    });
    return result;
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
 * Main Execution
 */
async function run() {
    console.log('\n\x1b[1m\x1b[34m» SECURE ENCRYPTION TOOL\x1b[0m');
    console.log('\x1b[2m(Direct arguments disabled for security)\x1b[0m\n');

    try {
        const orgId = await ask('Enter Org ID: ');
        if (!orgId) throw new Error('Org ID is required.');

        const text = await askHidden('Enter Secret Text: ');
        if (!text) throw new Error('Secret text is required.');

        console.log(''); // Newline for clean formatting after masked input

        const encrypted = encrypt(text, orgId);
        
        console.log('\x1b[2m------------------------------------------\x1b[0m');
        console.log('\x1b[32m✔ Success! Encrypted string:\x1b[0m');
        console.log(`\x1b[1m${encrypted}\x1b[0m`);
        console.log('\x1b[2m------------------------------------------\x1b[0m\n');

    } catch (err) {
        console.error(`\n\x1b[31m✘ Error: ${err.message}\x1b[0m`);
        process.exit(1);
    }
}

run();