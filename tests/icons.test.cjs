const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReader, iconFile, ICONS } = require('./support/reader-harness.cjs');

const DIR = 'mods/markdown-reader/vendor/material-icon-theme/icons/';
const icon = (...args) => iconFile(...args).slice(DIR.length, -'.svg'.length);

test('Markdown files get their named icon, then their extension icon', () => {
  assert.equal(icon('README.md', false, false, true), 'readme');
  assert.equal(icon('guides/CHANGELOG.md', false, false, true), 'changelog');
  assert.equal(icon('guides/install.md', false, false, true), 'markdown');
  assert.equal(icon('page.mdx', false, false, true), 'mdx');
  assert.equal(icon('button.stories.mdx', false, false, true), 'storybook');
});

test('folders get their named icon, open or closed, and the plain folder otherwise', () => {
  assert.equal(icon('docs', true, false, true), 'folder-docs');
  assert.equal(icon('docs', true, true, true), 'folder-docs-open');
  assert.equal(icon('guides/_Docs', true, false, true), 'folder-docs');
  assert.equal(icon('.github/workflows', true, false, true), 'folder-gh-workflows');
  assert.equal(icon('notes-for-me', true, false, true), 'folder');
  assert.equal(icon('notes-for-me', true, true, true), 'folder-open');
});

test('a light appearance uses the light variants', () => {
  assert.equal(icon('warp.md', false, false, false), 'warp_light');
  assert.equal(icon('warp.md', false, false, true), 'warp');
  assert.equal(icon('cursor', true, true, false), 'folder-cursor-open_light');
  assert.equal(icon('docs', true, false, false), 'folder-docs');
});

test('folders named like Object properties match only table names', () => {
  for (const name of ['constructor', '_tostring', 'hasOwnProperty']) {
    assert.equal(icon(name, true, false, true), 'folder');
    assert.equal(icon(name, true, true, false), 'folder-open');
  }
  assert.equal(icon('__proto__', true, false, true), 'folder-proto');
});

test('every icon in the table is vendored, open folders included', () => {
  const root = path.join(__dirname, '..');
  const vendored = id => assert.ok(fs.existsSync(path.join(root, DIR + id + '.svg')), id);
  const ids = table => [table.fileNames, table.fileExtensions].flatMap(Object.values);
  const folders = [ICONS.folder, ...Object.values(ICONS.folderNames), ...Object.values(ICONS.light.folderNames)];
  for (const id of [ICONS.file, ...ids(ICONS), ...ids(ICONS.light), ...folders]) vendored(id);
  for (const name of ['x', ...Object.keys(ICONS.folderNames), ...Object.keys(ICONS.light.folderNames)]) vendored(icon(name, true, true, false));
});

test('the tree and search results draw the Material icons', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-icons-')).replaceAll('\\', '/');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'README.md'), '# Project');
  fs.writeFileSync(path.join(root, 'docs/guide.md'), '# Guide');
  const app = createReader({ root }); await app.settle();
  assert.ok(app.find(DIR + 'folder-docs.svg'));
  assert.ok(app.find(DIR + 'readme.svg'));
  app.find('reader-tree').handlers.on_item_click('docs', app.cx); await app.settle();
  assert.ok(app.find(DIR + 'folder-docs-open.svg'));
  assert.ok(app.find(DIR + 'markdown.svg'));
  app.type('guide'); await app.settle();
  assert.equal(app.find('reader-search-results').kids.length, 1);
  assert.ok(app.find(DIR + 'markdown.svg', app.find('reader-search-results')));
});

test('the tree draws light variants in a light appearance', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-icons-')).replaceAll('\\', '/');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'cursor'));
  fs.writeFileSync(path.join(root, 'warp.md'), '# Warp');
  const app = createReader({ root, appearance: { dark: false, font_family: 'Mono' } }); await app.settle();
  assert.ok(app.find(DIR + 'folder-cursor_light.svg'));
  assert.ok(app.find(DIR + 'warp_light.svg'));
});
