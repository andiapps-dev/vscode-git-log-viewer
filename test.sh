#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

sudo chown -R "$(id -u):$(id -g)" "$SCRIPT_DIR"

COVERAGE_FLAG=""
if [ "$1" = "--coverage" ]; then
    COVERAGE_FLAG="--coverage"
fi

echo "Running tests in Docker..."
sudo docker run --rm -v "$SCRIPT_DIR:/workspace" -w /workspace node:20-slim sh -c \
    "apt-get update -qq && apt-get install -y -qq git >/dev/null 2>&1 && npm install 2>&1 && npx vitest run $COVERAGE_FLAG 2>&1"

sudo chown -R "$(id -u):$(id -g)" "$SCRIPT_DIR"
