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

// The quote box of the first alert and the svg icon inside it.
const alertBox = app => nodes(app, node => node.type === 'column' && 'border_l' in node.styles)[0];
const icon = app => nodes(app, node => node.type === 'svg')[0];

test('draws the five GitHub alerts with their own title, icon and color', async t => {
  const kinds = [['NOTE', 'Note', 'info', '#1f6feb', '#4493f8'], ['TIP', 'Tip', 'light-bulb', '#238636', '#3fb950'],
    ['IMPORTANT', 'Important', 'report', '#8957e5', '#ab7df8'], ['WARNING', 'Warning', 'alert', '#9e6a03', '#d29922'],
    ['CAUTION', 'Caution', 'stop', '#da3633', '#f85149']];
  for (const [marker, title, file, border, color] of kinds) {
    const app = await open(t, `> [!${marker}]\n> Read **this**.`);
    assert.equal(alertBox(app).styles.border_color, border);
    assert.equal(icon(app).elementId, `mods/markdown-reader/vendor/octicons/${file}.svg`);
    assert.equal(word(app, title).styles.text_color, color);
    assert.equal(word(app, 'this').styles.font_weight, 600);
    assert.equal(nodes(app, node => /\[!/.test(text(node))).length, 0);
  }
});

test('reads an alert marker in any case, with the body after a blank quote line', async t => {
  const app = await open(t, '> [!warning]  \n>\n> Body text.', { appearance: { dark: false } });
  assert.equal(alertBox(app).styles.border_color, '#9a6700');
  assert.ok(word(app, 'Warning'));
  assert.ok(word(app, 'Body'));
});

test('keeps a quote plain when its marker has text beside it, no body, or sits in a list', async t => {
  const sources = ['> [!NOTE] inline text', '> [!NOTE]', '- item\n\n  > [!NOTE]\n  > nested', '> > [!NOTE]\n> > nested',
    '> [!NOTICE]\n> body'];
  for (const source of sources) {
    const app = await open(t, source);
    assert.equal(icon(app), undefined, source);
    assert.ok(nodes(app, node => /\[!NOT/.test(text(node))).length, source);
  }
});

test('cuts the marker from an alert body too long to style', async t => {
  const app = await open(t, `> [!TIP]\n> ${'long '.repeat(2000)}`);
  assert.ok(word(app, 'Tip'));
  assert.equal(nodes(app, node => /\[!/.test(text(node))).length, 0);
});

test('draws emoji shortcodes in text, links, headings and tables', async t => {
  const app = await open(t, '# Hi :wave:\n\nShip :+1: :white_check_mark: [go :rocket:](https://example.com)\n\n| A |\n| - |\n| :fire: |');
  assert.ok(word(app, '👋') && word(app, '👍') && word(app, '✅') && word(app, '🔥'));
  assert.equal(word(app, '🚀').styles.href, 'https://example.com');
});

test('keeps unknown shortcodes, code and autolink addresses as written', async t => {
  const app = await open(t, ':nope: :SMILE: `:smile:` <https://example.com/:smile:>');
  assert.ok(word(app, ':nope:') && word(app, ':SMILE:') && word(app, ':smile:'));
  assert.ok(word(app, 'https://example.com/:smile:'));
});

// The footnote items, after the document's own blocks: rows in the 12 px footnote text.
const notes = app => nodes(app, node => node.type === 'row' && node.styles.text_size === 12);
const has = (node, value) => nodes(null, child => text(child) === value, node).length;
const refs = app => nodes(app, node => /^\[\d+\]$/.test(text(node))).map(text);

test('numbers footnotes by first ref and keeps undefined refs as text', async t => {
  const app = await open(t, 'One[^b] two[^A] three[^b] four[^zz].\n\n[^a]: Note A.\n[^b]: Note B.\n[^unused]: Never shown.');
  assert.deepEqual(refs(app), ['[1]', '[2]', '[1]']);
  assert.ok(word(app, 'four[^zz].'));
  const [first, second] = notes(app);
  assert.ok(has(first, 'B.') && has(second, 'A.'));
  assert.equal(notes(app).length, 2);
  assert.equal(nodes(app, node => text(node) === 'Never').length, 0);
});

test('draws footnotes under a rule, with superscript refs and links back', async t => {
  const app = await open(t, 'One[^a] two[^a]\n\n[^a]: Note\n    more');
  const ref = word(app, '[1]');
  assert.ok('relative' in ref.styles && ref.styles.text_color === '#4493f8' && ref.styles.text_size === 12);
  const [note] = notes(app);
  assert.equal(note.styles.border_t, 1);
  assert.ok(has(note, 'more'));
  assert.equal(has(note, '↩'), 2);
  assert.ok(has(note, '2'));
});

test('does not number escaped refs or refs in autolinks and HTML', async t => {
  const app = await open(t, 'A \\[^1] <https://x.example/[^1]> <span title="[^1]">s</span> B[^2]\n\n[^1]: one\n[^2]: two');
  assert.deepEqual(refs(app), ['[1]']);
  assert.equal(notes(app).length, 1);
  assert.ok(has(notes(app)[0], 'two'));
});

test('reads a footnote that cuts a paragraph, sits in a quote, or starts on the next line', async t => {
  const app = await open(t, 'Para[^a] text\n[^a]: cuts in\n\n> quote[^c]\n\n> [^c]: in quote\n\nLast[^d]\n\n[^d]:\n\n    - listed');
  assert.equal(nodes(app, node => /^\[\^/.test(text(node))).length, 0);
  const [a, c, d] = notes(app);
  assert.ok(has(a, 'cuts') && has(c, 'quote') && has(d, 'listed') && has(d, '↩'));
});

test('ends a footnote at a block that is not lazy paragraph text', async t => {
  for (const [source, outside] of [['[^1]: text\n***\nafter', 'after'], ['[^1]:\nfoo', 'foo'],
    ['[^1]: x\n    ```\n    code\n    ```\nlazy', 'lazy'], ['[^1]: x\n    ```\n    code\nlazy', 'lazy'], ['[^1]: text\n<div>x</div>', 'x']]) {
    const app = await open(t, 'A[^1]\n\n' + source);
    assert.equal(has(notes(app)[0], outside), 0, source);
    assert.ok(word(app, outside), source);
  }
  const app = await open(t, 'A[^1]\n\n[^1]: text\nlazy line');
  assert.ok(has(notes(app)[0], 'lazy'));
});
