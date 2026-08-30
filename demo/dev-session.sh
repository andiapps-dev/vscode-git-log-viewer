#!/bin/bash
# Launches the same isolated VS Code instance record-demo.sh uses (fresh
# vsix build, throwaway profile, demo repo, CDP debugging port) but does
# NOT record or clean up afterward - it leaves the window open so you can
# drive it yourself, by hand or via dev-act.sh, instead of waiting through
# a full ./record-demo.sh run to see one thing.
#
# Usage: ./dev-session.sh [path-to-demo-repo]
# Defaults to ~/Downloads/demo-express, same as record-demo.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEMO_REPO="${1:-$HOME/Downloads/demo-express}"
WORK="$(mktemp -d)"
echo "WORK=$WORK"

source "$SCRIPT_DIR/winsafe.sh"

WIN_W=1900
WIN_H=1140
CDP_PORT=9333

echo "=== 0. Cleaning $DEMO_REPO's working tree ==="
(
    cd "$DEMO_REPO"
    git revert --abort 2>/dev/null || true
    git merge --abort 2>/dev/null || true
    git rebase --abort 2>/dev/null || true
    git cherry-pick --abort 2>/dev/null || true
    git checkout master 2>/dev/null || true
    git checkout -- .
    git clean -fd
    # See setup-demo-repo.sh for why this is a hardcoded literal SHA and not
    # origin/master: $DEMO_REPO has no 'origin' remote by design.
    git reset --hard a3714473feb3d2908add734d340e7755fd85e0a3 2>/dev/null || true
)

echo "=== 1. Building fresh vsix ==="
rm -f "$EXT_DIR"/*.vsix
sudo docker run --rm -v "$EXT_DIR:/workspace" -w /workspace node:20-slim sh -c \
    "npm install >/dev/null 2>&1 && npm run build >/dev/null 2>&1 && npx @vscode/vsce package --allow-missing-repository -o /workspace/demo-build.vsix" \
    2>&1 | tail -5
sudo chown -R "$(id -u):$(id -g)" "$EXT_DIR"
mv "$EXT_DIR/demo-build.vsix" "$WORK/demo-build.vsix"

echo "=== 2. Setting up isolated profile ==="
mkdir -p "$WORK/profile-user-data/User" "$WORK/profile-extensions"
cp "$SCRIPT_DIR/isolated-settings.json" "$WORK/profile-user-data/User/settings.json"
code --user-data-dir="$WORK/profile-user-data" \
     --extensions-dir="$WORK/profile-extensions" \
     --install-extension "$WORK/demo-build.vsix" >/dev/null 2>&1

echo "=== 3. Launching isolated instance ==="
nohup code --user-data-dir="$WORK/profile-user-data" \
     --extensions-dir="$WORK/profile-extensions" \
     --new-window \
     --disable-workspace-trust \
     --remote-debugging-port="$CDP_PORT" \
     --remote-allow-origins=* \
     "$DEMO_REPO" \
     > "$WORK/code.log" 2>&1 &
disown
sleep 7

activate_demo_window
wmctrl -ir "$(printf '0x%08x' "$DEMO_WIN")" -b remove,maximized_vert,maximized_horz
xdotool windowsize "$DEMO_WIN" "$WIN_W" "$WIN_H"
xdotool windowmove "$DEMO_WIN" 60 60
sleep 0.5
activate_demo_window
eval "$(xdotool getwindowgeometry --shell "$DEMO_WIN")"
echo "Window geometry: ${WIDTH}x${HEIGHT}+${X},${Y}"

echo "=== 3b. Dismissing first-run wizard ==="
demo_mousemove 1650 173
demo_click 1
sleep 1.5
demo_mousemove 1866 73
demo_click 1
sleep 1

cat <<EOF

=== READY ===
WORK=$WORK
DEMO_REPO=$DEMO_REPO
CDP_PORT=$CDP_PORT (curl http://localhost:$CDP_PORT/json/list to see live webview targets)

The window is left open - drive it by hand with your real mouse/keyboard
(it's a real, normal window, just titled with a DEMO-RECORDING-MARKER
suffix so scripts can find it unambiguously), or with:
  ./dev-act.sh <action> [args...]

See dev-act.sh and README.md's "Manual step-by-step troubleshooting"
section for the full rundown.

Clean up when done:
  xdotool search --name DEMO-RECORDING-MARKER | xargs -r xdotool windowkill
  cd $DEMO_REPO && git checkout -- . && git clean -fd
  rm -rf $WORK
EOF
