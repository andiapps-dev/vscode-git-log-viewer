# Git Log Viewer

A TortoiseGit-inspired git log viewer for VS Code. Right-click any file or folder in the Explorer — or a file open in the editor — to view its git history in an interactive, multi-panel tab.

![Git Log Viewer demo](demo/output/git-log-viewer-demo.gif)

## Features

### Git Log Dialog
Right-click a file or folder in the VS Code Explorer, or right-click inside an open file in the editor, and select **Show Git Log** to open a three-panel log viewer. You can also press **Ctrl+Alt+]** (**Cmd+Alt+]** on Mac) while editing a file to jump straight to its log.

- **Commit list** — sortable, resizable, filterable columns (SHA, Message, Author, Date) with lazy loading (100 commits per batch, loads more on scroll)
- **Commit details** — full SHA, author, date, and commit message body
- **Changed files** — files modified in the selected commit with status, lines added/removed

### Filtering
- **Text filters** — each column header has a filter input; type to filter rows by that column
- **Date range picker** — the Date column has From/To date inputs that query git directly, so filtering works across the full history without needing to scroll-load everything
- When text filters are active and few matches are visible, additional commits are loaded automatically

### Resizable UI
- **Panel dividers** — drag the horizontal dividers between the three panels to resize them
- **Column widths** — drag the right edge of any column header to resize; double-click the edge to auto-expand to fit content
- **Blame and Compare panels** — vertical dividers are also draggable

### Compare Revisions
Ctrl+click two commits in the log view, then right-click and select **Compare Selected Revisions** to see all files changed between those commits. Each commit's details are shown side-by-side at the top for context.

When viewing a single file's log, comparing two revisions opens a direct diff of that file between the two commits.

### File History
Right-click any file in the changed files list and select **Show File Log** to open a new log tab scoped to just that file.

### Diff Viewer
Double-click any file in the changed files list to compare it against its previous revision using VS Code's built-in diff editor. Works in both the log view and the compare revisions view.

Right-click a file in the changed files list and select **Compare with Working Tree** to diff that revision of the file against the current contents on disk, including any uncommitted changes.

### Blame View
Right-click a file in the changed files list and select **Blame** to open an interactive blame view:

- **Left panel** — revision gutter showing SHA, author, and relative date, color-coded by commit
- **Right panel** — source code with line numbers, scroll-synced with the gutter
- **Commit info panel** — hover over any line to see full commit details; click to lock the selection

Blame is performed at the selected commit's revision, not HEAD.

### Theme Support
All views automatically adapt to your VS Code theme (dark, light, or high contrast) using native CSS variables.

## Usage

1. Open a git repository in VS Code
2. Either:
   - In the Explorer sidebar, right-click any file or folder and select **Show Git Log**, or
   - With a file open in the editor, right-click and select **Show Git Log**, or press **Ctrl+Alt+]** (**Cmd+Alt+]** on Mac)

### Keyboard & Mouse

| Action | Effect |
|--------|--------|
| Ctrl+Alt+] / Cmd+Alt+] (editor) | Show Git Log for the current file |
| Click commit | Select commit, show details and changed files |
| Ctrl+Click commit | Multi-select (up to 2 commits for comparison) |
| Right-click commit (2 selected) | Compare Selected Revisions |
| Double-click file | Compare with previous revision |
| Right-click file | Show File Log, Compare with Previous, Compare with Working Tree, Blame, Copy Path |
| Right-click (commit list) | Refresh, Clear Filters |
| Drag column header edge | Resize column |
| Double-click column header edge | Auto-expand column to fit content |

## Requirements

- VS Code 1.85 or later
- Git installed and available in PATH

No other extensions required.

## License

[MIT](LICENSE)
