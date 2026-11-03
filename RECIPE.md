# Markdown Reader

A native Markdown reader in Herdr, shown as a dialog, tab, or pane beside a terminal.
It starts in the selected terminal's folder and provides an expandable file tree, filename search, folder selection, and live document refresh.

![Markdown Reader](preview.png)

## What you see

The dialog is 920 px wide and 85% of the window height.
A tab or split pane fills its available space.
All surfaces, borders, and text use Herdr theme colors.

A single compact toolbar contains an icon button for the sidebar, a search field, a folder indicator, and a kebab menu.
There is no title banner or full folder path row.
The folder indicator shows a folder icon and the root folder name, with the full path in its tooltip.
In narrow panes it shows only the folder icon.
Click it to open the folder selector.
The kebab menu contains text size controls, Reset text size, Refresh files and document, and Use terminal folder.
An overlay also has Open in tab and Close reader in this menu.
Text starts at 15 px and can be changed from 12 to 23 px.

Open folder shows a native popover with a folder path field, Open, and Browse this computer.
Browse opens the system folder picker.

The file tree is 222 px wide, or 180 px when the reader is narrower than 650 px.
It has a Files label, a kebab menu with Collapse all folders, and a collapsible root folder.
Folders sort before files and have expand/collapse arrows.
Each row has a Material Icon Theme icon after the arrow: a named folder icon such as docs, open while expanded, or a Markdown file icon such as readme, changelog, or markdown.
A light appearance uses the theme's light variants.
The open file has a selected background.
A footer gives the indexed file count.
Tree and document scroll independently.

Search results appear above the reading area only while a non-empty query is active.
Each result has a Material Icon Theme icon, a filename, and a parent folder.
The list holds up to 50 results and shows up to six rows before scrolling.
The selected result has a highlighted background.
Errors appear in the folder popover or above the document.

The document uses 28 px horizontal padding, or 16 px in a narrow pane, with 18 px vertical padding and a centered column up to 820 px wide.
A footer shows loading or refresh state, word count, and reading time at 220 words per minute.

## How it behaves

Ctrl+Shift+M, or the supplied Command binding, opens the dialog.
Ctrl+Shift+R opens a reader to the right of the focused pane through the companion launcher.
With no focused pane, the launcher shows a notification.
These are Herdr shortcuts, not system-wide shortcuts.

On opening, capture the selected terminal's live working folder and machine before the reader takes focus.
Prefer the focused terminal's folder, including layout terminal blocks, then a terminal in the same tab, then the space folder and local home.
Explicit cwd and machine props take precedence.
Focus the search field after the pane mounts.
For a new workspace, the tree starts visible; search results start hidden unless a query prop was supplied.
Persist the last successfully opened file and its machine, expanded folders, root expansion, text size, and sidebar visibility through Herdr shared state.
Key each record by the normalized workspace path and machine.
Restore on reader creation and successful folder changes; explicit file and display props take priority.
Save user changes immediately so closing another copy cannot overwrite newer state.

Read only the root directory and expanded directories for the tree.
Do not walk the entire tree to draw the sidebar.
Opening a search result expands its parent folders and scrolls the active file into view.
Files hides or shows the sidebar; Collapse closes expanded folders.
The root folder can also be collapsed.
A failed directory read has a retry row.

Index Markdown filenames recursively with ripgrep, skipping dependency and cache folders.
Use NUL-separated output so newlines in filenames do not split a file into multiple results.
Use the same case-insensitive glob option for inclusion and exclusion so exclusions take effect.
On local Windows without rg, use bounded PowerShell traversal.

Rank searches by exact filename, prefix, substring, path, and subsequence matches.
A query such as guides/install can find guides/setup/install.md.
Queries containing slashes also read the parent directory after a 140 ms debounce.
An explicit absolute path or a trailing slash browses that directory's immediate entries.
Up/down wrap through results and keep the selected row visible.
Tab completes a path; Enter or Open selects a file or enters a suggested folder.
Escape closes the results.
Clearing the search or opening a file also closes the results; focusing alone does not reopen them.
Ctrl+L and Command+L focus the search field.

Open folder accepts a path relative to the current workspace or an absolute path.
A typed path uses the workspace machine; Browse this computer always selects a local folder.
Cancellation leaves the workspace unchanged.
Validate the chosen directory before replacing the workspace or document.
A successful change clears the old document, search results, and expanded folders, then rebuilds the tree and index.
Use terminal folder captures the selected terminal context again through the same validation flow.

Open reads the resolved path and reports missing or binary files.
A dropped file is local and does not change the tree or search machine.
Keep the document's machine separately from the workspace machine.
Refresh reloads the document and rebuilds the tree and search index.
The reader checks an open file every five seconds.
Ignore stale file, folder, tree, and index results after a newer request or workspace change.

Open in tab carries the file, document machine, workspace folder and machine, text size, and sidebar visibility, then closes the overlay.
The reader draws Markdown itself in GitHub's style; only code blocks support selection and copying.
MDX components are not executed.

## Built from

There is no layout file, HTML, CSS, DOM, or browser runtime.
The main mod is a gpui-kit View with gpui-base InputState, Input, Button, Popover, Editor, virtual lists, scroll handles, and scrollbars.
Virtual list renderers only describe rows; their click handlers belong to the list.

The reader files are:

- markdown.js: Markdown parsing with the vendored marked lexer (vendor/marked.esm.js, MIT) and GitHub-styled native elements in a lazy list.
  Herdr stops a script slice that runs for about a second, and marked is slow under QuickJS, so documents are lexed in chunks with pauses, and inline text only when a block is drawn.
- main.js: UI, document loading, lazy tree state, search state, folder selection, and the command listener.
- context.js: terminal and machine selection.
- search.js: path cleanup and resolution, filename ranking, and indexed/directory result merging.
- files.js: rg indexing, Windows fallback, and immediate directory listings.
- icons.js: Material Icon Theme's lookup (path rule, then name, then the longest extension; light table first in a light appearance).
- vendor/material-icon-theme/: the folder and Markdown icons, a lookup table trimmed to them, and the theme's MIT license.
  tools/build-icons.mjs generates them from material-icon-theme 5.40.0; image() draws them in full color.
- book.svg, chevron-right.svg, and chevron-down.svg: native UI icons.
- mod.json: place:none and dialog dimensions.

Herdr APIs include theme, props, focused, panes, spaces, home, readTextFile, pickFolder, exec, window, run, closeOverlay, and nextCommand.
App commands are tab.new and pane.split.
Reader commands are open, refresh, toggle-tree, menu, open-folder, use-terminal-folder, smaller, and larger.
Props include file, fileOn, cwd, on, query, fontSize, treeVisible, and overlay.
Use cx.timer for data and debounce work, and cx.spawn for asynchronous operations.

The companion markdown-reader-pane mod captures the pane and terminal context before closing its one-pixel popup and splitting the captured pane.
The supplied keys.json contains only reader shortcuts and must be merged with existing bindings.

## Watch out

Do not edit Herdr's shipped mods, generated type files, personal layouts, or settings.
Check each mod with herdr-app check, then inspect it in the running app.
A passing check does not exercise deferred virtual rows or later async states.
A failed hot reload can retain the previous working build, so also inspect herdr-app status for errors.

The reader reads files outside its mod directory and runs discovery programs.
Disclose this on installation.
Paths are process arguments or working directories, never executable shell source.
Do not ship personal files, app state, or terminal contents.

Directory browsing uses POSIX sh on macOS/Linux and remote machines, and PowerShell on local Windows.
The POSIX branch uses immediate-child globs for regular and hidden entries, skips symlinks, and emits NUL-separated type/name fields.
Do not use GNU find flags because macOS uses BSD find.
Mac/Linux filename indexing requires rg, but tree browsing and direct paths work without it.

Limits are 3,000 indexed files, 50 search results, 1,000 entries per directory read, 5,000 stored tree entries, and 40 tree levels.
The Windows fallback also limits traversal to 20,000 entries, 600 directories, and six levels.
Herdr limits file reads to 1 MiB of UTF-8 text.
Home expansion is local only.
Remote integration and the new Windows/Linux controls have not been checked in the full app.
Native UI checks were run on Herdr 0.1.11 on macOS; the earlier reader was checked on Windows.

## Done when

- Both mods pass herdr-app check and show no errors in herdr-app status.
- A fresh reader uses the selected terminal folder, shows the root tree, and focuses search without showing results.
- Folders expand and collapse; Files toggles the sidebar; Collapse closes expanded folders.
- A nested file opens from the tree, and a search result reveals its parent folders and selected row.
- Filename and nested path search work with arrows, Tab, Enter, Escape, and clearing.
- Open folder works with typed paths and the system picker, and invalid paths or cancellation preserve the current workspace.
- Menu controls change and reset text size within the limits.
- Refresh updates the file, tree, and index; file polling updates changed document contents.
- Open in tab keeps the file and workspace context; the companion launcher creates a reader beside the selected pane.
- node --test tests/*.test.cjs passes with rg available.
- Native screenshots cover the tree, nested search, folder changes, and menu, including deferred list rows.
