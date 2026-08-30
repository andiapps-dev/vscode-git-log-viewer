#!/bin/bash
# Runs record-demo.sh's actual segment code - the real xdotool/CDP actions,
# not a description of them - against an ALREADY-RUNNING dev-session.sh
# window, up through (but not including) a given segment. Use this to get
# the app into the exact state a segment assumes without waiting through
# every segment before it by hand or via a full ./record-demo.sh run.
#
# No title cards, no video capture, no window launch/build/cleanup - just
# the input actions, at full speed. Requires dev-session.sh already running
# (this does NOT start one).
#
# Usage: ./dev-jump.sh <segment-id> [path-to-demo-repo]
#   <segment-id> matches record-demo.sh's own numbering, e.g. 1, 4b, 8, 12.
#   Runs every segment BEFORE it (1, 2, 3, ... up to but not including
#   <segment-id>) and stops - leaving the window in the state <segment-id>
#   itself assumes, ready for you to test that segment by hand or step
#   through it yourself with dev-act.sh.
#
# Example: ./dev-jump.sh 8
#   Runs segments 1 through 7 (and the file-path-filter-clearing glue code
#   between 11 and 12 is irrelevant here since it comes later), leaving the
#   window exactly where segment 8 ("comparing folder revisions") starts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_SEGMENT="${1:?usage: dev-jump.sh <segment-id> [demo-repo]}"
DEMO_REPO="${2:-$HOME/Downloads/demo-express}"
TARGET_FILE="package.json"
CDP_PORT="${CDP_PORT:-9333}"

source "$SCRIPT_DIR/winsafe.sh"

# Confirm a window actually exists before doing anything - a clear error
# here beats a cryptic one from deep inside the extracted segment code.
find_demo_window >/dev/null

# no-ops: record-demo.sh's segments call these between/around the real
# actions - we want the actions, not a rendered title card or a captured
# clip.
add_title() { :; }
start_capture() { :; }
stop_capture() { :; }
MADE_EDIT=""
WORK="$(mktemp -d)"  # some segments reference $WORK in passing; harmless here

RECORD_SCRIPT="$SCRIPT_DIR/record-demo.sh"
start_line=$(grep -n "^# --- Segment 1:" "$RECORD_SCRIPT" | head -1 | cut -d: -f1)
end_line=$(grep -n "^# --- Segment ${TARGET_SEGMENT}:" "$RECORD_SCRIPT" | head -1 | cut -d: -f1)
if [ -z "$start_line" ] || [ -z "$end_line" ]; then
    echo "FATAL: couldn't find segment markers for '1' and/or '$TARGET_SEGMENT' in $RECORD_SCRIPT" >&2
    echo "Known segment ids:" >&2
    grep -oP '(?<=^# --- Segment )[^:]+' "$RECORD_SCRIPT" >&2
    exit 1
fi
if [ "$end_line" -le "$start_line" ]; then
    echo "FATAL: segment $TARGET_SEGMENT isn't after segment 1 - nothing to run" >&2
    exit 1
fi

echo "=== Running segments 1 through just before $TARGET_SEGMENT (lines $start_line-$((end_line - 1))) ==="
sed -n "${start_line},$((end_line - 1))p" "$RECORD_SCRIPT" > "$WORK/segments.sh"
source "$WORK/segments.sh"
echo "=== Done. Window is now at the start of segment $TARGET_SEGMENT. ==="
rm -rf "$WORK"
