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
#
# Skips the actual xdotool windowactivate (and its 0.4s settle sleep)
# when the window is ALREADY the active one, rather than reissuing it
# unconditionally on every call. This isn't just an optimization: every
# demo_mousemove/demo_click call goes through here, so a multi-step
# interaction (open a context menu, then click one of its items) was
# re-activating the window between the two steps even though it never lost
# focus. VS Code's webview content runs in an embedded Chromium context, and
# a raw window-activate request - even a redundant one - can still deliver a
# blur/focus event pair to it, which is enough to close an open JS-rendered
# dropdown before the next click lands. Reproduced reliably with the
# Branches submenu (open it, then click a branch - the submenu would
# intermittently already be closed by the time the click fired) and fixed by
# this guard; single "right-click then click one item" flows elsewhere in
# this script were never affected since the top-level context menu survives
# it, only a nested submenu didn't.
activate_demo_window() {
    DEMO_WIN=$(find_demo_window)
    local active
    active=$(xdotool getactivewindow 2>/dev/null || true)
    if [ "$active" != "$DEMO_WIN" ]; then
        xdotool windowactivate "$DEMO_WIN"
        sleep 0.4
        active=$(xdotool getactivewindow 2>/dev/null)
        if [ "$active" != "$DEMO_WIN" ]; then
            echo "FATAL: activation failed - active window ($active) != demo window ($DEMO_WIN)" >&2
            exit 1
        fi
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

# --- Branches submenu: driven via Chrome DevTools Protocol, not mouse clicks ---
#
# Every other menu interaction in this script is a plain xdotool click and
# it's never once been unreliable. This one submenu was: opening it makes a
# REAL async round-trip to the extension host (`vscode.postMessage({type:
# 'requestBranches'})`, which runs `git branch` and replies) before it has
# anything to render, so "how long until it's actually clickable" isn't a
# fixed UI-paint delay - it's an IPC + subprocess latency that visibly grew
# under the same CPU load ffmpeg's x11grab+libx264 encoding adds during real
# recording. No fixed sleep tried (1.8s, 3s, 5s, 6s) was reliable across a
# full recording, and a pixel-color verify-and-retry loop chased the right
# symptom but was itself fragile (a commit row's blue selection-highlight
# can read as "dark" at the same screen pixel the submenu's background
# would, depending on exactly which commit is selected).
#
# CDP sidesteps the whole class of problem: the webview is a normal
# `vscode-webview://` iframe target VS Code exposes for remote debugging
# (find_webview_cdp_ws() below), and Runtime.evaluate lets us call
# .click() on the exact DOM element directly - the same click handler a
# real click would fire, but requiring no X11 event delivery or rendering
# to have already happened, and letting us POLL REAL APPLICATION STATE
# (does #branches-submenu have children yet?) instead of guessing from
# either a timer or a screenshot.

# Finds the git-log-viewer webview's CDP debugger URL. Requires
# record-demo.sh to have launched `code` with --remote-debugging-port and
# --remote-allow-origins=* (see step 3). Retries for a few seconds before
# giving up - reproduced directly that this can transiently fail to find
# the target on a real recording run even though the exact same lookup
# succeeded reliably in isolated testing, most likely VS Code briefly not
# having (re-)registered the iframe as a debuggable target yet under the
# same CPU load that makes the Branches submenu itself slow to populate
# (see click_branches_submenu_item's comment). Under `set -euo pipefail`
# (record-demo.sh), a single failed lookup here without this retry doesn't
# just warn - it kills the whole script outright.
#
# Uncached (does the actual curl+python discovery every call) - use
# webview_eval() below for normal calls, which caches this in
# $CDP_WS_CACHE instead of rediscovering it every time. This exists as its
# own function so that cache-refresh path has something to call.
find_webview_cdp_ws() {
    local ws attempt
    for attempt in 1 2 3 4 5 6; do
        ws=$(curl -s "http://localhost:${CDP_PORT}/json/list" 2>/dev/null \
            | python3 -c "
import json, sys
targets = json.load(sys.stdin)
for t in targets:
    if t.get('type') == 'iframe' and 'andiapps.vscode-git-log-viewer' in t.get('url', ''):
        print(t['webSocketDebuggerUrl'])
        break
" 2>/dev/null)
        if [ -n "$ws" ]; then
            echo "$ws"
            return 0
        fi
        sleep 1
    done
    return 1
}

# Evaluates a JS expression inside the webview's own execution context and
# prints its JSON-encoded return value. The extension's actual content lives
# in a SECOND, nested iframe inside the one CDP exposes as a target (VS
# Code's own sandboxing wrapper) - same-origin (both are the same
# vscode-webview://<id> host), so reaching in via
# `document.querySelector('iframe').contentDocument` from the outer target
# works directly, no separate target/frameId needed for that inner one.
#
# Caches the discovered websocket URL in $CDP_WS_CACHE across calls rather
# than rediscovering it every time - discovering it is a curl + python
# process plus its own up-to-6-attempt retry loop, and callers like
# click_branches_submenu_item poll this in a loop of up to 20 iterations;
# without caching, ONE submenu interaction could spawn on the order of a
# hundred short-lived curl/python/websocket-connect processes in a row.
# Reproduced directly that a full recording run goes on to lose the
# webview's CDP target entirely (every subsequent lookup fails) and
# eventually the whole isolated VS Code window disappears partway through -
# most likely Electron's own CDP/debug-server implementation isn't built to
# absorb that many rapid connect/disconnect cycles. The Git Log panel this
# all targets is a single long-lived webview instance across the whole
# script (segments open/close *other* panels - Blame, View File Contents -
# but never this one after segment 1), so its target and websocket URL stay
# valid for the panel's whole lifetime; caching it is safe, not just faster.
# If the cached URL ever does go stale (the eval call itself fails, as
# opposed to succeeding but returning a JS-level "not found"), the cache is
# dropped and rediscovered exactly once before giving up - so a genuine
# target change is still handled, just not treated as the common case.
CDP_WS_CACHE=""
webview_eval() {
    local expr="$1" out
    if [ -z "$CDP_WS_CACHE" ]; then
        CDP_WS_CACHE=$(find_webview_cdp_ws) || {
            echo "  WARNING: couldn't find the webview's CDP target" >&2
            return 1
        }
    fi
    # Exposes both the inner document (d) and its own window (w) - callers
    # that construct objects to dispatch into that document (e.g. `new
    # Event(...)`) need w.Event, not the outer context's Event: they're
    # different realms, and a same-origin cross-realm object isn't always
    # accepted everywhere a native one is.
    if out=$(python3 "$SCRIPT_DIR/cdp_eval.py" "$CDP_WS_CACHE" "(function(){ const d=document.querySelector('iframe').contentDocument; const w=document.querySelector('iframe').contentWindow; $expr })()" 2>/dev/null); then
        echo "$out"
        return 0
    fi
    # Cached URL didn't work - drop it and try exactly once more with a
    # fresh discovery, in case the target genuinely changed.
    CDP_WS_CACHE=""
    CDP_WS_CACHE=$(find_webview_cdp_ws) || {
        echo "  WARNING: couldn't find the webview's CDP target" >&2
        return 1
    }
    python3 "$SCRIPT_DIR/cdp_eval.py" "$CDP_WS_CACHE" "(function(){ const d=document.querySelector('iframe').contentDocument; const w=document.querySelector('iframe').contentWindow; $expr })()"
}

# Sets one of the column filter inputs (the "Filter..." boxes in the
# commit/files table headers) directly via CDP, rather than clicking it
# with xdotool and typing into whatever has focus afterward.
#
# This replaced a click-then-xdotool-type approach after it corrupted the
# real demo repo's package.json on a real recording run: the filter input
# click didn't reliably transfer actual keyboard focus into that specific
# DOM element (a real click can land correctly as far as the *webview* is
# concerned - table row clicks elsewhere in this script, which only need
# the click's own event to land, were never affected - without that
# guaranteeing Electron's own focus model also moved OS-level keyboard
# input into that iframe/element), so the xdotool-typed characters that
# followed went to whatever else still held it - the package.json source
# editor, still "focused" there from earlier in the recording. That's a
# real file on disk silently getting corrupted with filter text, not just
# a cosmetic miss, so this needed a fix that doesn't depend on Electron's
# focus routing at all, not just a longer pause before typing.
#
# Setting `.value` and dispatching the same 'input' event the app's own
# listener reacts to (see webview/main.ts's filter-input wiring) reaches
# the exact same code path a real keystroke would, but entirely inside the
# webview's own JS - no OS-level focus transfer involved, so there's
# nothing for it to land on incorrectly. select() first would highlight
# any prior value if this becomes a "set to something after already having
# a value" call anywhere; not currently needed since every caller only
# ever sets an empty input or clears one, but cheap enough to leave in.
#
# $1: the column's data-col value (e.g. "authorName", "subject", "path")
# $2: the value to set (empty string clears it)
webview_set_filter() {
    local data_col="$1" value="$2"
    webview_eval "
        const input = d.querySelector('input[data-col=\"$data_col\"]');
        if (!input) return 'NOT_FOUND';
        input.focus();
        input.select();
        input.value = '$value';
        input.dispatchEvent(new w.Event('input', { bubbles: true }));
        return 'OK';
    " | grep -q '"OK"' || echo "  WARNING: no filter input found for data-col=\"$data_col\"" >&2
}

# Hovers a specific commit row's graph-column dot to trigger its tooltip.
# Combines a REAL xdotool mouse move to (x, y) - so the recorded video
# shows the cursor actually near the dot - with a CDP-dispatched genuine
# `mouseover` DOM event on that row's dot, since a synthetic xdotool pointer
# warp doesn't reliably fire the real mouseover event the tooltip's JS
# listener depends on (confirmed directly while testing it: CSS :hover
# state can update from a synthetic warp, but the DOM event itself doesn't
# reliably follow) - same reasoning as click_branches_submenu_item's CDP-
# driven click below, just for hover instead of click.
#
# $1 $2: window-relative x y for the real cursor move (cosmetic - see
#        above; doesn't need to land exactly on the dot for the hover
#        itself to register, since that part goes through CDP regardless).
# $3: 1-based row index (among currently rendered .data-row rows) whose
#     graph dot to hover.
#
# The dispatched event's own clientX/clientY - what main.ts's tooltip
# positioning actually reads, separate from $1/$2's real cursor move above -
# come from the dot's own getBoundingClientRect(), not $1/$2 themselves:
# $1/$2 are OUTER WINDOW coordinates (for xdotool), while clientX/clientY
# need to be WEBVIEW-relative (the iframe's own coordinate space) - the two
# only coincide by accident, if at all. A plain `new w.MouseEvent(...)`
# with neither set defaults both to 0, which doesn't error (nothing
# requires them) but silently pins the tooltip to the webview's top-left
# corner regardless of which row was hovered - caught by checking the
# tooltip's actual position live, not just that a tooltip showed up at all.
hover_graph_dot() {
    local x="$1" y="$2" row_index="$3"
    demo_mousemove "$x" "$y"
    webview_eval "
        const rows = d.querySelectorAll('#commit-tbody tr.data-row');
        const row = rows[$row_index - 1];
        if (!row) return 'NOT_FOUND';
        const dot = row.querySelector('td.col-graph svg circle');
        if (!dot) return 'NO_DOT';
        const rect = dot.getBoundingClientRect();
        dot.dispatchEvent(new w.MouseEvent('mouseover', {
            bubbles: true,
            clientX: rect.x + rect.width / 2,
            clientY: rect.y + rect.height / 2,
        }));
        return 'OK';
    " | grep -q '"OK"' || echo "  WARNING: no graph dot found at row $row_index to hover" >&2
}

# Dismisses the tooltip hover_graph_dot triggered, so it doesn't linger
# into whatever segment records next - the tooltip's hide is instant (no
# fade-out), so this just needs to run once, right before stop_capture.
# $1: same row index passed to the matching hover_graph_dot call.
unhover_graph_dot() {
    local row_index="$1"
    webview_eval "
        const rows = d.querySelectorAll('#commit-tbody tr.data-row');
        const row = rows[$row_index - 1];
        const dot = row ? row.querySelector('td.col-graph svg circle') : null;
        if (dot) dot.dispatchEvent(new w.MouseEvent('mouseout', { bubbles: true }));
        return 'OK';
    " >/dev/null || true
}

# Opens the Branches submenu (from an already-open, exactly-one-commit-
# selected commit-context-menu - the click that opens THAT is a normal
# xdotool right-click elsewhere in this script, unaffected by any of this)
# and clicks the item matching $1 (its exact visible text with any "✓ "
# prefix stripped, e.g. "All" or "feature/rate-limit-docs").
#
# Polls up to 10s for the submenu to actually populate (branchList !== null
# server round-trip - see the file comment above) before giving up, which
# only happens if requestBranches truly never gets a response; on any
# given attempt it's typically near-instant once the extension host
# replies. Each poll iteration is its own websocket connect/eval/disconnect
# (webview_eval doesn't hold a connection open between calls) - polling
# once a second rather than twice keeps this loop's worst case at 10 fresh
# connections instead of 20, on top of caching the target discovery itself
# (see webview_eval's comment on why that matters here specifically).
#
# $2 $3 (optional): window-relative x y to hover with a REAL xdotool
# mousemove just before the CDP click, purely so the item's :hover
# highlight is actually visible on screen for a moment first - the click
# itself still goes through element.click() via CDP regardless of whether
# this hover landed on the right spot or not, so an imprecise position here
# only costs a slightly-off highlight, never a wrong selection. Omit both
# to skip the hover (e.g. if the caller doesn't know/care where the item
# will render).
click_branches_submenu_item() {
    local item_text="$1" hover_x="${2:-}" hover_y="${3:-}" n attempt
    # Every webview_eval call below is deliberately `|| true`-guarded (or
    # otherwise exit-status-safe) rather than left bare - this runs under
    # record-demo.sh's `set -euo pipefail`, so an unguarded failed call
    # here wouldn't just warn, it would kill the entire recording outright.
    webview_eval "d.getElementById('ctx-branches').click(); return true;" >/dev/null || true
    n=0
    for attempt in $(seq 1 10); do
        n=$(webview_eval "return d.getElementById('branches-submenu').children.length;") || true
        [ "$n" -gt 0 ] 2>/dev/null && break
        sleep 1
    done
    if [ "${n:-0}" -eq 0 ] 2>/dev/null; then
        echo "  WARNING: Branches submenu never populated after 10s - proceeding anyway" >&2
        # Not `return 1`: this function is called as a bare statement under
        # record-demo.sh's `set -euo pipefail`, so a non-zero return here
        # wouldn't just skip the rest of this function - it would kill the
        # entire recording. Warning and moving on (skipping the item click
        # below, since there's nothing to click) is the intended behavior,
        # same as every other "proceeding anyway" warning in this script.
        return 0
    fi
    if [ -n "$hover_x" ] && [ -n "$hover_y" ]; then
        demo_mousemove "$hover_x" "$hover_y"
        sleep 0.7
    fi
    webview_eval "
        const items = Array.from(d.getElementById('branches-submenu').children);
        const target = items.find(el => el.textContent.replace('✓ ', '').trim() === '$item_text');
        if (!target) return 'NOT_FOUND';
        target.click();
        return 'OK';
    " | grep -q '"OK"' || echo "  WARNING: '$item_text' not found in the Branches submenu" >&2
    # Give the resulting re-render (and, for an individual branch, the
    # reloadCommits() it triggers) a moment to actually paint before the
    # next action - this part IS just a normal UI update, not an IPC
    # round-trip, so a short fixed wait is fine here.
    sleep 1.5
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
