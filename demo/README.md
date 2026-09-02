# Demo recording

Scripts to record a short animated-GIF demo of the extension's features, so
re-recording after UI changes is a rerun instead of a manual capture.

```
./record-demo.sh [--coverage] [path-to-demo-repo] [target-file-in-repo]
```

Defaults to `~/Downloads/demo-express` (a full local clone of
[expressjs/express](https://github.com/expressjs/express) - small and fast
to clone, but with genuine multi-author history, real branches, and enough
depth to show off filtering) and `package.json`.

## Setting up (or recreating) the demo repo

```
./setup-demo-repo.sh [path-to-create]
```

Run this once before the first `record-demo.sh`, and again any time
`~/Downloads/demo-express` needs recreating (deleted, corrupted, moved
machines, ...) - it wipes and rebuilds the target directory from scratch
every time, so it's always safe to re-run.

**Why a separate setup step, not just `git clone`:** `record-demo.sh`'s
`row_y()` helper and a long list of hardcoded SHA comments throughout it
are calibrated against package.json's history looking *exactly* like it
does as of one specific commit. express is a real, actively-developed
project - a plain `git clone` today gives a different HEAD than one run
next month, silently invalidating every calibrated position. `record-demo.sh`
itself never fetches (see its step 0), which keeps an *existing* checkout
frozen, but does nothing to help recreate the directory identically if it's
ever lost - `setup-demo-repo.sh` is that: it clones express, hard-resets
master to the exact pinned commit `record-demo.sh` assumes
(`PINNED_DEMO_SHA`, currently `a3714473`), recreates the one local-only
fixture branch (below), and then **removes the `origin` remote** - with no
remote configured, `git fetch`/`git pull` in that directory can't silently
move master out from under the calibrated positions even by accident, not
just "please don't run that here." `record-demo.sh` checks for both the
pinned commit and the fixture branch at startup and fails loudly with a
pointer back to this script if either is missing.

There are 5 fixture branches (local-only, never pushed anywhere), all
forking from the exact same point (master's pinned commit) so that
combining them via "All" produces a genuinely busy graph - several
distinct colored lanes fanning out from one shared row, not just a single
fork or a straight line. `feature/rate-limit-docs` alone gives the
single-branch Branches-filter segment something real to filter down to;
combined with the other 4 via "All", the graph and hover-tooltip segments
have several different lines to show, each with meaningfully different
tooltip content.

`feature/rate-limit-docs`'s own tip is a real merge commit (two
independent commits, `feature/rate-limit-docs-faq`'s and its own, merged
together), entirely contained within the branch - master's own history is
never touched. Every fixture commit (both of that merge's parents, and
each of the other 4 branches' single commits) deliberately touches
`package.json` itself, each on its own distinct, previously-unused line of
the `keywords` array - so every one is actually visible/selectable in the
demo's package.json-scoped log, and none of their diffs conflict with each
other. Each commit also gets an explicit, fixed `GIT_AUTHOR_DATE`/
`GIT_COMMITTER_DATE` (one minute apart, safely after master's own real
commit date) rather than whatever the wall clock reads when the script
happens to run - `git log`'s default order is reverse-chronological by
commit date, so this is what makes the resulting row order (and every
hardcoded `row_y()` position in record-demo.sh that depends on it) exactly
reproducible from one run to the next.

One thing to know if this ever needs revisiting: `--follow` (used
whenever the demo's log view is scoped to a single file, which it always
is here) drops a merge commit entirely from its own output - a known git
limitation, unrelated to how "interesting" the merge's own diff is, and
present even for a plain two-parent merge with nothing else going on.
`feature/rate-limit-docs`'s merge commit itself is therefore never one of
the rows the demo can hover - only its two parents are, individually, and
both still correctly show "reachable from feature/rate-limit-docs" on
hover despite neither being a branch tip on its own. Confirmed directly
against the CLI command record-demo.sh's own `getLog()` call builds
(`git log --follow --all -- package.json`, with and without `--all`) before
relying on it here.

## What it does

1. Builds a fresh vsix from the current source (via the same Docker flow as
   `build.sh`).
2. Installs it into a throwaway VS Code profile (`--user-data-dir` /
   `--extensions-dir`), isolated from your real profile/extensions/theme.
3. Launches that profile against the target repo, sized to a fixed geometry,
   and dismisses the first-run "Welcome to VS Code" wizard a brand-new
   profile always shows.
4. Makes one throwaway uncommitted edit to the target file (so there's
   something to show for "Compare with Working Tree"), reverted at the end
   no matter how the script exits.
5. Records each feature as its own clip, preceded by a title card
   (`add_title`) giving context on what's about to happen, then
   concatenates everything and converts it to a palette-optimized GIF at
   `output/git-log-viewer-demo.gif`.

`output/git-log-viewer-demo.gif` is committed on purpose - it's embedded in
the top-level README, so it needs to actually exist in the repo (not be
gitignored) for GitHub/Marketplace to render it. Re-run the script and
commit the new file to update it.

## `--coverage`

Also captures real V8 code coverage of the extension-host process (
`extension.ts`, `gitLogPanel.ts`, `gitService.ts`, `messageHandler.ts`,
`diffDocProvider.ts` - everything bundled into `dist/extension.js`) during
this same click-through session, via `NODE_V8_COVERAGE`. A report is written
to `output/extension-coverage/` (gitignored - it's a diagnostic artifact,
not something to commit like the GIF).

This isn't a substitute for `npm test`'s unit tests: there are no
assertions, it only tells you *which lines executed* while the scripted
walkthrough played out - which is exactly the class of bug (dead/unwired
code, a stale `dist/` that doesn't match `src/`) that mocked unit tests
can't catch, since they never run the real, wired-together extension. It
also can't see `webview/main.ts` at all - the webview runs in a separate
Chromium context that `NODE_V8_COVERAGE` has no visibility into (that file
is covered by the unit test suite instead, via jsdom).

The isolated instance is quit gracefully (Ctrl+Q, not killed) at the end of
the session so Node actually flushes its coverage data before the process
exits - a killed process may not.

## Requires

`docker`, `code` (VS Code CLI), and `sudo` (the Docker build step matches
`build.sh`/`install.sh`). `xdotool`, `ffmpeg`, `wmctrl`, `fontconfig`,
`curl`, and `python3` are checked at startup and auto-installed via `apt`
if missing, and the `websocket-client` pip package is installed if missing
too - `check_prereqs` deliberately doesn't try to install docker or VS Code
itself, since those are bigger, more invasive decisions than a demo
recording script should make on its own.

`python3` + `websocket-client` drive the one part of this script that talks
to the webview via Chrome DevTools Protocol instead of simulated mouse
clicks - see "Driving the Branches submenu" below.

## Window safety (`winsafe.sh`)

All input is targeted through `winsafe.sh`, which identifies the isolated
instance purely by a unique `window.title` marker (see
`isolated-settings.json`) and re-verifies that window is both active and
still carries the marker *immediately before every single input event* -
not just once at launch. This exists because a stale/closed window can
otherwise cause `xdotool` to silently deliver input to whatever real window
happens to be on top, including your own actual VS Code windows.

## Driving the Branches submenu (Chrome DevTools Protocol)

Every menu interaction in this script is a plain `xdotool` click except
one: picking a branch out of the Branches submenu (nested inside the
commit-context-menu). That submenu populates via a real async round-trip to
the extension host (`git branch` runs and replies before there's anything
to render), so *how long until it's actually clickable* isn't a fixed UI
render delay the way everything else in this script is - it visibly grows
under the same CPU load `ffmpeg`'s capture adds during a real recording,
and no fixed sleep (tried up to 6s) nor a pixel-color verify-and-retry loop
made clicking into it reliable.

`click_branches_submenu_item()` (`winsafe.sh`) instead drives it via Chrome
DevTools Protocol: the isolated instance is launched with
`--remote-debugging-port`/`--remote-allow-origins=*`, which exposes the
webview as a normal debuggable target, and `Runtime.evaluate` calls
`.click()` on the exact DOM element directly - the same click handler a
real click would fire, but requiring no rendering to have already happened,
and letting the script poll *real application state* (does the submenu
have children yet?) instead of guessing from a timer or a screenshot. A
real `xdotool` mouse hover at the item's approximate on-screen position
still happens first, purely so its `:hover` highlight is visible in the
recording - the actual click is CDP either way, so an imprecise hover
position only costs a slightly-off highlight, never a wrong selection.

## If the UI changes

The click coordinates in `record-demo.sh`'s action sequence are calibrated
against a fixed 1900x1140 window. If a UI change shifts where something
renders, take a screenshot mid-run (the script leaves the window up until
`ffmpeg`/cleanup run) and adjust the affected `demo_mousemove` coordinates.
When clicking a menu item (not a table row or a right-click that just opens
one), pause after the `demo_mousemove` and before the `demo_click` - a beat
long enough for the `:hover` highlight to actually be visible on screen,
not just the click's result appearing - matching every other menu-item
click in this script.
