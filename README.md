# Markdown Reader for Herdr

A native Markdown reader for [Herdr](https://herdr.dev), with a file tree, folder workspaces, filename search, and live refresh.
A companion shortcut opens documentation beside your terminal.

![Markdown Reader](preview.png)

## Install

Give your coding agent this repository URL and ask it to install the mod using your `~/.config/herdr-app/AGENTS.md` instructions. Both mod folders are required.

For a manual installation:

1. Copy `mods/markdown-reader` and `mods/markdown-reader-pane` into `~/.config/herdr-app/mods/` (on Windows: `%USERPROFILE%\.config\herdr-app\mods\`).
   Do not overwrite an existing mod with the same name.
2. Merge the supplied `keys.json` bindings into your existing `keys.json`; do not replace your whole file.
   Resolve any shortcut conflicts first.
3. Run `herdr-app check` against each installed mod folder.
4. Press **Ctrl+Shift+M** to open the reader or **Ctrl+Shift+R** to split a reader to the right of your focused pane.

The supplied bindings also include **Command+Shift+M/R** for macOS.
These are app shortcuts while Herdr is focused, not system-wide shortcuts.

## Read and search

The reader starts in the selected terminal's current folder, with the search field focused and the file tree visible.
Click a folder to expand or collapse it, and click a Markdown file to read it.
The sidebar button hides or shows the file tree.
Its kebab menu has **Collapse all folders**.

Type a filename or part of a folder path to search Markdown files across the workspace.
For example, `guides/install` can find `guides/setup/install.md`.
Results show the filename and parent folder, with up to 50 results in a scrollable list.
Arrow keys select results, Tab completes a path, Enter opens it, and Escape closes the list.
Clearing the search or opening a file also closes the results.
Ctrl+L or Command+L focuses the search field.
You can also paste an absolute or relative file path, or drop a local file into the reader.

The compact folder indicator opens a panel that accepts a folder path or opens the system folder picker through **Browse this computer**.
The chosen folder becomes the root for both the tree and search.
A path entered in a remote workspace uses that machine; the system picker selects a local folder.
An invalid folder keeps the current workspace and document open.

The toolbar kebab menu holds **A− / A+** for text size (12-23 px), **Reset text size**, **Refresh files and document**, and **Use terminal folder**.
Refresh updates the document, tree, and search index.
The reader also checks an open file every five seconds.
**Open in tab**, in the Menu of an overlay reader, keeps the file, folder, machine context, text size, and sidebar visibility.

Documents are drawn in GitHub's style: its colors, type sizes and spacing, syntax-colored code blocks, tables, and task lists, in dark or light by the app's appearance.
Code blocks support selection and copying; other text does not.
Web links open in the browser.
UTF-8 text files are limited to 1 MiB by Herdr.
MDX files are read as Markdown; components are not executed.

The reader remembers the last open file, expanded folders, text size, and sidebar visibility for each workspace folder.
Local and remote folders have separate saved state.
State is stored by Herdr and returns when you reopen the reader or select that folder again.
A file given explicitly when opening the reader takes priority over the saved file.

## Compatibility and limitations

- Checked with Herdr **0.1.11 on macOS**, including the tree, nested search, folder changes, and menu rendering.
  The earlier reader was checked on Windows; the new controls have not been checked on Windows or Linux.
- Filename indexing uses **ripgrep (`rg`)**.
  Windows has a bounded PowerShell fallback.
  On macOS/Linux, install `rg` or use the file tree and direct paths.
- Folder-path suggestions use built-in POSIX `sh` features on macOS/Linux, avoiding GNU-specific `find` options.
  Hidden files are included and symlinks are skipped.
  Local Windows uses PowerShell.
- Index results stop at 3,000 files and search results at 50.
  The Windows fallback also limits traversal to 20,000 entries, 600 directories, and six levels below the root.
  Each folder listing reads up to 1,000 entries; the tree stores up to 5,000 entries in total.
- Dependency/cache folders are skipped in the tree and filename index.
  Relative paths use the chosen workspace folder; **Use terminal folder** captures the terminal folder again.
- Remote files use Herdr's machine context; remote support has not been tested.
  Remote `~/` paths are not expanded by this mod.

## File and process access

The reader reads files outside its mod directory, including the working folder and file paths you choose.
It runs `rg`, PowerShell on local Windows, or `sh` for file discovery.
Directory paths are passed as process arguments or working directories, never as executable shell source.
It does not directly call network-fetch APIs or upload document contents.
Remote access, when selected, goes through Herdr's machine APIs.
Markdown rendering and opening links are handled by Herdr.

## Development checks

Run `node --test tests/*.test.cjs` with a recent Node.js version and `rg` available.
The tests use real files and discovery commands to check folder listings, nested search, tree controls, workspace changes, the folder picker, menu actions, remote routing, and stale reads.
The interaction harness records GPUI element descriptions and calls their event handlers; it does not test native pointer events or system dialogs.
Run `herdr-app check` on both mod folders and inspect the controls in the running app as well.
On Windows, setting `READER_TEST_SH` to a POSIX shell executable (or busybox.exe) also tests the Unix listing branch in `tests/folders.test.cjs`.
Node.js is needed only for development tests, not to use the mod.

See [RECIPE.md](RECIPE.md) for the build brief.
No personal layouts, settings, saved state, or documents are included.
