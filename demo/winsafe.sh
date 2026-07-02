#!/bin/bash
# Strict window targeting helper for demo automation.
#
# Every function ABORTS (not just warns) if the window we're about to send
# input to isn't unambiguously our isolated demo instance. This matters
# because a stale/closed window can cause xdotool to silently deliver input
# to whatever real window happens to be on top instead - including your
# actual, unrelated VS Code windows. We identify our window purely by a
# unique window.title marker (see settings.json), never by title
# substrings that could also match a real window, and re-verify it
# immediately before every single input event rather than once at launch.

MARKER="DEMO-RECORDING-MARKER"

# Finds exactly one window matching our unique title marker. Aborts if zero
# or more than one match (ambiguous = unsafe).
find_demo_window() {
    local matches
    matches=$(xdotool search --name "$MARKER" 2>/dev/null)
    local count
    count=$(echo -n "$matches" | grep -c . || true)
    if [ -z "$matches" ] || [ "$count" -eq 0 ]; then
        echo "FATAL: no window found matching marker '$MARKER'" >&2
        exit 1
    fi
    if [ "$count" -gt 1 ]; then
        echo "FATAL: $count windows match marker '$MARKER' (ambiguous):" >&2
        echo "$matches" >&2
        exit 1
    fi
    echo "$matches"
}

# Activates the demo window and verifies it is both the active window AND
# still carries the marker in its title, immediately before returning.
# Sets global DEMO_WIN. Call this before every batch of input events.
activate_demo_window() {
    DEMO_WIN=$(find_demo_window)
    xdotool windowactivate "$DEMO_WIN"
    sleep 0.4
    local active
    active=$(xdotool getactivewindow 2>/dev/null)
    if [ "$active" != "$DEMO_WIN" ]; then
        echo "FATAL: activation failed - active window ($active) != demo window ($DEMO_WIN)" >&2
        exit 1
    fi
    local title
    title=$(xdotool getwindowname "$DEMO_WIN" 2>/dev/null)
    case "$title" in
        *"$MARKER"*) ;;
        *)
            echo "FATAL: active window title lost marker: '$title'" >&2
            exit 1
            ;;
    esac
}

# Wrappers: every action re-verifies the demo window immediately before
# sending input. Slower than caching the window id, but that's the point.
demo_key() { activate_demo_window; xdotool key --window "$DEMO_WIN" "$@"; }
demo_type() { activate_demo_window; xdotool type --window "$DEMO_WIN" --delay 30 "$@"; }
demo_mousemove() { activate_demo_window; xdotool mousemove --window "$DEMO_WIN" "$@"; }
demo_click() { activate_demo_window; xdotool click "$@"; }
demo_scroll() { activate_demo_window; xdotool mousemove --window "$DEMO_WIN" "$1" "$2"; for _ in $(seq 1 "$3"); do xdotool click "$4"; done; }

# Ctrl+click at window-relative coordinates (x y), e.g. for multi-selecting
# commit rows. Holds Ctrl at the X server level for the duration of the
# click, independent of window focus.
demo_ctrlclick() {
    local x="$1" y="$2"
    activate_demo_window
    xdotool keydown ctrl
    xdotool mousemove --window "$DEMO_WIN" "$x" "$y"
    xdotool click 1
    xdotool keyup ctrl
}

# Closes the tab at window-relative (tab_x, 74) via Ctrl+W. Clicking the tab
# label first (rather than sending Ctrl+W directly) matters: after clicking
# a menu item that opens one of our webview panels, keyboard focus is left
# inside that webview's iframe rather than the editor-group chrome, and
# Ctrl+W silently does nothing in that state - reproduced reliably with 2+
# of our webview panels open at once. Clicking the tab re-establishes
# editor-group focus so Ctrl+W actually reaches it.
demo_closetab() {
    local tab_x="$1"
    demo_mousemove "$tab_x" 74
    demo_click 1
    sleep 0.4
    demo_key ctrl+w
}
