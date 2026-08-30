#!/bin/bash
# Fires one xdotool action (or CDP call) at the dev-session.sh window and
# exits - a single Bash tool call doesn't share shell state with the next
# one, so this exists to make each action independently invokable instead
# of needing a long-running interactive shell.
#
# Usage: ./dev-act.sh <action> [args...]
#
# Actions:
#   move X Y            - move the mouse to window-relative (X, Y)
#   click [N]            - click at the CURRENT mouse position (button N, default 1)
#   rightclick X Y       - move to (X, Y) then right-click
#   key KEYS...           - send a key/chord, e.g. `key ctrl+alt+bracketright`
#   type TEXT             - type literal text (e.g. into a Quick Open box or an input prompt)
#   ctrlclick X Y         - ctrl+click at window-relative (X, Y) (multi-select)
#   closetab X             - close the tab under window-relative X (see demo_closetab)
#   screenshot PATH        - save a PNG of the current window state to PATH
#   webview_eval JS         - run JS inside the Git Log webview via CDP, print its return value
#   webview_set_filter COL VALUE - set a column filter input's value via CDP
#   branches_click TEXT [X Y]     - click a Branches submenu item via CDP (optional real-mouse hover first)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/winsafe.sh"
CDP_PORT="${CDP_PORT:-9333}"

cmd="$1"; shift || true
case "$cmd" in
    move) demo_mousemove "$1" "$2" ;;
    click) demo_click "${1:-1}" ;;
    rightclick) demo_mousemove "$1" "$2"; demo_click 3 ;;
    key) demo_key "$@" ;;
    type) demo_type "$1" ;;
    ctrlclick) demo_ctrlclick "$1" "$2" ;;
    closetab) demo_closetab "$1" ;;
    screenshot) activate_demo_window; import -window "$DEMO_WIN" "$1" ;;
    webview_eval) webview_eval "$1" ;;
    webview_set_filter) webview_set_filter "$1" "$2" ;;
    branches_click) click_branches_submenu_item "$1" "${2:-}" "${3:-}" ;;
    *) echo "unknown action: $cmd" >&2; exit 1 ;;
esac
