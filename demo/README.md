# Demo recording

Scripts to record a short animated-GIF demo of the extension's features, so
re-recording after UI changes is a rerun instead of a manual capture.

```
./record-demo.sh [path-to-demo-repo] [target-file-in-repo]
```

Defaults to `~/Downloads/vscode-demo` and `package.json`. The target repo
just needs real git history for the target file - `package.json` in a large,
actively-developed repo makes for a good demo (a small/sparse repo may
produce a thin or squashed history that doesn't show off filtering well).

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

## Requires

`docker`, `code` (VS Code CLI), and `sudo` (the Docker build step matches
`build.sh`/`install.sh`). `xdotool`, `ffmpeg`, `wmctrl`, and `fontconfig`
are checked at startup and auto-installed via `apt` if missing -
`check_prereqs` deliberately doesn't try to install docker or VS Code
itself, since those are bigger, more invasive decisions than a demo
recording script should make on its own.

## Window safety (`winsafe.sh`)

All input is targeted through `winsafe.sh`, which identifies the isolated
instance purely by a unique `window.title` marker (see
`isolated-settings.json`) and re-verifies that window is both active and
still carries the marker *immediately before every single input event* -
not just once at launch. This exists because a stale/closed window can
otherwise cause `xdotool` to silently deliver input to whatever real window
happens to be on top, including your own actual VS Code windows.

## If the UI changes

The click coordinates in `record-demo.sh`'s action sequence are calibrated
against a fixed 1900x1140 window. If a UI change shifts where something
renders, take a screenshot mid-run (the script leaves the window up until
`ffmpeg`/cleanup run) and adjust the affected `demo_mousemove` coordinates.
