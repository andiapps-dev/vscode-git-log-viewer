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
    cp package-lock.json package-lock.json.bak

    node -e "
      const pkg = JSON.parse(require(\"fs\").readFileSync(\"package.json\",\"utf8\"));
      pkg.name = \"git-log-viewer-dev\";
      pkg.displayName = \"Git Log Viewer (Dev)\";
      // Prefix match (not a hardcoded gitLogViewer.showLog string) so any
      // future gitLogViewer.* command is renamed automatically instead of
      // silently colliding with the real extension when both are installed
      // side by side - this is what broke for gitLogViewer.showLineHistory.
      const rename = (id) => id.startsWith(\"gitLogViewer.\") ? id.replace(/^gitLogViewer\\./, \"gitLogViewerDev.\") : id;
      for (const cmd of pkg.contributes.commands) {
        if (cmd.command.startsWith(\"gitLogViewer.\")) {
          cmd.command = rename(cmd.command);
          cmd.title = cmd.title + \" (Dev)\";
        }
      }
      for (const entries of Object.values(pkg.contributes.menus)) {
        for (const entry of entries) {
          entry.command = rename(entry.command);
        }
      }
      for (const kb of pkg.contributes.keybindings) {
        kb.command = rename(kb.command);
      }
      require(\"fs\").writeFileSync(\"package.json\", JSON.stringify(pkg, null, 2));
    "

    npm install 2>&1 \
    && npm run build 2>&1 \
    && npx @vscode/vsce package --allow-missing-repository 2>&1

    mv package.json.bak package.json
    mv package-lock.json.bak package-lock.json
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
