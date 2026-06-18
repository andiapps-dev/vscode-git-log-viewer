#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

sudo chown -R "$(id -u):$(id -g)" "$SCRIPT_DIR"

echo "Running tests in Docker..."
sudo docker run --rm -v "$SCRIPT_DIR:/workspace" -w /workspace node:20-slim sh -c \
    "npm install 2>&1 && npm test 2>&1"

sudo chown -R "$(id -u):$(id -g)" "$SCRIPT_DIR"
