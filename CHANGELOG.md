# Changelog

All notable changes to this project are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [Semantic Versioning](https://semver.org/) — tags look
like `v0.5.0`, and each one gets its own section below.

## [Unreleased]

## [0.4.10] - 2026-08-07

### Added

- **Branches submenu** — scope the commit list to specific branches (multi-select) or
  all branches, instead of just the checked-out branch, via a "Branches" item on the
  commit list's right-click menu.
- **Cherry-pick, Revert Commit, Create Branch, Create Tag** — new right-click actions on
  a selected commit.
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

## [0.4.9] and earlier

Released informally via local Docker builds (`build.sh`) before this
CHANGELOG and the GitHub Actions release pipeline existed. See git
history for what changed in each version.
