import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Button, Input, InputState, Popover, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { theme, settings, props, focused, panes, spaces, home, readTextFile, pickFolder, run, closeOverlay, nextCommand, shared, setShared } from "herdr";
import { indexMarkdown, listFolder, skipFolder } from "./files.js";
import { clean, resolvePath, rankFiles, isFolderQuery, searchMatches } from "./search.js";
import { folderContext } from "./context.js";
import { lexDocument, documentView } from "./markdown.js";

function currentFolder() {
  return folderContext(focused(), panes(), spaces(), home());
}

const WELCOME = `# A little room to read

Your Markdown, beautifully at home in Herdr.

Choose a file in the sidebar, search by filename or folder path, or **drop a Markdown file into this reader**.
The reader starts in the selected terminal's folder.
Use the **folder indicator** to choose another workspace.

## Made for your workflow

- Read documentation beside your terminal.
- Follow links and scroll at your own pace.
- Expand folders in the file tree, or hide the sidebar with the **sidebar button**.
- Open the **kebab menu** to change the text size with **A−** and **A+**.
- File changes appear automatically, every few seconds.

> A quieter way to read a README, review a plan, or keep your notes close.

## All the familiar Markdown

**Bold ideas**, *small details*, and \`inline code\` get their own place.

\`\`\`js
const idea = "Keep the docs beside the work.";
console.log(idea);
\`\`\`

| Read | Review | Reference |
| --- | --- | --- |
| Project READMEs | Implementation plans | Personal notes |

---

Use **Ctrl+Shift+M** to open this reader again.
Choose **Open in tab** in the kebab menu for a full reading workspace.
`;

const EMPTY = "*This file is empty.*";

export default class MarkdownReader extends View {
  init(_props, cx) {
    const p = props() || {};
    const context = currentFolder();
    this.base = p.cwd || context.cwd;
    this.on = p.on !== undefined ? p.on : context.on;
    this.file = null;
    this.content = WELCOME;
    this.fontSize = Math.max(12, Math.min(23, Number(p.fontSize) || 15));
    this.doc = null; this.words = 0; this.buildVersion = 0;
    this.request = 0;
    this.loading = false;
    this.error = null;
    this.files = []; this.matches = []; this.selected = 0;
    this.searchVersion = 0; this.indexVersion = 0;
    this.workspaceVersion = 0; this.folderVersion = 0;
    this.treeVisible = p.treeVisible !== false;
    this.rootExpanded = true;
    this.expanded = new Set(); this.tree = new Map();
    this.menuOpen = false; this.folderOpen = false; this.folderPending = false; this.pickingFolder = false;
    this.resultsScroll = VirtualListScrollHandle.new();
    this.treeScroll = VirtualListScrollHandle.new();
    this.showSuggestions = false;
    this.inputFocused = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ placeholder: "Search files by name or path…", value: p.query || "" });
    this.input.on("change", (_e, cx) => this.queryChanged(cx));
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.folderInput = InputState.new({ placeholder: "Folder path", value: this.base });
    this.folderInput.on("submit", (_e, cx) => this.openFolder(this.folderInput.value(), this.on, cx));
    this.restoreState(cx, p);
    this.rebuild(cx);
    if (p.file) this.open(p.file, cx, p.fileOn !== undefined ? p.fileOn : this.on);
    else if (clean(p.query)) this.queryChanged(cx);
    this.reindex(cx);
    this.readTree("", cx);
    // Pane creation assigns focus after init; focus the search once it mounts.
    cx.timer.after(1, cx => { this.focusPath(); cx.notify(); });
    cx.timer.every(5000, cx => {
      this.watchBuild(cx);
      this.rebuild(cx);
      if (this.file && !this.loading) this.load(cx, true);
    });
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
        if (command === "open") this.focusPath();
        if (command === "toggle-tree") { this.treeVisible = !this.treeVisible; this.saveState(); cx.notify(); }
        if (command === "menu") { this.menuOpen = !this.menuOpen; cx.notify(); }
        if (command === "open-folder") this.showFolderPicker(cx);
        if (command === "use-terminal-folder") { const context = currentFolder(); this.openFolder(context.cwd, context.on, cx); }
        if (command === "smaller") this.resizeText(-1, cx);
        if (command === "larger") this.resizeText(1, cx);
      }
    });
  }

  stateKey() {
    return "markdown-reader.workspace.v1:" + JSON.stringify([this.on || null, resolvePath(this.base, this.base, this.on ? null : home())]);
  }

  saveState() {
    setShared(this.stateKey(), {
      file: this.loadedFile || null, fileOn: this.loadedOn === undefined ? this.on : this.loadedOn,
      fontSize: this.fontSize, treeVisible: this.treeVisible,
      rootExpanded: this.rootExpanded, expanded: [...this.expanded],
    });
  }

  restoreState(cx, overrides = {}) {
    const state = shared(this.stateKey());
    if (!state || typeof state !== "object") return;
    if (overrides.fontSize === undefined && Number.isFinite(state.fontSize)) this.fontSize = Math.max(12, Math.min(23, state.fontSize));
    if (overrides.treeVisible === undefined) this.treeVisible = state.treeVisible !== false;
    const folders = Array.isArray(state.expanded) ? state.expanded.filter(path => typeof path === "string" && path && !path.startsWith("/") && !path.split("/").includes("..")).slice(0, 5000) : [];
    if (!overrides.file && typeof state.file === "string" && state.file) this.open(state.file, cx, state.fileOn === undefined ? this.on : state.fileOn);
    this.expanded = new Set(folders);
    this.rootExpanded = state.rootExpanded !== false;
    for (const path of folders) this.readTree(path, cx);
  }

  style() {
    const s = settings();
    return { dark: Boolean(s.dark), fontSize: this.fontSize, fontFamily: s.font_family };
  }

  // Builds the document outside render when its text, theme or size changes; the newest build wins.
  // A text change lexes again; a theme, size or font change only draws again.
  rebuild(cx) {
    const style = this.style(), key = this.loadedFile || "welcome", text = this.content || EMPTY;
    const want = { text, key, ...style }, last = this.wanted;
    if (last && Object.keys(want).every(name => last[name] === want[name])) return false;
    const version = ++this.buildVersion, stale = () => version !== this.buildVersion;
    this.wanted = want; this.building = true; this.beat = Date.now(); this.buildError = null;
    cx.spawn(async cx => {
      const pause = () => { this.beat = Date.now(); return cx.sleep(0); };
      try {
        const doc = this.doc?.text === text && this.doc.key === key ? this.doc : await lexDocument(text, key, pause, stale);
        if (!doc || stale()) return;
        this.doc = doc; this.words = this.content ? doc.words : 0;
      } catch (error) {
        if (!stale()) this.dropDocument(String(error.message || error));
      } finally {
        if (!stale()) { this.building = false; cx.notify(); }
      }
    });
    return true;
  }

  // Herdr stops a script slice that runs too long, and a stopped build never reaches its `finally`.
  watchBuild(cx) {
    if (!this.building || Date.now() - this.beat < 3000) return;
    this.buildVersion++; this.building = false;
    this.dropDocument("This document is too large to show.");
    cx.notify();
  }

  // Shows why the document is missing, rather than an older one.
  dropDocument(message) {
    this.doc = null; this.buildError = message;
  }

  async close() { this.buildVersion++; this.doc = null; }

  reindex(cx) {
    const version = ++this.indexVersion, base = this.base, on = this.on;
    this.indexing = true; this.searchError = null;
    cx.spawn(async cx => {
      try {
        const result = await indexMarkdown(base, on);
        if (version !== this.indexVersion) return;
        this.files = result.files; this.limited = result.limited;
      } catch (e) { if (version === this.indexVersion) this.searchError = String(e.message || e); }
      finally {
        if (version === this.indexVersion) {
          this.indexing = false;
          if (this.showSuggestions) this.queryChanged(cx);
          cx.notify();
        }
      }
    });
  }

  readTree(path, cx, force = false) {
    if (!force && this.tree.has(path)) return;
    const version = this.workspaceVersion, on = this.on, base = this.base;
    const node = { entries: [], loading: true, error: null };
    this.tree.set(path, node);
    cx.spawn(async cx => {
      try {
        const entries = await listFolder(path ? resolvePath(path, base, null) : base, on);
        if (version !== this.workspaceVersion || this.tree.get(path) !== node) return;
        const used = [...this.tree.values()].reduce((total, item) => total + item.entries.length, 0);
        const available = Math.max(0, 5000 - used);
        node.entries = entries.filter(entry => !entry.dir || !skipFolder(entry.path))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path))
          .slice(0, available);
        node.limited = entries.length >= 1000 || entries.length > available;
      } catch (error) { node.error = String(error.message || error); }
      finally {
        if (version === this.workspaceVersion && this.tree.get(path) === node) {
          node.loading = false; this.revealFile(); cx.notify();
        }
      }
    });
  }

  toggleFolder(path, cx) {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else { this.expanded.add(path); this.readTree(path, cx); }
    this.saveState(); cx.notify();
  }

  revealFile() {
    if (!this.file || this.fileOn !== this.on || !this.rootExpanded) return;
    const index = this.treeRows().findIndex(row => !row.message && !row.dir && resolvePath(row.path, this.base, null) === this.file);
    if (index >= 0) this.treeScroll.scroll_to_item(index, "center");
  }

  refresh(cx) {
    if (this.file) this.load(cx);
    this.reindex(cx);
    this.tree = new Map();
    for (const path of ["", ...this.expanded]) this.readTree(path, cx);
    cx.notify();
  }

  resizeText(delta, cx) {
    this.fontSize = Math.max(12, Math.min(23, this.fontSize + delta));
    this.rebuild(cx); this.saveState(); cx.notify();
  }

  showFolderPicker(cx) {
    this.menuOpen = false; this.folderOpen = true;
    this.folderInput.set_value(this.base); this.workspaceError = null;
    cx.timer.after(1, cx => { this.folderInput.focus(); cx.notify(); });
    cx.notify();
  }

  browseFolder(cx) {
    if (this.folderPending || this.pickingFolder) return;
    const version = this.workspaceVersion;
    this.pickingFolder = true; cx.notify();
    cx.spawn(async cx => {
      try {
        const folder = await pickFolder({ prompt: "Open folder" });
        if (folder && version === this.workspaceVersion) this.openFolder(folder, null, cx);
      } catch (error) { this.workspaceError = String(error.message || error); cx.notify(); }
      finally { this.pickingFolder = false; cx.notify(); }
    });
  }

  openFolder(value, on, cx) {
    if (!clean(value)) { this.workspaceError = "Enter a folder path."; cx.notify(); return; }
    const folder = resolvePath(value, on === this.on ? this.base : home(), on ? null : home());
    const version = ++this.folderVersion;
    this.folderPending = true; this.workspaceError = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        // Validate before replacing the document or the current workspace.
        await listFolder(folder, on);
        if (version !== this.folderVersion) return;
        this.workspaceVersion++; this.request++; this.searchVersion++; this.indexVersion++;
        this.base = folder; this.on = on; this.fileOn = on;
        this.file = null; this.loadedFile = null; this.loadedOn = null; this.content = WELCOME; this.error = null; this.loading = false;
        this.files = []; this.matches = []; this.showSuggestions = false; this.searching = false; this.folderError = null;
        this.tree = new Map(); this.expanded = new Set(); this.rootExpanded = true; this.treeVisible = true; this.fontSize = 15;
        this.folderOpen = false; this.menuOpen = false;
        this.input.set_value(""); this.folderInput.set_value(folder);
        this.restoreState(cx); this.rebuild(cx);
        this.readTree("", cx); this.reindex(cx); this.focusPath();
      } catch (error) {
        if (version === this.folderVersion) { this.workspaceError = String(error.message || error); this.folderOpen = true; }
      } finally {
        if (version === this.folderVersion) { this.folderPending = false; cx.notify(); }
      }
    });
  }

  queryChanged(cx) {
    this.selected = 0;
    this.matches = []; this.folderError = null; this.searching = false;
    const version = ++this.searchVersion, query = clean(this.input.value());
    this.resultsScroll.scroll_to_item(0);
    this.showSuggestions = Boolean(query);
    if (!query) { cx.notify(); return; }
    // A short debounce only for directory reads; indexed filename matching is immediate.
    if (!query.includes("/")) {
      this.matches = rankFiles(this.files, query, 50);
      cx.notify(); return;
    }
    this.matches = rankFiles(this.files, query, 50);
    this.searching = true;
    cx.timer.after(140, cx => {
      if (version !== this.searchVersion) return;
      cx.spawn(async cx => {
        try {
          const slash = query.lastIndexOf("/"), prefix = query.slice(0, slash + 1), term = query.slice(slash + 1);
          const dir = resolvePath(prefix, this.base, this.on ? null : home());
          const entries = await listFolder(dir, this.on);
          if (version !== this.searchVersion) return;
          this.matches = isFolderQuery(query) || /^(?:\/|~\/|[A-Za-z]:\/|\.\.?\/)/.test(query)
            ? rankFiles(entries, term, 50).map(entry => ({ ...entry, path: prefix + entry.path }))
            : searchMatches(this.files, entries, query, prefix);
        } catch (e) { if (version === this.searchVersion) this.folderError = String(e.message || e); }
        finally { if (version === this.searchVersion) { this.searching = false; cx.notify(); } }
      });
    });
    cx.notify();
  }

  choose(entry, cx, completeOnly = false) {
    const value = entry.path + (entry.dir ? "/" : "");
    if (entry.dir || completeOnly) {
      this.input.set_value(value);
      this.queryChanged(cx); this.input.focus();
      this.input.set_selected_range({ start: value.length, end: value.length });
    } else this.open(value, cx);
  }

  submit(cx) {
    const match = this.showSuggestions && this.matches[this.selected];
    if (match) this.choose(match, cx);
    else if (clean(this.input.value()).endsWith("/")) this.queryChanged(cx);
    else this.open(this.input.value(), cx);
  }

  key(event, cx) {
    if (event.keystroke === "ctrl-l" || event.keystroke === "cmd-l") { this.focusPath(); cx.stop_propagation(); return; }
    if (!this.showSuggestions || !this.inputFocused) return;
    if ((event.key === "down" || event.key === "up") && this.matches.length) {
      this.selected = (this.selected + (event.key === "down" ? 1 : -1) + this.matches.length) % this.matches.length;
      this.resultsScroll.scroll_to_item(this.selected, "center");
      cx.notify(); cx.stop_propagation();
    } else if (event.key === "tab" && this.matches[this.selected]) {
      this.choose(this.matches[this.selected], cx, true); cx.stop_propagation();
    } else if (event.key === "escape") {
      this.showSuggestions = false; this.searchVersion++; cx.notify(); cx.stop_propagation();
    }
  }

  focusPath() {
    this.input.focus();
    this.input.set_selected_range({ start: 0, end: this.input.value().length });
  }

  open(value, cx, on = this.on) {
    let file = clean(value);
    if (!file) { this.input.focus(); return; }
    file = resolvePath(file, this.base, on ? null : home());
    this.file = file;
    this.fileOn = on;
    this.input.set_value("");
    this.showSuggestions = false; this.searchVersion++;
    // Reveal an opened search result in the tree without reading the whole workspace.
    const root = this.base.replace(/\/$/, "") + "/";
    if (on === this.on && file.startsWith(root)) {
      const parts = file.slice(root.length).split("/");
      parts.pop();
      let path = "";
      for (const part of parts) {
        path = path ? path + "/" + part : part;
        this.expanded.add(path); this.readTree(path, cx);
      }
      this.rootExpanded = true;
    }
    this.revealFile();
    this.load(cx);
  }

  load(cx, quiet = false) {
    const file = this.file, on = this.fileOn, request = ++this.request;
    this.loading = true;
    if (!quiet) { this.error = null; cx.notify(); }
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(file, { on });
        if (request !== this.request) return;
        if (text === null) throw new Error("File not found. Check the path and try again.");
        if (text.includes("\0")) throw new Error("This looks like a binary file. Open a Markdown or text file instead.");
        const changed = this.content !== text || this.error || this.loadedFile !== file;
        this.content = text;
        this.loadedFile = file;
        this.loadedOn = on;
        this.rebuild(cx);
        if (!quiet) this.saveState();
        this.error = null;
        if (changed || !quiet) cx.notify();
      } catch (error) {
        if (request !== this.request) return;
        const message = String(error.message || error);
        if (this.error !== message || !quiet) { this.error = message; cx.notify(); }
      } finally {
        if (request === this.request) { this.loading = false; if (!quiet) cx.notify(); }
      }
    });
  }

  button(id, label, action, primary = false, disabled = false) {
    const t = theme();
    return Button.new(id).h(30).px(10).gap(5).items_center().rounded(7).flex_shrink_0().disabled(disabled)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .text_size(12).font_medium().cursor_pointer().hover(s => s.opacity(0.8)).on_click(action).child(label);
  }

  iconButton(id, icon, label, action) {
    const t = theme();
    return this.button(id, svg("mods/markdown-reader/" + icon + ".svg").size(16), action)
      .w(30).px(7).bg(t.surface).text_color(t.muted).hover(style => style.bg(t.hover).text_color(t.foreground))
      .accessibility_label(label).tooltip(label);
  }

  readerMenu() {
    const t = theme(), p = props() || {};
    return Popover.new("reader-menu-popover").open(this.menuOpen).anchor("top_right")
      .on_open_change((open, cx) => { this.menuOpen = open; cx.notify(); })
      .trigger(this.iconButton("reader-menu", "more", "Reader options", () => {}))
      .content(v_flex().w(246).p(10).gap(6).rounded(9).border_1().border_color(t.border).bg(t.popover).shadow_md().text_color(t.foreground)
        .child(div().px(4).py(4).text_size(10).text_color(t.muted).child("READER OPTIONS"))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().text_size(12).child("Text size"))
          .child(this.button("reader-smaller", "A−", (_e, cx) => this.resizeText(-1, cx), false, this.fontSize <= 12).accessibility_label("Decrease text size"))
          .child(div().w(32).text_center().text_size(11).text_color(t.muted).child(this.fontSize + " px"))
          .child(this.button("reader-larger", "A+", (_e, cx) => this.resizeText(1, cx), false, this.fontSize >= 23).accessibility_label("Increase text size")))
        .child(this.button("reader-size-reset", "Reset text size", (_e, cx) => { this.fontSize = 15; this.rebuild(cx); this.saveState(); cx.notify(); }))
        .child(div().h(1).my(4).bg(t.border))
        .child(this.button("reader-refresh", "Refresh files and document", (_e, cx) => { this.menuOpen = false; this.refresh(cx); }))
        .child(this.button("reader-current-folder", "Use terminal folder", (_e, cx) => {
          this.menuOpen = false;
          const context = currentFolder(); this.openFolder(context.cwd, context.on, cx);
        }))
        .when(Boolean(p.overlay), el => el.child(this.button("reader-tab", "Open in tab", () => {
          const name = this.file ? this.file.split("/").pop() : "Markdown";
          run("tab.new", { name, mod: "markdown-reader", props: { file: this.file, fileOn: this.fileOn, cwd: this.base, on: this.on, fontSize: this.fontSize, treeVisible: this.treeVisible } });
          closeOverlay(p.overlay);
        })))
        .when(Boolean(p.overlay), el => el.child(this.button("reader-close", "Close reader", () => closeOverlay(p.overlay)))));
  }

  folderPicker() {
    const t = theme();
    return Popover.new("reader-folder-popover").open(this.folderOpen).anchor("top_right")
      .on_open_change((open, cx) => {
        if (open) this.showFolderPicker(cx);
        else { this.folderOpen = false; cx.notify(); }
      })
      .trigger(this.button("reader-folder", h_flex().min_w(0).gap(6).items_center()
        .child(svg("mods/markdown-reader/folder.svg").size(14).flex_shrink_0())
        .when(!this.width || this.width >= 600, el => el.child(div().min_w(0).truncate().child(this.base.replace(/\/$/, "").split("/").pop() || this.base))), () => {})
        .max_w(160).min_w(0).bg(t.surface).text_color(t.muted).accessibility_label("Open folder").tooltip((this.on ? this.on + ": " : "") + this.base + " · Change folder"))
      .content(v_flex().w(360).p(14).gap(10).rounded(9).border_1().border_color(t.border).bg(t.popover).shadow_md().text_color(t.foreground)
        .child(div().text_size(14).font_semibold().child("Open folder"))
        .child(div().text_size(11).text_color(t.muted).child(this.on ? "Folder on " + this.on : "Folder on this computer"))
        .child(Input.new(this.folderInput).w_full().h(34).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12))
        .when(Boolean(this.workspaceError), el => el.child(div().text_size(12).text_color(t.blocked).child(this.workspaceError)))
        .child(h_flex().gap(8).justify_between()
          .child(this.button("reader-browse-folder", "Browse this computer…", (_e, cx) => this.browseFolder(cx), false, this.folderPending || this.pickingFolder))
          .child(this.button("reader-confirm-folder", this.folderPending ? "Opening…" : "Open", (_e, cx) => this.openFolder(this.folderInput.value(), this.on, cx), true, this.folderPending))));
  }

  treeRows(path = "", depth = 0, rows = []) {
    if (depth > 40 || rows.length >= 5500) return rows;
    const node = this.tree.get(path);
    if (!node || node.loading || node.error || !node.entries.length) {
      rows.push({ key: "status:" + path, path, depth, message: node?.error ? "Cannot read folder. Click to retry." : node?.loading ? "Loading…" : node?.limited ? "File list limit reached. Collapse and refresh." : "No Markdown files", retry: Boolean(node?.error) });
      return rows;
    }
    for (const entry of node.entries) {
      const fullPath = path ? path + "/" + entry.path : entry.path;
      rows.push({ ...entry, path: fullPath, name: entry.path, key: fullPath, depth });
      if (entry.dir && this.expanded.has(fullPath)) this.treeRows(fullPath, depth + 1, rows);
    }
    if (node.limited) rows.push({ key: "limit:" + path, path, depth, message: "File list limit reached" });
    return rows;
  }

  fileTree() {
    const t = theme(), rows = this.rootExpanded ? this.treeRows() : [];
    const width = this.width && this.width < 650 ? 180 : 222;
    const rootName = this.base.replace(/\/$/, "").split("/").pop() || this.base;
    return v_flex().id("reader-sidebar").w(width).min_w(0).h_full().flex_shrink_0().bg(t.chrome).border_r(1).border_color(t.border)
      .child(h_flex().px(12).h(38).flex_shrink_0().items_center().gap(8)
        .child(div().flex_1().text_size(10).font_semibold().text_color(t.muted).child("FILES"))
        .child(Popover.new("reader-tree-menu").anchor("top_right")
          .trigger(this.iconButton("reader-tree-options", "more", "File tree options", () => {}))
          .content(v_flex().p(6).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_md()
            .child(this.button("reader-collapse-folders", "Collapse all folders", (_e, cx) => { this.expanded.clear(); this.rootExpanded = true; this.saveState(); cx.notify(); })))))
      .child(this.button("reader-root-folder", div().min_w(0).truncate().child((this.rootExpanded ? "▾ " : "▸ ") + rootName), (_e, cx) => { this.rootExpanded = !this.rootExpanded; this.saveState(); cx.notify(); })
        .mx(6).w(width - 12).min_w(0).tooltip(this.base))
      .child(div().relative().flex_1().min_h(0).mt(4)
        .child(v_virtual_list("reader-tree", rows.length, 30, index => rows[index].key, range => rows.slice(range.start, range.end).map(row => {
          const active = this.fileOn === this.on && this.file === resolvePath(row.path, this.base, null);
          return h_flex().h(30).pl(12 + Math.min(row.depth, 12) * 14).pr(10).gap(6).items_center().cursor_pointer()
            .bg(active ? t.selected : t.chrome).hover(style => style.bg(t.hover)).text_size(12).text_color(row.message ? t.muted : t.foreground)
            .when(!row.message, el => el.child(svg("mods/markdown-reader/" + (row.dir ? (this.expanded.has(row.path) ? "chevron-down.svg" : "chevron-right.svg") : "file.svg")).size(13).flex_shrink_0().text_color(row.dir ? t.muted : t.accent)))
            .child(div().flex_1().min_w(0).truncate().child(row.message || row.name));
        })).flex_1().size_full().track_scroll(this.treeScroll).on_item_click((key, cx) => {
          const row = rows.find(row => row.key === key);
          if (row?.retry) this.readTree(row.path, cx, true);
          else if (row && !row.message) row.dir ? this.toggleFolder(row.path, cx) : this.open(row.path, cx);
        }))
        .child(Scrollbar.vertical("reader-tree").absolute().inset_0()))
      .child(div().px(12).py(10).text_size(10).text_color(t.muted).child(this.indexing ? "Indexing Markdown files…" : this.files.length + (this.limited ? "+" : "") + " Markdown files"));
  }

  searchResults() {
    const t = theme(), matches = this.matches;
    return v_flex().mx(14).mb(8).p(6).gap(2).rounded(8).border_1().border_color(t.border).bg(t.raised)
      .h(40 + Math.max(1, Math.min(6, matches.length)) * 40).flex_shrink_0().id("reader-suggestions")
      .child(div().px(7).py(4).text_size(10).text_color(t.muted).truncate().child(
        this.searching || this.indexing ? "Searching files…" : matches.length + (matches.length === 50 ? "+" : "") + (matches.length === 1 ? " result" : " results") + " · ↑ ↓ select · Enter open · Tab complete · Esc close"))
      .when(Boolean(matches.length), el => el.child(div().relative().flex_1().min_h(0)
        .child(v_virtual_list("reader-search-results", matches.length, 40, index => matches[index].path, range => matches.slice(range.start, range.end).map((entry, offset) => {
          const index = range.start + offset, slash = entry.path.lastIndexOf("/");
          return h_flex().h(40).px(8).gap(8).items_center().rounded(5).cursor_pointer()
            .bg(index === this.selected ? t.selected : t.raised).hover(style => style.bg(t.hover))
            .child(div().w(26).text_size(9).text_color(t.accent).child(entry.dir ? "DIR" : "MD"))
            .child(v_flex().flex_1().min_w(0).gap(2)
              .child(div().text_size(12).truncate().text_color(t.foreground).child(entry.path.slice(slash + 1) + (entry.dir ? "/" : "")))
              .child(div().text_size(10).truncate().text_color(t.muted).child(slash < 0 ? "Workspace folder" : entry.path.slice(0, slash))));
        })).size_full().track_scroll(this.resultsScroll).on_item_click((key, cx) => { const entry = matches.find(entry => entry.path === key); if (entry) this.choose(entry, cx); }))
        .child(Scrollbar.vertical("reader-search-results").absolute().inset_0())))
      .when(!matches.length, el => el.child(div().p(8).text_size(12).text_color(t.muted).child(
        this.searching || this.indexing ? "Finding Markdown files…" : this.folderError || this.searchError || "No matching Markdown files. Try another name or open a folder.")));
  }

  render() {
    const t = theme();
    const words = this.words;
    return v_flex().id("markdown-reader").size_full().min_h(0).min_w(0).overflow_hidden().bg(t.surface).text_color(t.foreground)
      .track_focus(this.handle)
      .on_size_change((size, cx) => { if (this.width !== size.width) { this.width = size.width; cx.notify(); } })
      .on_key_down((event, cx) => this.key(event, cx))
      .on_drop((event, cx) => { if (event.paths?.length) this.open(event.paths[0], cx, null); })
      .child(h_flex().px(12).py(10).gap(8).min_w(0).items_center().flex_shrink_0()
        .child(this.iconButton("reader-toggle-tree", "sidebar", this.treeVisible ? "Hide file tree" : "Show file tree", (_e, cx) => { this.treeVisible = !this.treeVisible; this.saveState(); cx.notify(); })
          .text_color(this.treeVisible ? t.foreground : t.muted))
        .child(Input.new(this.input).flex_1().min_w(0).h(32).px(10).rounded(7).border_1()
          .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground).text_size(12).accessibility_label("Search files"))
        .child(this.folderPicker())
        .child(this.readerMenu()))
      .when(this.showSuggestions, el => el.child(this.searchResults()))
      .when(Boolean(this.error || this.buildError), el => el.child(v_flex().mx(18).mb(10).p(12).gap(4).rounded(8).bg(t.raised)
        .child(div().text_size(12).text_color(t.blocked).child("Could not open this file"))
        .child(div().text_size(12).text_color(t.muted).child(this.error || this.buildError))))
      .child(h_flex().flex_1().min_h(0).min_w(0).border_t(1).border_color(t.border)
        .when(this.treeVisible, el => el.child(this.fileTree()))
        .child(div().flex_1().min_w(0).min_h(0).h_full()
          .when(!this.error && Boolean(this.doc), el => el.child(documentView(this.doc, this.style(),
            "reader-document-" + this.doc.key, this.width && this.width < 650 ? 16 : 28)))))
      .child(h_flex().px(18).py(9).gap(12).items_center().bg(t.chrome).text_size(10).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().tooltip(this.file || this.base).child(this.error ? "UTF-8 text, up to 1 MiB" : this.loading || (this.building && this.file) ? "Loading…" : this.file ? this.file.split("/").pop() + " · Live" : "Search files · Ctrl+L"))
        .child(div().flex_shrink_0().child(`${words.toLocaleString()} words · ${Math.max(1, Math.ceil(words / 220))} min read`)));
  }
}
