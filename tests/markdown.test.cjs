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

// A code block is the box with the code background; dark is the harness default.
const codeBlocks = app => nodes(app, node => node.styles.bg === '#151b23');

test('draws fenced code as rows of syntax-colored text', async t => {
  const app = await open(t, '```ts\nconst a = 1;\n\n// done\n```\n\n- item\n\n  ```\n  nested\n  ```');
  assert.equal(word(app, 'const').styles.text_color, '#ff7b72');
  assert.deepEqual([word(app, '// ').styles.text_color, word(app, 'done').styles.text_color], ['#9198a1', '#9198a1']);
  const [block] = codeBlocks(app);
  assert.equal(block.kids.length, 3);
  assert.deepEqual([block.kids[1].kids.length, block.kids[1].styles.min_h], [0, 21]);
  assert.ok(word(app, 'nested'));
});

test('draws a code line longer than the tokenizer reads once', async t => {
  const line = 'const s = "' + 'a'.repeat(700) + '"; done';
  const app = await open(t, '```js\n' + line + '\n```');
  assert.equal(codeBlocks(app)[0].kids[0].kids.map(text).join(''), line);
});

test('splits a long code block into list items that draw as one block', async t => {
  const lines = Array.from({ length: 130 }, (_, i) => `line ${i}`).join('\n');
  const app = await open(t, '```\n' + lines + '\n```');
  assert.deepEqual(app.reader.doc.items.filter(item => item.code).map(item => item.from), [0, 60, 120]);
  const blocks = codeBlocks(app);
  assert.deepEqual(blocks.map(block => block.kids.length), [60, 60, 10]);
  assert.deepEqual(blocks.map(block => ['rounded_t' in block.styles, 'rounded_b' in block.styles]), [[true, false], [false, false], [false, true]]);
});

test('lexes long documents in chunks without breaking fences or reference links', async t => {
  const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some words to fill the chunk.`).join('\n\n');
  const app = await open(t, `See [the site][ref].\n\n${filler}\n\n\`\`\`\nfirst\n\nNot a heading\n\`\`\`\n\n${filler}\n\n[ref]: https://example.com`);
  assert.equal(word(app, 'site').styles.href, 'https://example.com');
  assert.equal(app.reader.doc.items.find(item => item.code).code.text, 'first\n\nNot a heading');
  assert.equal(app.reader.words, 3 + 2 * 40 * 9 + 6 + 2);
});

test('draws code at the new text size', async t => {
  const app = await open(t, '```\nx\n```');
  app.reader.resizeText(1, app.cx); await app.settle();
  assert.deepEqual([codeBlocks(app)[0].styles.text_size, codeBlocks(app)[0].kids[0].styles.min_h], [14, 21]);
});

test('draws code with the light palette when the appearance changes', async t => {
  const appearance = { dark: true, font_family: 'Mono' };
  const app = await open(t, '```js\nconst x\n```', { appearance });
  appearance.dark = false;
  assert.equal(app.reader.rebuild(app.cx), true); await app.settle();
  assert.equal(word(app, 'const').styles.text_color, '#cf222e');
  assert.equal(app.reader.rebuild(app.cx), false);
});

test('keeps a build error through background reloads instead of an older document', async t => {
  const app = await open(t, '# Alpha doc');
  fs.writeFileSync(path.join(app.root, 'doc.md'), '```boom\nx\n```');
  app.reader.load(app.cx); await app.settle();
  app.reader.load(app.cx, true); await app.settle();
  assert.equal(app.reader.buildError, 'Cannot lex boom');
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
  assert.equal(app.reader.doc.items.filter(item => item.code).length, Math.ceil(402 / 60));
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
  assert.ok(word(app, 'b'));
  assert.equal(word(app, 'a'), undefined);
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
