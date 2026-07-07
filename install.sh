#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Fix ownership from previous Docker builds
sudo chown -R "$(id -u):$(id -g)" "$SCRIPT_DIR"

rm -f "$SCRIPT_DIR"/*.vsix
sudo rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/dist"

echo "Building DEV extension in Docker..."
sudo docker run --rm -v "$SCRIPT_DIR:/workspace" -w /workspace node:20-slim sh -c '
    cp package.json package.json.bak

    node -e "
      const pkg = JSON.parse(require(\"fs\").readFileSync(\"package.json\",\"utf8\"));
      pkg.name = \"git-log-viewer-dev\";
      pkg.displayName = \"Git Log Viewer (Dev)\";
      for (const cmd of pkg.contributes.commands) {
        if (cmd.command === \"gitLogViewer.showLog\") {
          cmd.command = \"gitLogViewerDev.showLog\";
          cmd.title = \"Show Git Log (Dev)\";
        }
      }
      for (const entries of Object.values(pkg.contributes.menus)) {
        for (const entry of entries) {
          if (entry.command === \"gitLogViewer.showLog\") entry.command = \"gitLogViewerDev.showLog\";
        }
      }
      for (const kb of pkg.contributes.keybindings) {
        if (kb.command === \"gitLogViewer.showLog\") kb.command = \"gitLogViewerDev.showLog\";
      }
      require(\"fs\").writeFileSync(\"package.json\", JSON.stringify(pkg, null, 2));
    "

    npm install 2>&1 \
    && npm run build 2>&1 \
    && npx @vscode/vsce package --allow-missing-repository 2>&1

    mv package.json.bak package.json
'

# Fix ownership of build output
sudo chown -R "$(id -u):$(id -g)" "$SCRIPT_DIR"

VSIX=$(ls -t "$SCRIPT_DIR"/*.vsix 2>/dev/null | head -1)
if [ -z "$VSIX" ]; then
    echo "ERROR: No .vsix file found after build"
    exit 1
fi

echo "Installing $VSIX..."
code --install-extension "$VSIX" --force

echo "Done. Reload VS Code to activate the extension."
