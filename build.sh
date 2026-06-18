#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Fix ownership from previous Docker builds
sudo chown -R "$(id -u):$(id -g)" "$SCRIPT_DIR"

# Bump patch version
python3 -c "
import json, pathlib
p = pathlib.Path('$SCRIPT_DIR/package.json')
pkg = json.loads(p.read_text())
parts = pkg['version'].split('.')
parts[2] = str(int(parts[2]) + 1)
pkg['version'] = '.'.join(parts)
p.write_text(json.dumps(pkg, indent=2) + '\n')
print('Version: ' + pkg['version'])
"

rm -f "$SCRIPT_DIR"/*.vsix
sudo rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/dist"

echo "Building extension in Docker..."
sudo docker run --rm -v "$SCRIPT_DIR:/workspace" -w /workspace node:20-slim sh -c \
    "npm install 2>&1 && npm run build 2>&1 && npx @vscode/vsce package 2>&1"

# Fix ownership of build output
sudo chown -R "$(id -u):$(id -g)" "$SCRIPT_DIR"

VSIX=$(ls -t "$SCRIPT_DIR"/*.vsix 2>/dev/null | head -1)
if [ -z "$VSIX" ]; then
    echo "ERROR: No .vsix file found after build"
    exit 1
fi

echo "Built: $VSIX"
