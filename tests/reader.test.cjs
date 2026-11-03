const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReader, search, folderContext } = require('./support/reader-harness.cjs');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const folder of ['guides', 'guides/setup', 'empty', 'node_modules']) fs.mkdirSync(path.join(root, folder), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Project\n\nStart here.');
  fs.writeFileSync(path.join(root, 'guides/setup/install.md'), '# Installation\n\nRun the installer.');
  fs.writeFileSync(path.join(root, 'guides/README.md'), '# Guides');
  fs.writeFileSync(path.join(root, 'node_modules/ignore.md'), '# Dependency');
  fs.writeFileSync(path.join(root, 'plain.txt'), 'Text');
  return root.replaceAll('\\', '/');
}

test('starts in the selected terminal folder with a visible file tree and hidden search results', async t => {
  const root = workspace(t), app = createReader({ root });
  await app.settle();
  assert.equal(app.reader.base, root);
  assert.equal(app.reader.treeVisible, true);
  assert.equal(app.reader.showSuggestions, false);
  const rows = app.reader.treeRows();
  assert.ok(rows.some(row => row.path === 'README.md'));
  assert.ok(rows.some(row => row.path === 'guides' && row.dir));
  assert.ok(!rows.some(row => row.path === 'node_modules' || row.path === 'plain.txt'));
  assert.equal(app.reader.files.length, 3);
});

test('expands folders, opens a nested file, collapses folders and toggles the sidebar', async t => {
  const app = createReader({ root: workspace(t) }); await app.settle();
  app.find('reader-tree').handlers.on_item_click('guides', app.cx); await app.settle();
  assert.ok(app.reader.treeRows().some(row => row.path === 'guides/setup'));
  app.find('reader-tree').handlers.on_item_click('guides/setup', app.cx); await app.settle();
  app.find('reader-tree').handlers.on_item_click('guides/setup/install.md', app.cx); await app.settle();
  assert.match(app.reader.content, /^# Installation/);
  assert.equal(app.reader.showSuggestions, false);
  app.click('reader-collapse-folders');
  assert.ok(!app.reader.treeRows().some(row => row.path === 'guides/setup/install.md'));
  app.click('reader-toggle-tree'); assert.equal(app.find('reader-sidebar'), null);
  app.click('reader-toggle-tree'); assert.ok(app.find('reader-sidebar'));
});

test('searches nested paths, completes with Tab and opens with Enter', async t => {
  const app = createReader({ root: workspace(t) }); await app.settle();
  app.type('guides/install'); await app.settle();
  assert.equal(app.reader.matches[0].path, 'guides/setup/install.md');
  assert.ok(app.find('reader-search-results'));
  app.reader.key({ key: 'tab' }, app.cx); await app.settle();
  assert.equal(app.reader.input.value(), 'guides/setup/install.md');
  app.reader.input.handlers.submit({}, app.cx); await app.settle();
  assert.match(app.reader.content, /^# Installation/);
  assert.ok(app.reader.expanded.has('guides/setup'));
  assert.equal(app.reader.input.value(), '');
});

test('offers more than eight matches and supports selection, Escape and clear', async t => {
  const root = workspace(t);
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(root, `note-${i}.md`), '# Note');
  const app = createReader({ root }); await app.settle();
  app.type('note'); await app.settle();
  assert.equal(app.reader.matches.length, 50);
  app.reader.key({ key: 'up' }, app.cx); assert.equal(app.reader.selected, 49);
  app.reader.key({ key: 'escape' }, app.cx); assert.equal(app.reader.showSuggestions, false);
  app.reader.focusPath(); assert.equal(app.reader.showSuggestions, false);
  app.type(''); assert.equal(app.reader.showSuggestions, false);
});

test('opens a new workspace through the folder control and preserves it if a path is invalid', async t => {
  const root = workspace(t), app = createReader({ root }); await app.settle();
  app.reader.open('README.md', app.cx); await app.settle();
  app.find('reader-folder-popover').handlers.on_open_change(true, app.cx);
  app.reader.folderInput.set_value('missing'); app.click('reader-confirm-folder'); await app.settle();
  assert.equal(app.reader.base, root);
  assert.match(app.reader.content, /^# Project/);
  assert.match(app.reader.workspaceError, /Cannot list this folder/);
  app.reader.folderInput.set_value('guides'); app.click('reader-confirm-folder'); await app.settle();
  assert.equal(app.reader.base, root + '/guides');
  assert.equal(app.reader.file, null);
  assert.equal(app.reader.folderOpen, false);
  assert.equal(app.reader.files.length, 2);
  assert.ok(app.reader.treeRows().some(row => row.path === 'setup'));
});

test('native folder picker accepts a folder and cancellation keeps the workspace', async t => {
  const root = workspace(t); let picked = null;
  const app = createReader({ root, picker: async () => picked }); await app.settle();
  app.click('reader-browse-folder'); await app.settle(); assert.equal(app.reader.base, root);
  picked = root + '/guides'; app.click('reader-browse-folder'); await app.settle();
  assert.equal(app.reader.base, root + '/guides'); assert.equal(app.reader.on, null);
});

test('menu controls clamp text size and Open in tab keeps the file and workspace context', async t => {
  const root = workspace(t), app = createReader({ root, properties: { overlay: 'reader-dialog' } }); await app.settle();
  app.find('reader-menu-popover').handlers.on_open_change(true, app.cx);
  assert.equal(app.reader.menuOpen, true);
  for (let i = 0; i < 30; i++) app.click('reader-larger');
  assert.equal(app.reader.fontSize, 23);
  for (let i = 0; i < 30; i++) app.click('reader-smaller');
  assert.equal(app.reader.fontSize, 12);
  app.click('reader-size-reset'); assert.equal(app.reader.fontSize, 16);
  app.reader.open('README.md', app.cx); await app.settle(); app.click('reader-tab');
  assert.equal(app.commands[0].name, 'tab.new');
  assert.equal(app.commands[0].args.props.cwd, root);
  assert.equal(app.commands[0].args.props.file, root + '/README.md');
  assert.deepEqual(app.commands[1], { close: 'reader-dialog' });
});

test('refresh updates the tree and search index, and reports missing files', async t => {
  const root = workspace(t), app = createReader({ root }); await app.settle();
  fs.writeFileSync(path.join(root, 'new.md'), '# New');
  app.click('reader-refresh'); await app.settle();
  assert.ok(app.reader.treeRows().some(row => row.path === 'new.md'));
  app.type('new'); assert.equal(app.reader.matches[0].path, 'new.md');
  app.reader.open('missing.md', app.cx); await app.settle();
  assert.match(app.reader.error, /File not found/);
});

test('a dropped local file keeps the remote search and tree context', async t => {
  const root = workspace(t), reads = [];
  const app = createReader({ root, properties: { on: 'server' }, fileRead: async (file, options) => { reads.push({ file, on: options.on }); return '# Local file'; } });
  await app.settle();
  app.reader.render().handlers.on_drop({ paths: [root + '/README.md'] }, app.cx); await app.settle();
  assert.equal(app.reader.on, 'server'); assert.equal(app.reader.fileOn, null);
  assert.deepEqual(reads[0], { file: root + '/README.md', on: null });
});

test('late file reads cannot replace the document after switching workspace', async t => {
  const root = workspace(t); let finish;
  const app = createReader({ root, fileRead: () => new Promise(resolve => { finish = resolve; }) }); await app.settle();
  app.reader.open('README.md', app.cx);
  await new Promise(resolve => setImmediate(resolve));
  app.reader.openFolder('guides', null, app.cx);
  await new Promise(resolve => setImmediate(resolve));
  finish('# Stale'); await app.settle();
  assert.equal(app.reader.base, root + '/guides');
  assert.equal(app.reader.file, null); assert.notEqual(app.reader.content, '# Stale');
});

test('file indexing preserves newlines in filenames', { skip: process.platform === 'win32' }, async t => {
  const root = workspace(t); fs.writeFileSync(path.join(root, 'line\nbreak.md'), '# unusual');
  const app = createReader({ root }); await app.settle();
  assert.ok(app.reader.files.some(entry => entry.path === 'line\nbreak.md'));
});

test('selected terminal context wins over the first terminal and the space folder', () => {
  const panes = [{ tab: 'tab', terminal: 't1', cwd: '/first' }, { tab: 'tab', terminal: 't2', cwd: '/selected', focused: true }];
  const spaces = [{ id: 'space', folder: '/space', active: true, machine: 'server' }];
  assert.deepEqual(folderContext({ cwd: '/live', tab: 'tab', terminal: 'server/t2' }, panes, spaces, '/home'), { cwd: '/live', on: 'server' });
  assert.equal(folderContext({ tab: 'tab' }, panes, spaces, '/home').cwd, '/selected');
  assert.deepEqual(folderContext({ cwd: '/local', terminal: 't3' }, panes, spaces, '/home'), { cwd: '/local', on: null });
  assert.deepEqual(folderContext(null, [], [], '/home'), { cwd: '/home', on: null });
});

test('folder paths resolve parents, home, drive roots and UNC shares', () => {
  assert.equal(search.resolvePath('../docs/./', '/work/project', '/home'), '/work/docs');
  assert.equal(search.resolvePath('~/notes', '/work', '/home'), '/home/notes');
  assert.equal(search.resolvePath('C:\\work\\..\\docs', '/work', '/home'), 'C:/docs');
  assert.equal(search.resolvePath('\\\\server\\share\\docs', '/work', '/home'), '//server/share/docs');
  assert.equal(search.resolvePath('/../../docs', '/work', '/home'), '/docs');
});

test('restores the document and reading controls for the same project after reopening', async t => {
  const root = workspace(t), storage = new Map();
  const first = createReader({ root, storage }); await first.settle();
  first.reader.open('guides/setup/install.md', first.cx); await first.settle();
  first.reader.toggleFolder('guides/setup', first.cx);
  first.reader.resizeText(3, first.cx);
  first.click('reader-toggle-tree');
  const reopened = createReader({ root, storage }); await reopened.settle();
  assert.match(reopened.reader.content, /^# Installation/);
  assert.equal(reopened.reader.fontSize, 19);
  assert.equal(reopened.reader.treeVisible, false);
  assert.ok(reopened.reader.expanded.has('guides'));
  assert.ok(!reopened.reader.expanded.has('guides/setup'));
});

test('folder changes restore each project independently and separate machines', async t => {
  const root = workspace(t), storage = new Map();
  const app = createReader({ root, storage }); await app.settle();
  app.reader.open('README.md', app.cx); await app.settle();
  app.reader.resizeText(4, app.cx);
  app.reader.openFolder('guides', null, app.cx); await app.settle();
  assert.equal(app.reader.file, null);
  app.reader.resizeText(-2, app.cx);
  app.reader.openFolder(root, null, app.cx); await app.settle();
  assert.equal(app.reader.file, root + '/README.md');
  assert.equal(app.reader.fontSize, 20);
  const remote = createReader({ root, storage, properties: { on: 'other-machine' } }); await remote.settle();
  assert.equal(remote.reader.file, null);
  assert.equal(remote.reader.fontSize, 16);
});

test('explicit file props override saved documents and failed opens do not replace saved files', async t => {
  const root = workspace(t), storage = new Map();
  const app = createReader({ root, storage }); await app.settle();
  app.reader.open('README.md', app.cx); await app.settle();
  app.reader.open('missing.md', app.cx); await app.settle();
  app.reader.resizeText(1, app.cx);
  const reopened = createReader({ root, storage }); await reopened.settle();
  assert.match(reopened.reader.content, /^# Project/);
  const explicit = createReader({ root, storage, properties: { file: 'guides/setup/install.md', fontSize: 13 } }); await explicit.settle();
  assert.match(explicit.reader.content, /^# Installation/);
  assert.equal(explicit.reader.fontSize, 13);
});
