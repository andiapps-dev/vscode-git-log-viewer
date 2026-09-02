#!/bin/bash
# Records a short animated-GIF demo of Git Log Viewer's features, driven by
# xdotool against a real, isolated VS Code instance (not a mock/screenshot
# mockup). Re-run this after UI changes instead of re-recording by hand.
#
# Every feature this demos is read-only against the target repo - browsing,
# filtering, comparing, viewing content at a revision - nothing here writes
# a commit, branch, or tag. That's deliberate: this extension is a
# *viewer*, scoped entirely to viewing history, not changing it.
#
# What it does, in order:
#   1. Builds a fresh vsix of the extension from the current source.
#   2. Installs it into a throwaway VS Code profile (--user-data-dir /
#      --extensions-dir), isolated from your real profile/extensions/theme.
#   3. Launches that profile against the demo repo, sized to a fixed
#      geometry, identified unambiguously via a unique window.title marker
#      (see winsafe.sh - never targets a window by guesswork).
#   4. Records the demo as a series of clips: a title card explaining what's
#      about to happen, then the actual xdotool-driven action, for each
#      feature - concatenated and converted to a palette-optimized GIF. Two
#      segments (Compare with Working Tree, Source Control view) make a
#      throwaway uncommitted edit right before they run and revert it right
#      after (or on exit no matter how the script ends) rather than leaving
#      it in place for the whole recording, so it doesn't linger as an
#      unrelated diff the rest of the recording has to ignore.
#
# Requires: xdotool, ffmpeg, wmctrl, fontconfig, curl, python3 + the
# websocket-client pip package, docker, code (VS Code CLI). All but the
# last two are auto-installed if missing (see check_prereqs); docker and
# the VS Code CLI are left alone since installing those is a bigger, more
# invasive decision than this script should make on its own.
#
# python3 + websocket-client drive the one part of this script that talks
# to the webview via Chrome DevTools Protocol instead of simulated mouse
# clicks (the Branches submenu - see winsafe.sh's click_branches_submenu_item
# for why) - the isolated instance is launched with --remote-debugging-port
# open for exactly this.
#
# Usage: ./record-demo.sh [--coverage] [path-to-demo-repo] [target-file-in-repo]
# Defaults to ~/Downloads/demo-express and package.json.
#
# --coverage: also capture V8 code coverage of the extension-host process
# (extension.ts, gitLogPanel.ts, gitService.ts, messageHandler.ts,
# diffDocProvider.ts - everything that runs in dist/extension.js) while this
# same click-through session plays out, and write a report to
# demo/output/extension-coverage/. This does NOT cover webview/main.ts - the
# webview runs in a separate browser context that NODE_V8_COVERAGE can't see
# (and it's already covered by the unit test suite). There are no
# assertions here; it only answers "did this code path actually run",
# which is exactly the class of bug (dead/unwired code, stale dist/) that
# mocked unit tests can't catch.

set -euo pipefail

COVERAGE=0
ARGS=()
for arg in "$@"; do
    case "$arg" in
        --coverage) COVERAGE=1 ;;
        *) ARGS+=("$arg") ;;
    esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

# Installs the lightweight CLI tools this script drives (xdotool, ffmpeg,
# wmctrl, fontconfig for fc-match) if they're missing. Only targets apt
# (Debian/Ubuntu) since that's what build.sh/install.sh already assume via
# their node:20-slim Docker base. Fails loudly with guidance for the two
# heavier dependencies (docker, the VS Code CLI) rather than attempting to
# install those itself.
check_prereqs() {
    local apt_pkgs=()
    command -v xdotool >/dev/null 2>&1 || apt_pkgs+=(xdotool)
    command -v ffmpeg >/dev/null 2>&1 || apt_pkgs+=(ffmpeg)
    command -v wmctrl >/dev/null 2>&1 || apt_pkgs+=(wmctrl)
    command -v fc-match >/dev/null 2>&1 || apt_pkgs+=(fontconfig)
    command -v curl >/dev/null 2>&1 || apt_pkgs+=(curl)
    command -v python3 >/dev/null 2>&1 || apt_pkgs+=(python3)

    if [ "${#apt_pkgs[@]}" -gt 0 ]; then
        if ! command -v apt-get >/dev/null 2>&1; then
            echo "FATAL: missing tools (${apt_pkgs[*]}) and apt-get isn't available to install them" >&2
            exit 1
        fi
        echo "Installing missing prerequisites: ${apt_pkgs[*]}"
        sudo apt-get update -qq
        sudo apt-get install -y "${apt_pkgs[@]}"
    fi

    if ! python3 -c "import websocket" >/dev/null 2>&1; then
        echo "Installing missing prerequisite: websocket-client (pip)"
        pip3 install --quiet --break-system-packages websocket-client
    fi

    if ! command -v docker >/dev/null 2>&1; then
        echo "FATAL: docker is required to build the extension (matches build.sh/install.sh)." >&2
        echo "Install it first: https://docs.docker.com/engine/install/" >&2
        exit 1
    fi

    if ! command -v code >/dev/null 2>&1; then
        echo "FATAL: the 'code' CLI (VS Code) is required but isn't on PATH." >&2
        exit 1
    fi
}
check_prereqs

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEMO_REPO="${1:-$HOME/Downloads/demo-express}"
TARGET_FILE="${2:-package.json}"
# The commit master gets reset to at the start (and end) of every run - see
# setup-demo-repo.sh, which creates $DEMO_REPO pinned to exactly this and
# removes its 'origin' remote so it can't drift out from under this script.
# Deliberately NOT `origin/master`: that remote-tracking ref only reflects
# reality if something fetches it, and depending on that ref instead of a
# literal SHA here is exactly the implicit "just don't fetch this repo"
# assumption setup-demo-repo.sh's whole point is to not rely on.
PINNED_DEMO_SHA="a3714473feb3d2908add734d340e7755fd85e0a3"
WORK="$(mktemp -d)"
OUT_DIR="$SCRIPT_DIR/output"
mkdir -p "$OUT_DIR"
COVERAGE_DIR="$WORK/v8-coverage"
COVERAGE_OUT_DIR="$SCRIPT_DIR/output/extension-coverage"
[ "$COVERAGE" -eq 1 ] && mkdir -p "$COVERAGE_DIR"

source "$SCRIPT_DIR/winsafe.sh"

# Used by click_branches_submenu_item (winsafe.sh) to drive the Branches
# submenu via Chrome DevTools Protocol instead of simulated mouse clicks.
# Not 9222 (Chrome/Electron's conventional default) specifically to avoid
# colliding with any other CDP-debugged instance that might already be
# running on this machine for unrelated reasons.
CDP_PORT=9333

WIN_W=1900
WIN_H=1140
CAPTURE_FPS=8
GIF_FPS=8
GIF_WIDTH=760
GIF_MAX_COLORS=160
FONT="$(fc-match -f '%{file}\n' 'DejaVu Sans:bold' 2>/dev/null || echo /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf)"
DEMO_PID=""
CLIPS=()

cleanup() {
    echo "Cleaning up..."
    if [ -n "$DEMO_PID" ] && kill -0 "$DEMO_PID" 2>/dev/null; then
        kill "$DEMO_PID" 2>/dev/null || true
    fi
    # Belt-and-suspenders: also close by window marker in case the PID
    # we captured wasn't the right process (code CLI forks).
    for w in $(xdotool search --name "DEMO-RECORDING-MARKER" 2>/dev/null || true); do
        xdotool windowkill "$w" 2>/dev/null || true
    done
    if [ -f "$DEMO_REPO/$TARGET_FILE" ] && [ -n "${MADE_EDIT:-}" ]; then
        (cd "$DEMO_REPO" && git checkout -- "$TARGET_FILE") || true
        echo "Reverted throwaway edit to $TARGET_FILE in $DEMO_REPO"
    fi
    # Belt-and-suspenders for the same reset step 0 does at the start of the
    # *next* run: also do it here, so a run that gets interrupted (Ctrl+C,
    # crash) mid-segment doesn't leave $DEMO_REPO's working tree dirty in
    # the meantime. Every segment is read-only against git history now (the
    # only mutation anywhere in this script is the throwaway uncommitted
    # edit reverted just above), so there's no branch/tag/commit state left
    # to clean up here beyond that.
    if [ -d "$DEMO_REPO/.git" ]; then
        (cd "$DEMO_REPO" && git checkout master 2>/dev/null || true)
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT

if [ ! -d "$DEMO_REPO/.git" ]; then
    echo "FATAL: $DEMO_REPO is not a git repo" >&2
    echo "Run setup-demo-repo.sh to create it: $SCRIPT_DIR/setup-demo-repo.sh $DEMO_REPO" >&2
    exit 1
fi
if ! git -C "$DEMO_REPO" cat-file -e "$PINNED_DEMO_SHA" 2>/dev/null; then
    echo "FATAL: $DEMO_REPO doesn't contain \$PINNED_DEMO_SHA ($PINNED_DEMO_SHA) - it's" >&2
    echo "either the wrong repo, or was cloned independently instead of via" >&2
    echo "setup-demo-repo.sh. Recreate it: $SCRIPT_DIR/setup-demo-repo.sh $DEMO_REPO" >&2
    exit 1
fi
for b in feature/rate-limit-docs feature/caching-docs feature/websocket-docs feature/security-headers-docs; do
    if ! git -C "$DEMO_REPO" rev-parse --verify -q "$b" >/dev/null 2>&1; then
        echo "FATAL: $DEMO_REPO has no $b branch (needed by the Branches-filter" >&2
        echo "segment). Recreate it: $SCRIPT_DIR/setup-demo-repo.sh $DEMO_REPO" >&2
        exit 1
    fi
done

# A previous run that got killed mid-script (Ctrl+C, crash, ...) can leave
# $DEMO_REPO stuck mid-operation - e.g. the throwaway edit's cleanup trap
# above does a plain `git checkout -- file`, which is a no-op if the repo is
# actually stuck in the middle of a revert/merge/rebase, not just dirty.
# Clean that up unconditionally before touching anything else, but only
# reset the *working tree state* here - never fetch/pull new history, ever,
# anywhere in this script: row_y() and a long list of hardcoded SHA
# comments throughout are calibrated against $DEMO_REPO's history looking
# exactly like it does at $PINNED_DEMO_SHA. See setup-demo-repo.sh, which
# creates $DEMO_REPO with no 'origin' remote configured specifically so a
# fetch/pull can't happen here even by accident. Every segment in this
# script is read-only against git history (the only mutation anywhere here
# is a throwaway uncommitted edit two segments make and immediately revert
# - see MADE_EDIT), so the hard reset below is a safety net against a
# broken prior run, not something a normal run needs.
echo "=== 0. Ensuring $DEMO_REPO starts from a clean working tree ==="
(
    cd "$DEMO_REPO"
    git revert --abort 2>/dev/null || true
    git merge --abort 2>/dev/null || true
    git rebase --abort 2>/dev/null || true
    git cherry-pick --abort 2>/dev/null || true
    git checkout master
    git checkout -- .
    git clean -fd
    git reset --hard "$PINNED_DEMO_SHA"
)

# Renders a full-frame title card (plain text on a solid background) as its
# own clip, held for $2 seconds. Used to give viewers context on what
# feature is about to be demoed before the corresponding action segment.
add_title() {
    local text="$1" dur="${2:-1.6}"
    local out="$WORK/clip_$(printf '%02d' ${#CLIPS[@]}).mp4"
    # Long captions overflow the frame at fontsize 54 (drawtext centers via
    # (w-text_w)/2, which goes negative and clips both edges once text_w
    # exceeds the canvas). Scale down past ~45 chars rather than relying on
    # every caller to eyeball the width.
    local fsize=54
    [ "${#text}" -gt 45 ] && fsize=38
    ffmpeg -y -f lavfi -i "color=c=0x1e1e2e:s=${WIDTH}x${HEIGHT}:d=${dur}:r=${CAPTURE_FPS}" \
        -vf "drawtext=fontfile=${FONT}:text='${text}':fontcolor=white:fontsize=${fsize}:x=(w-text_w)/2:y=(h-text_h)/2" \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$out" > "$WORK/title.log" 2>&1
    CLIPS+=("$out")
}

# Starts recording the live window into its own clip. Pair with stop_capture.
start_capture() {
    local out="$WORK/clip_$(printf '%02d' ${#CLIPS[@]}).mp4"
    CLIPS+=("$out")
    ffmpeg -y -f x11grab -framerate "$CAPTURE_FPS" -video_size "${WIDTH}x${HEIGHT}" -i "$DISPLAY+${X},${Y}" \
        -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$out" \
        > "$WORK/capture.log" 2>&1 &
    CAPTURE_PID=$!
    sleep 1
}

stop_capture() {
    kill -INT "$CAPTURE_PID"
    wait "$CAPTURE_PID" 2>/dev/null || true
    sleep 0.3
}

# Quits the isolated instance gracefully (Ctrl+Q) rather than killing it, so
# the extension host process exits normally and Node actually flushes its
# NODE_V8_COVERAGE data - a killed process may not. Waits up to 15s for it
# to exit on its own; the usual cleanup() trap remains as the fallback if it
# doesn't. Then renders a report from whatever coverage-*.json files landed
# in COVERAGE_DIR.
finalize_coverage() {
    echo "=== Coverage: quitting isolated instance to flush V8 coverage ==="
    activate_demo_window
    # The preceding segment can leave keyboard focus inside one of our
    # webview panels (an iframe), which silently swallows global keybindings
    # sent via xdotool key - see demo_closetab's comment on the same issue
    # with Ctrl+W. Click the Explorer activity-bar icon first to move focus
    # back to native UI chrome before sending Ctrl+Q.
    xdotool mousemove --window "$DEMO_WIN" 36 83
    xdotool click 1
    sleep 0.5
    activate_demo_window
    xdotool key --window "$DEMO_WIN" ctrl+q

    # Poll the window marker, not $DEMO_PID - the code CLI forks (see
    # cleanup()'s own comment on this), so the PID we captured at launch may
    # already be gone long before the real window/extension host actually
    # exits.
    local waited=0
    while [ -n "$(xdotool search --name "$MARKER" 2>/dev/null || true)" ] && [ "$waited" -lt 15 ]; do
        sleep 1
        waited=$((waited + 1))
    done
    if [ -n "$(xdotool search --name "$MARKER" 2>/dev/null || true)" ]; then
        echo "WARNING: instance window still present after 15s; coverage may be incomplete or missing" >&2
    fi
    # Give the extension host process a moment to actually exit and flush
    # coverage to disk after the window itself disappears.
    sleep 2

    if ! ls "$COVERAGE_DIR"/coverage-*.json >/dev/null 2>&1; then
        echo "WARNING: no V8 coverage files were written to $COVERAGE_DIR - skipping report" >&2
        return
    fi

    # VS Code runs the extension from its EXTRACTED vsix copy inside the
    # throwaway profile's --extensions-dir, not from $EXT_DIR/dist directly -
    # the coverage JSON records that absolute runtime path, so --include has
    # to target it exactly rather than assume it matches $EXT_DIR/dist/extension.js.
    local installed_js
    installed_js="$(find "$WORK/profile-extensions" -path '*/dist/extension.js' -print -quit 2>/dev/null || true)"
    if [ -z "$installed_js" ]; then
        echo "WARNING: couldn't find the installed extension.js under $WORK/profile-extensions - skipping report" >&2
        return
    fi

    echo "=== Coverage: generating report ==="
    mkdir -p "$COVERAGE_OUT_DIR"
    local installed_dir
    installed_dir="$(dirname "$installed_js")"
    # c8 (via test-exclude/minimatch) resolves --include relative to cwd, and
    # doesn't cope with the resulting "../../../tmp/..." when cwd (EXT_DIR)
    # and the coverage target (under WORK, a separate /tmp dir) share no
    # common ancestor short of "/" - it silently matches nothing. Running
    # with cwd set to the target file's own directory and matching by bare
    # filename sidesteps that entirely. Mounted at their real host paths
    # (not remapped to /workspace like the build step above) so those
    # absolute paths resolve identically here to how they did at capture
    # time. c8 is invoked by its installed path, not `npx c8`, because npx's
    # lookup wouldn't find it from a cwd with no node_modules ancestor of
    # its own (WORK) and would otherwise silently fetch it from the
    # registry instead of using the pinned devDependency version.
    sudo docker run --rm \
        -v "$COVERAGE_DIR:$COVERAGE_DIR" \
        -v "$WORK:$WORK" \
        -v "$EXT_DIR:$EXT_DIR" \
        node:20-slim sh -c \
        "cd '$EXT_DIR' && npm install --silent 2>&1 | tail -3 && cd '$installed_dir' && '$EXT_DIR/node_modules/.bin/c8' report --temp-directory='$COVERAGE_DIR' --reporter=text --reporter=lcov --report-dir='$COVERAGE_OUT_DIR' --include=extension.js" \
        2>&1 | tail -40
    sudo chown -R "$(id -u):$(id -g)" "$COVERAGE_OUT_DIR"
    echo "Coverage report: $COVERAGE_OUT_DIR/lcov-report/index.html and $COVERAGE_OUT_DIR/lcov.info"
}

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
# NODE_V8_COVERAGE is honored by any Node process that has it set at start,
# including the extension host VS Code forks as a child process - Node
# writes one coverage-*.json per isolate to this directory automatically on
# clean process exit, no code changes needed in the extension itself.
if [ "$COVERAGE" -eq 1 ]; then
    export NODE_V8_COVERAGE="$COVERAGE_DIR"
fi
# --remote-debugging-port / --remote-allow-origins: exposes the webview via
# CDP for click_branches_submenu_item (winsafe.sh) - see CDP_PORT's comment
# above. --remote-allow-origins=* is required as of recent Electron/Chromium
# versions, which otherwise reject CDP websocket connections whose Origin
# header doesn't match (a curl-based JSON discovery request has none, so
# it's rejected outright without this).
nohup code --user-data-dir="$WORK/profile-user-data" \
     --extensions-dir="$WORK/profile-extensions" \
     --new-window \
     --disable-workspace-trust \
     --remote-debugging-port="$CDP_PORT" \
     --remote-allow-origins=* \
     "$DEMO_REPO" \
     > "$WORK/code.log" 2>&1 &
DEMO_PID=$!
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

# A brand-new profile shows a first-run "Welcome to VS Code / Sign in to
# use GitHub Copilot" modal wizard (multiple steps). Dismiss it via its X
# button (works regardless of which step it's on) rather than clicking
# through each step's specific button.
echo "=== 3b. Dismissing first-run wizard ==="
demo_mousemove 1650 173
demo_click 1
sleep 1.5
# Close the Chat panel that opens by default alongside it.
demo_mousemove 1866 73
demo_click 1
sleep 1

echo "=== 5. Recording segments ==="

# --- Segment 1: right-click a file in the Explorer, or press the shortcut ---
# The Explorer entry point (right-click the file where you're already
# browsing, no need to have it open first) is the primary, most-discoverable
# way into this extension - demoed here instead of the editor-body context
# menu, which requires the file to already be open and is a secondary path
# to the same place.
add_title "Right-click a file in the Explorer, or press the shortcut"
start_capture
demo_key ctrl+p
sleep 0.6
demo_type "$TARGET_FILE"
sleep 0.6
demo_key Return
sleep 1.5
# y=563 is package.json in demo-express's Explorer (flat top-level file
# list, no scrolling needed - see segment 7's note on this repo's Explorer
# below).
demo_mousemove 180 563
demo_click 3
sleep 1.2
# y=1116 is "Show Git Log" - the last entry, native VS Code's own Explorer
# context menu contributed via package.json's `explorer/context` menu
# point, not one of ours. Pause on it before clicking so the hover
# highlight is actually visible on screen, not just the menu opening and a
# result appearing.
demo_mousemove 290 1116
sleep 0.7
demo_click 1
sleep 2
# Close it, then show the keyboard shortcut reaches the exact same place -
# ends on the same 2-tab layout (package.json, Git Log: package.json) the
# rest of this script assumes.
demo_closetab 900
sleep 0.7
demo_key ctrl+alt+bracketright
sleep 2
stop_capture

# Commit row Y coordinates in the log table: row 1 starts at y=192, each
# subsequent row is ~30px down. These specific rows (4 and 9) were chosen
# because, for package.json in the demo-express repo, they land on commits
# with a richer file list / distinct author - useful for later segments.
# If TARGET_FILE changes, the rows still exist at these Y positions (the
# table always has >9 rows), just with different commit content.
row_y() { echo $((192 + (($1 - 1) * 30))); }

# --- Segment 2: browse commit history, a few different commits ---
add_title "Browse the commit history"
start_capture
demo_mousemove 700 "$(row_y 1)"
demo_click 1
sleep 1.3
demo_mousemove 700 "$(row_y 4)"
demo_click 1
sleep 1.3
demo_mousemove 700 "$(row_y 9)"
demo_click 1
sleep 1.3
stop_capture

# --- Segment 2b: the commit graph shows branch history at a glance, with
# details on hover ---
# hover_graph_dot drives the actual hover through CDP, not the real cursor
# alone - see its comment in winsafe.sh for why a synthetic xdotool mouse
# move doesn't reliably fire the real mouseover event the tooltip's JS
# listener depends on. x=560 here just puts the visible cursor roughly over
# the commit list's graph column (well to the left of the SHA-1 column) for
# the recording itself.
add_title "See branch history at a glance, with details on hover"
start_capture
hover_graph_dot 560 "$(row_y 1)" 1
sleep 2.2
unhover_graph_dot 1
sleep 0.3
stop_capture

# --- Segment 3: compare two selected revisions ---
add_title "Compare two selected revisions"
start_capture
demo_mousemove 700 "$(row_y 1)"
demo_click 1
sleep 0.5
demo_ctrlclick 700 "$(row_y 9)"
sleep 0.6
demo_mousemove 700 "$(row_y 9)"
demo_click 3
sleep 1.2
demo_mousemove 857 461
sleep 0.7
demo_click 1
sleep 2.5
demo_key ctrl+w
sleep 0.7
stop_capture

# --- Segment 4: diff viewer ---
add_title "Double-click a file to diff it against the previous revision"
start_capture
demo_mousemove 700 888
demo_click --repeat 2 1
sleep 2.2
demo_key ctrl+w
sleep 0.7
stop_capture

# --- Segment 4b: view a file's full contents at a given revision ---
# Re-select row 1 first rather than trust whatever segment 3 left selected -
# this needs a commit whose only changed file is TARGET_FILE itself
# (Modified, not Added/Deleted) so the file context menu has its full 8-item
# layout (in particular "View File Contents", which Deleted files don't
# show - there's nothing to view post-deletion - and whose presence/absence
# shifts every item below it by one row).
add_title "View a file's full contents at any revision"
start_capture
demo_mousemove 700 "$(row_y 1)"
demo_click 1
sleep 1
demo_mousemove 700 888
demo_click 3
sleep 1.2
demo_mousemove 800 886
sleep 0.7
demo_click 1
sleep 2
# 2 tabs were open before this one (package.json, Git Log: package.json),
# so the new read-only revision tab is the 3rd, landing around x=1150.
demo_closetab 1150
sleep 0.7
stop_capture

# --- Segment 5: compare with working tree ---
# The throwaway uncommitted edit only exists for this one segment - made
# right before it and reverted right after, rather than left in place for
# the whole recording, so it doesn't show up as an unrelated diff in any
# later segment that happens to look at this file's status.
echo "=== Creating throwaway uncommitted change for Working Tree demo ==="
(cd "$DEMO_REPO" && sed -i '2i\  "//demo-uncommitted-change": true,' "$TARGET_FILE")
MADE_EDIT=1
add_title "Compare a revision with your Working Tree"
start_capture
demo_mousemove 700 888
demo_click 3
sleep 1.2
# y=844 is "Compare with Working Tree" in the 8-item file context menu
# (Show File Log/Compare with Previous/Compare with Working Tree/View File
# Contents/Blame/Copy Path/Folder View/Clear Filters - measured directly via
# screenshot against this exact row_y(1) commit, whose only file is
# TARGET_FILE itself).
demo_mousemove 856 844
sleep 0.7
demo_click 1
sleep 2.2
demo_key ctrl+w
sleep 0.7
stop_capture
echo "=== Reverting throwaway edit (only needed for the previous segment) ==="
(cd "$DEMO_REPO" && git checkout -- "$TARGET_FILE")

# --- Segment 6: blame ---
add_title "Right-click a file, then Blame"
start_capture
demo_mousemove 700 888
demo_click 3
sleep 1.2
# y=927 is "Blame" in the 8-item file context menu (see the same note on
# segment 5's y=844 - this used to be y=982, which now lands on "Copy Path"
# since "View File Contents" was added above it).
demo_mousemove 858 927
sleep 0.7
demo_click 1
sleep 1.5
demo_mousemove 600 863
sleep 1.2
demo_mousemove 600 550
sleep 1.2
# Close Blame's tab before opening another of our webview panels: having 2+
# of our panels open at once reproducibly breaks Ctrl+W's focus routing
# (see demo_closetab). Blame is the 3rd tab here (package.json, Git Log:
# package.json, Blame: package.json), landing around x=1170.
demo_closetab 1170
sleep 0.7
stop_capture

# --- Segment 6b: folder view groups the files-changed panel by directory ---
# Blame's segment left row_y(1) selected (a3714473, whose only file is
# TARGET_FILE) - switch to row 6 (f5c159b1, "ci: build express with node.js
# v26") instead, which touches two different directories
# (.github/workflows/ and the repo root), so grouping is actually visible
# instead of a single "(root)" header over one file.
add_title "Group the files-changed panel by folder"
start_capture
demo_mousemove 700 "$(row_y 6)"
demo_click 1
sleep 1
demo_mousemove 700 888
demo_click 3
sleep 1.2
# y=1025 is "Folder View" in the file context menu - a checkbox-style
# toggle, unaffected by the View File Contents row shift above since it (and
# Clear Filters below it) sit below a separator that bottom-anchors them.
demo_mousemove 785 1025
sleep 0.7
demo_click 1
sleep 1.8
stop_capture

# --- Segment 7: it also works on folders ---
# demo-express's root has few enough entries that "test" (y=254) is already
# visible without scrolling - no demo_scroll needed here (this used to
# target a much deeper tree in a different demo repo; left as a stale
# scroll-then-click at a now-unrelated position, it was actually
# right-clicking "Readme.md" and opening a single-file log, defeating the
# entire point of this segment - confirmed by replaying it in isolation and
# watching the wrong file's log open). Right-click "test" itself and use its
# own "Show Git Log" entry (not the file-context-menu's "Show File Log" -
# folders get a different native VS Code context menu, this script doesn't
# add anything to it) to open its repo-relative, multi-file log.
#
# y=904 for "Show Git Log" - this was ALSO stale at one point (measured at
# 959, from before some native menu item - "Add Folder to Chat" is the
# likely culprit, a Copilot-contributed item - was added to VS Code's own
# folder context menu above it, shifting every item below it down by one
# row's worth of pixels, the same class of drift documented for the file
# context menu elsewhere in this script). This one was a lot nastier to
# trace than a simple miss: it didn't fail loudly, the resulting click
# landed on a harmless native item instead (just expanding the folder in
# the Explorer), so "Git Log: test" silently never opened - which then
# threw off segment 8's tab-closing math below (it assumes 4 tabs are open,
# demo_closetab'ing by position; with only 3, those positions closed the
# wrong tabs, including - some of the time - this segment's own "Git Log:
# package.json" panel). Confirmed directly: this was the actual root cause
# behind CDP intermittently losing the webview target from segment 9
# onward on full recording runs, which for a while looked like (and was
# chased as) a CDP/Electron stability problem instead of what it actually
# was - segment 7 silently failing three segments earlier.
add_title "It also works on folders"
start_capture
demo_mousemove 140 254
demo_click 3
sleep 1.2
demo_mousemove 245 904
sleep 0.7
demo_click 1
sleep 2.5
stop_capture

# --- Segment 8: comparing revisions on a folder compares every changed file ---
# Unlike the single-file case (a direct diff), comparing two revisions of a
# folder opens the separate multi-file compare panel, since the folder's
# commits between those two shas can touch many files at once.
add_title "Comparing folder revisions compares every changed file"
start_capture
demo_mousemove 700 "$(row_y 1)"
demo_click 1
sleep 0.5
demo_ctrlclick 700 "$(row_y 3)"
sleep 0.6
demo_mousemove 700 "$(row_y 3)"
demo_click 3
sleep 1.2
demo_mousemove 857 279
sleep 0.7
demo_click 1
sleep 2.5
# Close the compare panel. By this point 4 tabs are open (package.json,
# Git Log: package.json, Git Log: test, Compare: ... - the active/4th one),
# so its label sits further right than any tab closed earlier in the script.
demo_closetab 1400
sleep 0.7
# Close "Git Log: test" too (now the 3rd of 3 remaining tabs, similar
# position to where Blame's tab sat earlier), back to "Git Log: package.json".
demo_closetab 1140
sleep 0.7
stop_capture

# --- Segment 9: filter by message and author together ---
# Both filter values are set directly via CDP (webview_set_filter, see
# winsafe.sh) rather than clicking the input with xdotool and typing into
# whatever has focus afterward - that pattern corrupted the real demo
# repo's package.json on a real recording run (the click didn't reliably
# transfer actual keyboard focus into the input, so the xdotool-typed
# characters landed in the still-focused editor tab instead). A real mouse
# hover still happens first purely so the input's focus/hover state is
# visible in the recording before the value appears.
add_title "Filter by message and author together"
start_capture
demo_mousemove 1500 157
sleep 0.6
webview_set_filter "authorName" "Wilson"
sleep 1.6
demo_mousemove 900 157
sleep 0.6
webview_set_filter "subject" "build"
sleep 1.8
stop_capture

# --- Segment 10: clear filters via right-click ---
# y=275 is "Clear Filters" in the commit-context-menu (Branches/separator/
# Clear Filters/Refresh, exactly 1 commit selected - Compare Selected
# Revisions and its separator are both hidden here, only shown for exactly
# 2 selected). Verified live via dev-session.sh + dev-jump.sh 10 + a
# screenshot before hardcoding this position.
add_title "Right-click to clear all filters"
start_capture
demo_mousemove 700 192
demo_click 1
sleep 0.6
demo_mousemove 700 192
demo_click 3
sleep 1.2
demo_mousemove 785 275
sleep 0.7
demo_click 1
sleep 1.8
stop_capture

# --- Segment 11: filter by file path ---
add_title "Filter by file path"
start_capture
demo_mousemove 700 "$(row_y 4)"
demo_click 1
sleep 1
demo_mousemove 900 852
sleep 0.6
webview_set_filter "path" "test"
sleep 1.8
stop_capture

# Segment 11 left the file-path filter set to "test" and never cleared it -
# clear it now so the Branches-filter segment below sees the full
# master-only commit list at the row_y() positions it expects, rather than
# whatever sparse subset still matches "test".
echo "=== Clearing the file-path filter left by segment 11 ==="
webview_set_filter "path" ""

# --- Segment 12: filter to a single branch ---
# feature/rate-limit-docs is a local-only branch (never pushed) created
# specifically for this demo - see demo/README.md - so it's guaranteed to
# exist, with commits not on master, giving this something real to filter
# down to. Its own tip is a real merge commit, so filtered to just this
# branch the graph column shows 2 lanes forking from master rather than a
# single dot - both of the merge's own parent commits, individually
# (--follow drops the merge commit itself from its own output; see
# demo/README.md for why).
#
# The submenu ITSELF (picking a branch out of it) is driven via CDP, not a
# mouse click at a screen coordinate - see click_branches_submenu_item() in
# winsafe.sh for why. The click that OPENS the parent commit-context-menu
# just below is a normal xdotool right-click like everywhere else in this
# script; only the nested submenu needed the different approach. The hover
# x/y args to click_branches_submenu_item are cosmetic only (they just
# position the mouse for a visible :hover highlight before the CDP click
# fires - see that function's comment); verified live via dev-session.sh +
# dev-jump.sh before hardcoding these positions.
add_title "View commits from just one branch"
start_capture
demo_mousemove 700 "$(row_y 1)"
demo_click 1
sleep 0.6
demo_mousemove 700 "$(row_y 1)"
demo_click 3
sleep 1.8
click_branches_submenu_item "feature/rate-limit-docs" 1080 283
# Branch checkboxes don't auto-close the submenu (multiple can be picked) -
# just let the clip end with it open showing the checked branch. Segment
# 13's right-click on the now-filtered row 1 replaces it with a fresh menu
# cleanly, same as clicking a menu item always replaces whatever menu was
# open before it.
sleep 1.8
stop_capture

# --- Segment 13: combine every branch into one view ---
add_title "Or combine every branch into one view"
start_capture
demo_mousemove 700 "$(row_y 1)"
demo_click 3
sleep 1.8
# Unlike the individual branch checkboxes in segment 12, "All" is exclusive
# and closes the whole menu on its own, revealing the now-updated log (both
# branches' commits together) with no extra dismiss step needed.
click_branches_submenu_item "All" 1080 228
sleep 1.8
# 5 independent fixture branches (feature/rate-limit-docs, its own tip a
# real merge of feature/rate-limit-docs-faq; feature/caching-docs;
# feature/websocket-docs; feature/security-headers-docs - see
# demo/README.md) all fork from the exact same point, master's a3714473.
# Combined with master via "All", that's 5 distinct colored lanes fanning
# out from one shared row, genuinely busy rather than just a single
# fork - not a straight line anywhere. --follow (this view is scoped to
# package.json) drops the merge commit itself as its own row - a known git
# limitation, --follow does not compose with merges - but both commits it
# merged (rows 4 and 5 below) are still individually present and still
# correctly show "reachable from feature/rate-limit-docs" on hover despite
# neither being a branch tip itself, which is exactly the kind of real
# containment info (not just what's visible elsewhere in the row) this
# tooltip exists to surface.
#
# Row layout (verified live via dev-session.sh before hardcoding any of
# this - see hover_graph_dot's comment in winsafe.sh for why the hover
# itself goes through CDP rather than xdotool alone):
#   row 1 ac574847 feature/security-headers-docs (own tip, single branch)
#   row 2 7a4330d8 feature/websocket-docs         (own tip, single branch)
#   row 3 69dd19f9 feature/caching-docs           (own tip, single branch)
#   row 4 74967783 (rate-limit-docs-faq's commit, no branch tip of its own)
#   row 5 aecc064a (rate-limit-docs's own first commit, ditto)
#   row 6 a3714473 master - the shared ancestor every lane above forks from
# Hovering rows 1, 3, 5, and 6 in turn shows genuinely different tooltip
# content each time, not just the same info restated: row 1 and row 3 are
# each reachable from just their own single branch; row 5 is reachable
# from feature/rate-limit-docs despite showing no branch pill in the
# Message column at all (real containment via the merge, not just what's
# already visible in the row); row 6 is reachable from all 5 at once, its
# "Branches:" pills wrapping across two lines - the richest tooltip in the
# whole graph, and nowhere else in the UI shows that at a glance.
hover_graph_dot 560 "$(row_y 1)" 1
sleep 1.9
hover_graph_dot 560 "$(row_y 3)" 3
sleep 1.9
hover_graph_dot 560 "$(row_y 5)" 5
sleep 1.9
hover_graph_dot 560 "$(row_y 6)" 6
sleep 2.2
unhover_graph_dot 6
sleep 0.3
stop_capture

# --- Segment 14: also reachable from the Source Control view ---
# Keyboard focus is inside our webview at this point (an iframe), which can
# silently swallow global keybindings sent via xdotool key (see
# demo_closetab's comment on the same issue with Ctrl+W) - so switch views
# by clicking the Activity Bar icon rather than sending Ctrl+Shift+G. Make a
# fresh throwaway edit first (the one from segment 5 was reverted right
# after that segment) so Source Control > Changes has something to show;
# cleanup() reverts it on exit same as before.
echo "=== Creating throwaway uncommitted change for the Source Control segment ==="
(cd "$DEMO_REPO" && sed -i '2i\  "//demo-uncommitted-change": true,' "$TARGET_FILE")
MADE_EDIT=1
add_title "Also available from the Source Control view"
start_capture
demo_mousemove 36 233
demo_click 1
sleep 1
demo_mousemove 200 296
demo_click 3
sleep 1.2
demo_mousemove 305 673
sleep 0.7
demo_click 1
sleep 2
stop_capture

if [ "$COVERAGE" -eq 1 ]; then
    finalize_coverage
fi

echo "=== 6. Concatenating ${#CLIPS[@]} clips ==="
CONCAT_LIST="$WORK/concat.txt"
: > "$CONCAT_LIST"
for c in "${CLIPS[@]}"; do
    echo "file '$c'" >> "$CONCAT_LIST"
done
CONCAT_MP4="$WORK/demo-full.mp4"
ffmpeg -y -f concat -safe 0 -i "$CONCAT_LIST" -c copy "$CONCAT_MP4" > "$WORK/concat.log" 2>&1

echo "=== 7. Converting to GIF ==="
GIF_OUT="$OUT_DIR/git-log-viewer-demo.gif"
PALETTE="$WORK/palette.png"
ffmpeg -y -i "$CONCAT_MP4" \
    -vf "fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos,palettegen=max_colors=${GIF_MAX_COLORS}:stats_mode=diff" \
    "$PALETTE" > "$WORK/palette.log" 2>&1
ffmpeg -y -i "$CONCAT_MP4" -i "$PALETTE" \
    -lavfi "fps=${GIF_FPS},scale=${GIF_WIDTH}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3" \
    -gifflags +transdiff \
    "$GIF_OUT" > "$WORK/gif.log" 2>&1

echo "Done: $GIF_OUT"
ls -la "$GIF_OUT"
