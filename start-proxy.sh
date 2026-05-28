#!/bin/bash

rm proxy.log

# Load NVM (if not already available in your shell)
export NVM_DIR="$HOME/.nvm"
# Source nvm.sh to use nvm command
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Use Node.js version 20 (ARM-native on Apple Silicon)
nvm use 20

# Start the app with nohup and redirect output
nohup npm start > proxy.log 2>&1 &

