const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReader } = require('./support/reader-harness.cjs');

function document(t, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-markdown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'doc.md'), text);
  return root.replaceAll('\\', '/');
}

async function open(t, text, options = {}) {
  const root = document(t, text);
  const app = createReader({ root, properties: { file: root + '/doc.md' }, ...options });
  await app.settle();
  return { ...app, root };
}

// Every node under the document that matches, depth first.
function nodes(app, match, node = app.find('reader-document-' + app.reader.loadedFile + '-area'), out = []) {
  if (!node || typeof node !== 'object') return out;
  if (match(node)) out.push(node);
  for (const child of node.kids) nodes(app, match, child, out);
  return out;
}

const text = node => node.kids.filter(child => typeof child === 'string').join('');
const word = (app, value) => nodes(app, node => text(node) === value)[0];

test('draws inline styles as separate words', async t => {
  const app = await open(t, 'Plain **bold** *italic* ~~gone~~ `a b` [site](https://example.com).');
  assert.equal(word(app, 'bold').styles.font_weight, 600);
  assert.ok('italic' in word(app, 'italic').styles);
  assert.ok('line_through' in word(app, 'gone').styles);
  assert.equal(word(app, 'a b').styles.font_family, 'Mono');
  assert.equal(word(app, 'site').styles.text_color, '#4493f8');
  assert.ok(word(app, 'Plain'));
});

test('keeps code span entities literal and opens a badge link target', async t => {
  const app = await open(t, '`&lt;b&gt;` [![build](https://img.example/x.svg)](https://ci.example)');
  assert.ok(word(app, '&lt;b&gt;'));
  assert.equal(word(app, 'build').styles.href, 'https://ci.example');
});

test('hides HTML comments, breaks on <br> and keeps the text inside inline tags', async t => {
  const app = await open(t, '<!-- hidden -->\n\nPress <kbd>K</kbd> now<br>next');
  assert.equal(nodes(app, node => /hidden/.test(text(node))).length, 0);
  assert.ok(word(app, 'K'));
  assert.equal(nodes(app, node => /kbd|<br>/.test(text(node))).length, 0);
  assert.ok(nodes(app, node => node.styles.h === 0 && 'w_full' in node.styles).length);
});

test('opens web links natively and leaves other links as text', async t => {
  const app = await open(t, '[site](https://example.com) and [local](other.md)');
  assert.deepEqual([word(app, 'site').type, word(app, 'site').styles.href], ['link', 'https://example.com']);
  assert.equal(word(app, 'local').type, 'div');
});

test('splits long lists and tables into one lazy list item each', async t => {
  const app = await open(t, '# Title\n\n- a\n- b\n- c\n\n| H |\n| - |\n| 1 |\n| 2 |');
  assert.equal(app.find('reader-document-' + app.reader.loadedFile).keys.length, 1 + 3 + 3);
});

test('underlines the two top heading levels only', async t => {
  const app = await open(t, '# One\n\n## Two\n\n### Three');
  const heading = value => nodes(app, node => node.styles.line_height === 1.25).find(node => nodes(app, n => text(n) === value, node).length);
  assert.equal(heading('One').styles.border_b, 1);
  assert.equal(heading('Two').styles.border_b, 1);
  assert.equal(heading('Three').styles.border_b, undefined);
});

test('draws task lists, ordered markers and table cells', async t => {
  const app = await open(t, '- [x] done\n- [ ] open\n\n0. zero\n1. one\n\n| A | B |\n| - | -: |\n| 1 | 2 |');
  assert.ok(word(app, '✓'));
  assert.ok(word(app, 'done') && word(app, 'open'));
  assert.ok(word(app, '0.') && word(app, '1.'));
  assert.ok(word(app, 'A') && word(app, '2'));
});

test('gives fenced code a highlighted read-only view and releases it on change', async t => {
  const app = await open(t, '```ts\nconst a = 1;\n```');
  const editor = app.editors.at(-1);
  assert.deepEqual([editor.options.language, editor.options.value, editor.options.readonly], ['js', 'const a = 1;', true]);
  assert.deepEqual(nodes(app, node => node.type === 'editor').map(node => node.state), [editor]);
  fs.writeFileSync(path.join(app.root, 'doc.md'), 'No code now.');
  app.reader.load(app.cx); await app.settle();
  assert.equal(editor.released, true);
  assert.equal(nodes(app, node => node.type === 'editor').length, 0);
});

test('sizes a code view to the rows its soft wrap makes at the measured width', async t => {
  const app = await open(t, '```\naaaa bbbb cccc dddd eeee ffff\n```');
  const area = () => app.find('reader-document-' + app.reader.loadedFile + '-area');
  const height = () => nodes(app, node => node.type === 'editor')[0].styles.h;
  assert.equal(app.editors.at(-1).options.soft_wrap, true);
  assert.equal(height(), 21);
  // 16 px text: 14 px code at an 8.4 px advance fits 22 columns inside 28 px page and 16 px block padding.
  area().handlers.on_size_change({ width: 56 + 32 + 8.4 * 22 + 1 }, app.cx);
  assert.equal(height(), 42);
});

test('lexes long documents in chunks without breaking fences or reference links', async t => {
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some words to fill the chunk.`).join('\n\n');
  const app = await open(t, `See [the site][ref].\n\n${filler}\n\n\`\`\`\nfirst\n\nNot a heading\n\`\`\`\n\n${filler}\n\n[ref]: https://example.com`);
  assert.equal(word(app, 'site').styles.href, 'https://example.com');
  assert.equal(app.editors.at(-1).options.value, 'first\n\nNot a heading');
  assert.equal(app.reader.words, 3 + 2 * 40 * 9 + 6 + 2);
});

test('rebuilds code views at the new text size', async t => {
  const app = await open(t, '```\nx\n```');
  const before = app.editors.at(-1);
  app.reader.resizeText(1, app.cx); await app.settle();
  assert.equal(before.released, true);
  assert.equal(app.editors.at(-1).options.font_size, 14);
});

test('rebuilds code views with the light palette when the appearance changes', async t => {
  const appearance = { dark: true, font_family: 'Mono' };
  const app = await open(t, '```\nx\n```', { appearance });
  const dark = app.editors.at(-1);
  appearance.dark = false;
  assert.equal(app.reader.rebuild(app.cx), true); await app.settle();
  assert.equal(dark.released, true);
  assert.equal(app.editors.at(-1).options.syntax.keyword, '#cf222e');
  assert.equal(app.reader.rebuild(app.cx), false);
});

test('keeps the measured width for code views across rebuilds', async t => {
  const app = await open(t, '```\naaaa bbbb cccc dddd eeee ffff\n```');
  app.find('reader-document-' + app.reader.loadedFile + '-area').handlers.on_size_change({ width: 56 + 32 + 8.4 * 22 + 1 }, app.cx);
  app.reader.resizeText(1, app.cx); await app.settle();
  app.reader.resizeText(-1, app.cx); await app.settle();
  assert.equal(nodes(app, node => node.type === 'editor')[0].styles.h, 42);
});

test('keeps a build error through background reloads instead of an older document', async t => {
  const app = await open(t, '# Alpha doc');
  fs.writeFileSync(path.join(app.root, 'doc.md'), '```boom\nx\n```');
  app.reader.load(app.cx); await app.settle();
  app.reader.load(app.cx, true); await app.settle();
  assert.equal(app.reader.buildError, 'Cannot highlight boom');
  assert.equal(app.reader.doc, null);
  assert.equal(app.find('reader-document-' + app.reader.loadedFile + '-area'), null);
});

test('draws list markers as a disc, a circle and a square in the text color', async t => {
  const app = await open(t, '- one\n  - two\n    - three');
  const markers = nodes(app, node => node.styles.size === 5);
  assert.deepEqual(markers.map(marker => [marker.styles.bg, marker.styles.border_color, 'rounded' in marker.styles]),
    [['#f0f6fc', undefined, true], [undefined, '#f0f6fc', true], ['#f0f6fc', undefined, false]]);
});

test('draws a loose task list without its source markers', async t => {
  const app = await open(t, '- [x] done\n\n- [ ] open');
  assert.equal(nodes(app, node => /\[/.test(text(node))).length, 0);
  assert.ok(word(app, '✓') && word(app, 'done'));
});

test('keeps a long list numbered from one whole across chunk boundaries', async t => {
  const app = await open(t, Array.from({ length: 80 }, (_, i) => `1. item ${i} with a few more words`).join('\n'));
  assert.ok(word(app, '80.'));
  assert.equal(app.reader.doc.lexer.tokens.filter(token => token.type === 'list').length, 1);
});

test('shows a region too long to lex in one slice as plain text pieces', async t => {
  const rows = Array.from({ length: 400 }, (_, i) => `| row ${i} | some cell text here | more |`).join('\n');
  const app = await open(t, `| a | b | c |\n| - | - | - |\n${rows}`);
  assert.equal(nodes(app, node => node.type === 'editor').length, Math.ceil(402 / 60));
  assert.equal(word(app, 'row'), undefined);
});

test('drops a build that a newer one replaced', async t => {
  const app = await open(t, 'start');
  const now = Date.now; let clock = now();
  Date.now = () => (clock += 40); t.after(() => { Date.now = now; });
  app.reader.content = 'A\n\n```\na\n```'; app.reader.rebuild(app.cx);
  app.reader.content = 'B\n\n```\nb\n```'; app.reader.rebuild(app.cx);
  await app.settle();
  assert.equal(app.reader.doc.text, 'B\n\n```\nb\n```');
  assert.ok(app.editors.filter(editor => !editor.released).every(editor => editor.options.value === 'b'));
});

test('lexes in chunks exactly as marked lexes the whole text', async t => {
  const app = await open(t, 'x');
  const { lexDocument } = app.markdown;
  const fixture = [
    '# Title', 'Intro with [a reference][r] and <a href="https://example.com">inline html</a>.',
    Array.from({ length: 30 }, (_, i) => `- loose item ${i} with some words`).join('\n\n'),
    Array.from({ length: 120 }, (_, i) => `1. numbered ${i} with filler words`).join('\n'),
    '- ```sh\n  first line of output\n\nSecond unindented line\n  ```',
    '<!--\na comment\n\nwith a blank line\n-->', '<pre>\npre text\n\nmore\n</pre>',
    '```js\n' + 'code line\n\nunindented after blank\n'.repeat(80) + '```',
    '| a | b |\n| - | - |\n' + Array.from({ length: 50 }, (_, i) => `| ${i} | cell |`).join('\n'),
    '> quote\n> more', 'Setext\n===', '    indented code\n\n    more', '[r]: https://example.com',
  ].join('\n\n');
  const repo = path.join(__dirname, '..');
  const samples = [fixture, ...['README.md', 'RECIPE.md', 'mods/markdown-reader/README.md'].map(file => fs.readFileSync(path.join(repo, file), 'utf8'))];
  const resolve = (lexer, value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && value.pending !== undefined) { lexer.state.inRawBlock = false; lexer.inlineTokens(value.pending, value); delete value.pending; }
    for (const child of Object.values(value)) resolve(lexer, child);
  };
  const shape = tokens => JSON.stringify(tokens.filter(token => token.type !== 'space'), (key, value) => ['raw', 'weights'].includes(key) ? undefined : value);
  for (const sample of samples) {
    const doc = await lexDocument(sample, 'k', async () => {}, () => false);
    resolve(doc.lexer, doc.lexer.tokens);
    assert.equal(shape(doc.lexer.tokens), shape(app.Lexer.lex(sample, { gfm: true })));
  }
});
