#!/bin/bash
# Records a short animated-GIF demo of Git Log Viewer's features, driven by
# xdotool against a real, isolated VS Code instance (not a mock/screenshot
# mockup). Re-run this after UI changes instead of re-recording by hand.
#
# What it does, in order:
#   1. Builds a fresh vsix of the extension from the current source.
#   2. Installs it into a throwaway VS Code profile (--user-data-dir /
#      --extensions-dir), isolated from your real profile/extensions/theme.
#   3. Launches that profile against the demo repo, sized to a fixed
#      geometry, identified unambiguously via a unique window.title marker
#      (see winsafe.sh - never targets a window by guesswork).
#   4. Makes one throwaway uncommitted edit in the demo repo (to have
#      something to show for "Compare with Working Tree"), reverted at the
#      end no matter how the script exits.
#   5. Records the demo as a series of clips: a title card explaining what's
#      about to happen, then the actual xdotool-driven action, for each
#      feature - concatenated and converted to a palette-optimized GIF.
#
# Requires: xdotool, ffmpeg, wmctrl, fontconfig, docker, code (VS Code CLI).
# The first four are auto-installed via apt if missing (see check_prereqs);
# docker and the VS Code CLI are left alone since installing those is a
# bigger, more invasive decision than this script should make on its own.
#
# Usage: ./record-demo.sh [--coverage] [path-to-demo-repo] [target-file-in-repo]
# Defaults to ~/Downloads/vscode-demo and package.json.
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

    if [ "${#apt_pkgs[@]}" -gt 0 ]; then
        if ! command -v apt-get >/dev/null 2>&1; then
            echo "FATAL: missing tools (${apt_pkgs[*]}) and apt-get isn't available to install them" >&2
            exit 1
        fi
        echo "Installing missing prerequisites: ${apt_pkgs[*]}"
        sudo apt-get update -qq
        sudo apt-get install -y "${apt_pkgs[@]}"
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
DEMO_REPO="${1:-$HOME/Downloads/vscode-demo}"
TARGET_FILE="${2:-package.json}"
WORK="$(mktemp -d)"
OUT_DIR="$SCRIPT_DIR/output"
mkdir -p "$OUT_DIR"
COVERAGE_DIR="$WORK/v8-coverage"
COVERAGE_OUT_DIR="$SCRIPT_DIR/output/extension-coverage"
[ "$COVERAGE" -eq 1 ] && mkdir -p "$COVERAGE_DIR"

source "$SCRIPT_DIR/winsafe.sh"

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
    rm -rf "$WORK"
}
trap cleanup EXIT

if [ ! -d "$DEMO_REPO/.git" ]; then
    echo "FATAL: $DEMO_REPO is not a git repo" >&2
    exit 1
fi

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
nohup code --user-data-dir="$WORK/profile-user-data" \
     --extensions-dir="$WORK/profile-extensions" \
     --new-window \
     --disable-workspace-trust \
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

echo "=== 4. Creating throwaway uncommitted change for Working Tree demo ==="
(cd "$DEMO_REPO" && sed -i '2i\  "//demo-uncommitted-change": true,' "$TARGET_FILE")
MADE_EDIT=1

echo "=== 5. Recording segments ==="

# --- Segment 1: open the file, show the context menu entry, then invoke via the hotkey ---
add_title "Right-click a file, or press the shortcut"
start_capture
demo_key ctrl+p
sleep 0.6
demo_type "$TARGET_FILE"
sleep 0.6
demo_key Return
sleep 1.5
demo_mousemove 900 400
demo_click 3
sleep 1.6
demo_key Escape
sleep 0.4
demo_key ctrl+alt+bracketright
sleep 2
stop_capture

# Commit row Y coordinates in the log table: row 1 starts at y=192, each
# subsequent row is ~30px down. These specific rows (4 and 9) were chosen
# because, for package.json in the vscode-demo repo, they land on commits
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

# --- Segment 5: compare with working tree ---
add_title "Compare a revision with your Working Tree"
start_capture
demo_mousemove 700 888
demo_click 3
sleep 1.2
# y=941 is "Compare with Working Tree" in the file context menu (measured
# directly via screenshot - the menu shrank by ~42px at some point, this
# used to be y=983 which now lands one item down, on "Blame").
demo_mousemove 856 941
demo_click 1
sleep 2.2
demo_key ctrl+w
sleep 0.7
stop_capture

# --- Segment 6: blame ---
add_title "Right-click a file, then Blame"
start_capture
demo_mousemove 700 888
demo_click 3
sleep 1.2
# y=982 is "Blame" in the file context menu (see the same note on segment
# 5's y=941 - this used to be y=1025, which now lands on "Copy Path").
demo_mousemove 858 982
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

# --- Segment 7: it also works on folders ---
# This clone has no tags, so we show HEAD/branch pills instead of tag pills:
# scroll the Explorer up to the "test" folder (the current HEAD commit
# touched a file under it, so its log's top row carries the HEAD/main/origin
# decorations), right-click it, and open its (repo-relative) log.
add_title "It also works on folders"
start_capture
demo_scroll 250 300 8 4
sleep 0.4
demo_mousemove 140 587
demo_click 3
sleep 1.2
demo_mousemove 247 1115
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
add_title "Filter by message and author together"
start_capture
demo_mousemove 1500 157
demo_click 1
demo_type "Bierner"
sleep 1.6
demo_mousemove 900 157
demo_click 1
demo_type "bump"
sleep 1.8
stop_capture

# --- Segment 10: clear filters via right-click ---
add_title "Right-click to clear all filters"
start_capture
demo_mousemove 700 192
demo_click 3
sleep 1.2
demo_mousemove 785 233
demo_click 1
sleep 1.8
stop_capture

# --- Segment 11: filter by file path ---
# Row 4 (not 9): after Clear Filters restores the full, unfiltered commit
# list, row 9 is a different commit than during the earlier Bierner-filtered
# view and doesn't touch anything under "skills" - row 4 (Matt Bierner's
# "Fully switch normal npm run compile" commit) is the one with those files.
add_title "Filter by file path"
start_capture
demo_mousemove 700 "$(row_y 4)"
demo_click 1
sleep 1
demo_mousemove 900 852
demo_click 1
demo_type "skills"
sleep 1.8
stop_capture

# --- Segment 12: also reachable from the Source Control view ---
# The previous segment ends with keyboard focus inside our webview's filter
# input (an iframe), which can silently swallow global keybindings sent via
# xdotool key (see demo_closetab's comment on the same issue with Ctrl+W) -
# so switch views by clicking the Activity Bar icon rather than sending
# Ctrl+Shift+G. The throwaway edit from step 4 is still the one changed file
# shown under Source Control > Changes.
add_title "Also available from the Source Control view"
start_capture
demo_mousemove 36 233
demo_click 1
sleep 1
demo_mousemove 200 296
demo_click 3
sleep 1.2
demo_mousemove 305 673
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
