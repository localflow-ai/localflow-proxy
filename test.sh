#!/bin/bash

if [ -z "$DAQUOTA_PROXY_TEST_USERNAME" ]; then
    echo 'Enter Daquota proxy username:'
    read DAQUOTA_PROXY_TEST_USERNAME
    export DAQUOTA_PROXY_TEST_USERNAME
fi

if [ -z "$DAQUOTA_PROXY_TEST_PASS" ]; then
    echo 'Enter Daquota proxy password:'
    read -s DAQUOTA_PROXY_TEST_PASS
fi

DAQUOTA_PROXY_TEST_USERNAME="$DAQUOTA_PROXY_TEST_USERNAME" DAQUOTA_PROXY_TEST_PASS="$DAQUOTA_PROXY_TEST_PASS" NODE_OPTIONS="$NODE_OPTIONS --experimental-vm-modules" npm run testWatch