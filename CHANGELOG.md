# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/) — tags look
like `v0.5.0`, and each one gets its own section below.

## [0.5.1] - 2026-09-02

### Changed

- Updated `typescript` to 7.0.2 (the new Go-ported compiler). Required adding an explicit
  `"types": ["node"]` to `tsconfig.json` — the new compiler no longer auto-discovers
  `@types/node`'s ambient globals (`path`, `fs`, `Buffer`, `process`, etc.) without it.
  Dev-tooling only; the built extension is unaffected (esbuild does its own
  transpilation and never invokes `tsc`).

## [0.5.0] - 2026-09-02

### Added

- **Commit Graph** — the commit list's leftmost column now draws branch/merge topology
  as a graph: one lane per line of development, colored consistently down its length,
  connected by smooth curves at every branch and merge point, with a hover tooltip on
  each commit's dot showing which branches/tags it's actually reachable from. Works in
  the main log, File Log, and Folder View alike, stays correctly connected while
  filtering, and is hidden automatically whenever the list isn't in git's own log order
  (a column sort is active, or in Line History mode).

### Fixed

- Fixed `git log --follow` (used for any single-file "Show File Log" view) silently
  returning duplicate commits once pagination reached a second page — `--follow`'s
  internal rename-tracking doesn't compose correctly with `--skip`, a known git
  limitation. A scoped file's whole history is now fetched in one shot and paginated
  in-process instead of relying on git's own `--skip` for that case.

## [0.4.10] - 2026-08-30

### Added

- **Branches submenu** — scope the commit list to specific branches (multi-select) or
  all branches, instead of just the checked-out branch, via a "Branches" item on the
  commit list's right-click menu.
- **View Line History** — a new "Show Line History" command (editor right-click menu and
  Command Palette) shows the history of just the currently selected line(s).
- **View File Contents** — a new action in the changed-files context menu opens a file's
  content at a given revision in a read-only tab, instead of only ever showing it as one
  side of a diff.
- **Folder View** — a toggle in the changed-files context menu groups the list by
  directory instead of a flat list.
- "Show Git Log" now also appears as an icon button in the editor tab bar and the Source
  Control panel title, in addition to the existing right-click menu and keyboard shortcut.
- New `gitLogViewer.pageSize` setting to configure how many commits load per batch
  (default 100).

### Fixed

- Fixed a flaky test (`formatTimeAgo`'s 59-second boundary case) that compared against
  real wall-clock time captured at a different moment than the function's own internal
  clock read, occasionally flipping the result across a minute boundary. Frozen fake
  timers now guarantee both reads see the same instant.
- Fixed an intermittent `error: Could not read <sha>` / `could not parse commit <sha>`
  failure in the test suite's git fixture builder, seen only on GitHub-hosted CI runners.
  Root cause: git's `gc --auto` can trigger in a detached background process once a repo
  accumulates enough loose objects (this fixture creates 300+ commits across several
  branches), and a later git command in the same build can lose the race against that
  background repack. Disabled `gc.auto` for these throwaway, immediately-deleted repos.

### Changed

- Updated dependencies: `vitest` to 4.1.10, `@vitest/coverage-v8` to 4.1.11, `esbuild` to
  0.28.2, `@types/node` to 26.1.2, `c8` to 12.0.0, and the `actions/checkout`,
  `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, and
  `softprops/action-gh-release` GitHub Actions to their latest majors.
- `vitest.config.ts` → `vitest.config.mts`, and dropped `__dirname` in favor of
  `import.meta.dirname`, ahead of a future Vite major version that removes the
  CommonJS-config-loading fallback these relied on.

## [0.4.9] and earlier

Released informally via local Docker builds (`build.sh`) before this
CHANGELOG and the GitHub Actions release pipeline existed. See git
history for what changed in each version.
