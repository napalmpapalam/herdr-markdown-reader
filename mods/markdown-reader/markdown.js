// Draws a Markdown document as native elements in GitHub's style.
import { div, list, svg } from "gpui-kit";
import { h_flex, v_flex, Link, Scrollbar } from "gpui-base";
import { languageOf, tokenize } from "./highlight.js";
import { Lexer } from "./vendor/marked.esm.js";
import EMOJI from "./vendor/gemoji/table.js";

// GitHub's own colors (github-markdown-css), so documents look like github.com.
const PALETTE = {
  dark: {
    fg: "#f0f6fc", muted: "#9198a1", accent: "#4493f8", canvas: "#0d1117", subtle: "#151b23",
    code: "#656c7633", border: "#3d444d", borderMuted: "#3d444db3", checked: "#1f6feb",
    syntax: { keyword: "#ff7b72", string: "#a5d6ff", comment: "#9198a1", function: "#d2a8ff", type: "#ffa657",
      number: "#79c0ff", boolean: "#79c0ff", variable: "#ffa657" },
    alerts: { note: ["#1f6feb", "#4493f8"], tip: ["#238636", "#3fb950"], important: ["#8957e5", "#ab7df8"],
      warning: ["#9e6a03", "#d29922"], caution: ["#da3633", "#f85149"] },
  },
  light: {
    fg: "#1f2328", muted: "#59636e", accent: "#0969da", canvas: "#ffffff", subtle: "#f6f8fa",
    code: "#818b981f", border: "#d1d9e0", borderMuted: "#d1d9e0b3", checked: "#0969da",
    syntax: { keyword: "#cf222e", string: "#0a3069", comment: "#59636e", function: "#6639ba", type: "#953800",
      number: "#0550ae", boolean: "#0550ae", variable: "#953800" },
    alerts: { note: ["#0969da", "#0969da"], tip: ["#1a7f37", "#1a7f37"], important: ["#8250df", "#8250df"],
      warning: ["#9a6700", "#9a6700"], caution: ["#cf222e", "#d1242f"] },
  },
};

// GitHub's -apple-system stack. The app's default UI font may ship one face only, which drops bold and italic.
const PROSE_FONT = ".SystemUIFont";
// Code rows per list item, so a long block costs only its visible part.
const CODE_LINES = 60;
const codeSize = fontSize => Math.round(fontSize * 0.85);
// The width of a quote's left border and the height of a rule: .25em, at least 3 px.
const ruleSize = fontSize => Math.max(3, fontSize * 0.25);
const MAX_WIDTH = 820, EDGE = 18, SLICE_MS = 30;
const HEADING_SIZES = [2, 1.5, 1.25, 1, 0.875, 0.85];
// The share of the text size that GitHub gives to footnotes (12 px) and to superscripts.
const SMALL = 0.75;
// GitHub alerts: title and octicon per kind; colors are `alerts` in PALETTE, [border, title].
const ALERTS = {
  note: { title: "Note", icon: "info" }, tip: { title: "Tip", icon: "light-bulb" },
  important: { title: "Important", icon: "report" }, warning: { title: "Warning", icon: "alert" },
  caution: { title: "Caution", icon: "stop" },
};
const ALERT_MARKER = new RegExp(`^\\[!(${Object.keys(ALERTS).join("|")})\\][ \\t]*(?:\\n|$)`, "i");
const OCTICONS = "mods/markdown-reader/vendor/octicons";
// GitHub's emoji shortcodes, `:name:`, in text outside code.
const SHORTCODE = /:([a-z0-9_+-]+):/g;
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", mdash: "—", ndash: "–", hellip: "…" };

function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

const emojify = text => text.replace(SHORTCODE, (match, name) => EMOJI[name] ?? match);

// The text of raw HTML: GitHub-style HTML is not drawn, and comments disappear.
function htmlText(html) {
  return decode(html.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/<[^>]*>/g, "")).trim();
}

function visit(tokens, callback) {
  for (const token of tokens || []) {
    callback(token);
    visit(token.tokens, callback);
    for (const item of token.items || []) visit(item.tokens, callback);
  }
}

// Chunk boundaries: a blank line before an unindented line, which always starts a new block.
// Prefer CHUNK characters, and don't cut before a list marker until LONG, so lists stay whole.
// A fence or HTML block cut open is carried into the next chunk (`lexChunk`).
const CHUNK = 2000, LONG = 8000;
const BLANK = /^[ \t]*$/, LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
function* chunks(text) {
  const lines = text.split("\n");
  let start = 0, size = 0;
  for (let i = 1; i < lines.length; i++) {
    size += lines[i - 1].length + 1;
    const line = lines[i];
    if (size < CHUNK || !/^\S/.test(line) || !BLANK.test(lines[i - 1]) || (size < LONG && LIST_MARKER.test(line))) continue;
    yield lines.slice(start, i).join("\n") + "\n";
    start = i; size = 0;
  }
  yield lines.slice(start).join("\n");
}

// Herdr stops a script slice that runs for about a second, and marked in QuickJS is slow: ~4 ms per KB
// for blocks, more for inline text, and far worse on one long string (50 KB did not end).
// So lex block chunks with one shared lexer, as `Lexer.lex` does, which keeps link definitions
// shared; pause between slices; and leave inline text to `inlined`, for the blocks that get drawn.
// A region that stays longer than HARD, or inline text longer than INLINE, is shown as plain text.
// Resolves to null once `stale()` is true.
const HARD = 16000, INLINE = 8000;
export async function lexDocument(text, key, pause, stale) {
  const lexer = new Lexer({ gfm: true, extensions: FOOTNOTES }), slice = { at: Date.now() };
  let words = 0, carry = "";
  for (const chunk of chunks(text.replace(/\r\n?/g, "\n"))) {
    carry = lexChunk(lexer, carry + chunk);
    words += (chunk.match(/\S+/g) || []).length;
    if (!(await breathe(slice, pause, stale))) return null;
  }
  if (carry) lexChunk(lexer, carry, true);
  for (const token of lexer.tokens) if (token.type === "blockquote") markAlert(token, lexer.inlineQueue);
  const notes = numberFootnotes(lexer);
  for (const next of lexer.inlineQueue) {
    if (next.src.length > INLINE) next.tokens.push({ type: "text", raw: next.src, text: next.src });
    else next.tokens.pending = next.src;
  }
  lexer.inlineQueue = [];
  visit(lexer.tokens, token => {
    if (token.type === "table") token.weights = columnWeights(token);
  });
  return { items: documentItems(lexer.tokens, notes), lexer, words, text, key };
}

async function breathe(slice, pause, stale) {
  if (Date.now() - slice.at > SLICE_MS) { await pause(); slice.at = Date.now(); }
  return !stale();
}

// Lexes one chunk and returns what to carry into the next: a last block whose fence or HTML block
// ends past the chunk, also inside a list item or quote. Inline work a dropped list queued is never
// drawn: its token arrays go with it.
function lexChunk(lexer, source, final = false) {
  if (source.length > HARD) { plain(lexer.tokens, source); return ""; }
  const count = lexer.tokens.length;
  lexer.blockTokens(source, lexer.tokens);
  const last = lexer.tokens.at(-1);
  if (final || lexer.tokens.length === count || !last || !unclosed(last)) return "";
  lexer.tokens.pop();
  return last.raw;
}

function unclosed(token) {
  if (token.type === "list") return unclosed(token.items.at(-1)?.tokens.findLast(child => child.type !== "space") || {});
  if (token.type === "blockquote") return unclosed(token.tokens.findLast(child => child.type !== "space") || {});
  if (token.type === "code") {
    const fence = token.raw.match(/^ {0,3}(`{3,}|~{3,})/);
    return Boolean(fence) && !new RegExp(`\\n {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*\\n*$`).test(token.raw);
  }
  if (token.type !== "html") return false;
  const raw = token.raw.trimStart(), tag = raw.match(/^<(pre|script|style|textarea)[\s>]/i);
  if (tag) return !new RegExp(`</${tag[1]}>`, "i").test(raw);
  return (raw.startsWith("<!--") && !raw.includes("-->")) || (raw.startsWith("<?") && !raw.includes("?>"))
    || (raw.startsWith("<![CDATA[") && !raw.includes("]]>")) || (/^<![A-Za-z]/.test(raw) && !raw.includes(">"));
}

// GitHub draws a quote as an alert when its first line is only `[!KIND]` and a body follows.
// Only top-level quotes: GitHub doesn't draw alerts inside lists or other quotes.
// Runs before the inline queue is read, so the marker is cut from the text that gets lexed.
function markAlert(quote, queue) {
  const first = quote.tokens[0], match = first?.type === "paragraph" && first.text.match(ALERT_MARKER);
  if (!match) return;
  const rest = first.text.slice(match[0].length), body = rest.trim();
  if (!body && !shown(quote.tokens.slice(1)).length) return;
  quote.alert = match[1].toLowerCase();
  if (!body) { quote.tokens.shift(); return; }
  first.text = rest;
  queue.find(next => next.tokens === first.tokens).src = rest;
}

// GitHub's footnotes: `[^label]` refs and `[^label]: text` definitions anywhere, labels in any case.
// A definition keeps the lines indented by four spaces or a tab, also after blank lines, and the lazy
// lines that continue its paragraph; it can cut a paragraph short. The first one of a label counts.
const LABEL = "\\[\\^([^\\]\\s]+)\\]";
const FOOTNOTE = new RegExp(`^ {0,3}${LABEL}:`), FOOTNOTE_REF = new RegExp(`^${LABEL}`), FOOTNOTE_REFS = new RegExp(LABEL, "g");
const FOOTNOTE_START = new RegExp(`\\n {0,3}${LABEL}:`);
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|1[.)][ \t]|```|~~~|<[A-Za-z/!?]|(?:[-*_][ \t]*){3,}$)/;
const INDENTED = /^(?: {4}|\t)/, FENCE = /^ {0,3}(?:```|~~~)/;
const FOOTNOTES = {
  block: [function footnoteDef(source) {
    const match = source.match(FOOTNOTE);
    if (!match) return;
    const lines = source.split("\n"), body = [lines[0].slice(match[0].length).trimStart()];
    let end = 1, fenced = FENCE.test(body[0]);
    while (end < lines.length) {
      const line = noteLine(lines[end], body.at(-1), fenced);
      if (line === null) break;
      if (FENCE.test(line)) fenced = !fenced;
      body.push(line);
      end++;
    }
    const lexer = this.lexer, top = lexer.state.top, note = { type: "footnote", raw: lines.slice(0, end).join("\n"), tokens: [] };
    if (end < lines.length) note.raw += "\n";
    lexer.state.top = true;
    lexer.blockTokens(body.join("\n"), note.tokens);
    lexer.state.top = top;
    const notes = lexer.footnotes ??= new Map(), label = match[1].toLowerCase();
    if (!notes.has(label)) notes.set(label, note);
    return note;
  }],
  startBlock: [source => {
    const at = source.search(FOOTNOTE_START);
    return at < 0 ? undefined : at + 1;
  }],
  // A ref without a numbered definition stays text.
  inline: [function footnoteRef(source) {
    const match = source.match(FOOTNOTE_REF), note = match && this.lexer.footnotes?.get(match[1].toLowerCase());
    if (note?.number) return { type: "footnoteRef", raw: match[0], note };
  }],
};

// A line after a definition's first line as the definition keeps it, or null where the definition
// ends. A lazy line needs open paragraph text before it: not a blank line, a fence or a fenced line.
function noteLine(line, previous, fenced) {
  if (BLANK.test(line)) return "";
  if (INDENTED.test(line)) return line.replace(INDENTED, "");
  const paragraph = Boolean(previous.trim()) && !fenced && !FENCE.test(previous);
  const lazy = paragraph && !FOOTNOTE.test(line) && !BLOCK_START.test(line);
  return lazy ? line : null;
}

// Numbers the defined footnotes by their first ref, in document order, before any inline text is lexed,
// and counts each one's refs. Code spans, HTML, autolinks and escaped brackets hold no refs.
// Returns the notes in number order.
function numberFootnotes(lexer) {
  const notes = lexer.footnotes, order = [];
  if (!notes) return order;
  for (const next of lexer.inlineQueue) {
    if (next.src.length > INLINE) continue;
    for (const [, label] of next.src.replace(/(`+)[\s\S]*?\1|<[^>\n]*>|\\./g, "").matchAll(FOOTNOTE_REFS)) {
      const note = notes.get(label.toLowerCase());
      if (!note) continue;
      if (!note.number) { order.push(note); note.number = order.length; }
      note.refs = (note.refs || 0) + 1;
    }
  }
  return order;
}

// Too long to lex in one slice: monospaced text.
function plain(tokens, source) {
  const text = source.replace(/\n+$/, "");
  tokens.push({ type: "code", raw: text, text, lang: "" });
}

// Inline tokens, lexed the first time a block is drawn, with the lexer state `Lexer.lex` resets.
function inlined(tokens, ctx) {
  if (tokens.pending !== undefined) {
    ctx.lexer.state.inRawBlock = false;
    ctx.lexer.state.inLink = false;
    ctx.lexer.inlineTokens(tokens.pending, tokens);
    delete tokens.pending;
  }
  return tokens;
}

// Top-level blocks for the lazy list. Lists and tables split into one item per list item and row,
// code into CODE_LINES rows per item, so a long one costs only its visible part. Footnotes go last.
function documentItems(tokens, notes) {
  const items = [];
  for (const token of shown(tokens)) {
    if (token.type === "list") token.items.forEach((item, index) => items.push({ list: token, item, index }));
    else if (token.type === "table") [token.header, ...token.rows].forEach((cells, index) => items.push({ table: token, cells, row: index - 1 }));
    else if (token.type === "code") {
      const rows = sourceLines(token).length;
      for (let from = 0; from < rows; from += CODE_LINES) items.push({ code: token, from, last: from + CODE_LINES >= rows });
    }
    else items.push({ token });
  }
  notes.forEach((note, index) => items.push({ note, first: index === 0 }));
  return items;
}

const shown = tokens => tokens.filter(token => token.type !== "space" && token.type !== "def" && token.type !== "footnote" && (token.type !== "html" || plainHtml(token)));
const plainHtml = token => (token.plainText ??= htmlText(token.text));

// The document as a lazy list: GPUI describes and lays out only the blocks on screen.
// Colors and sizes apply here, so a theme or size change doesn't lex again.
export function documentView(doc, { dark, fontSize: size, fontFamily }, id, padding) {
  const palette = dark ? PALETTE.dark : PALETTE.light, items = doc.items;
  return div().id(`${id}-area`).relative().size_full().min_w(0).min_h(0)
    .child(list(id, items.length, index => `block-${index}`, index => {
      const ctx = { palette, size, mono: fontFamily, lexer: doc.lexer, id: `${id}-${index}`, links: { next: 0 } };
      return div().w_full().px(padding).pt(index ? 0 : EDGE).pb(index === items.length - 1 ? EDGE : 0)
        .child(v_flex().w_full().max_w(MAX_WIDTH).mx_auto().font_family(PROSE_FONT).text_size(size).line_height(1.5).text_color(palette.fg)
          .child(documentItem(items[index], ctx, index === 0)));
    }).size_full())
    .child(Scrollbar.vertical(id).absolute().inset_0());
}

function documentItem(item, ctx, first) {
  if (item.list) return listItem(item.list, item.index, ctx, 0, item.index === item.list.items.length - 1);
  if (item.table) return tableRow(item.table, item.cells, item.row, ctx);
  if (item.code) return codeBlock(item.code, ctx, item.from, item.from + CODE_LINES, item.last);
  if (item.note) return footnote(item.note, ctx, item.first);
  return block(item.token, ctx, 0, first);
}

function blocks(tokens, ctx, depth) {
  return shown(tokens).map((token, index) => block(token, ctx, depth, index === 0));
}

// `extra` are inline pieces drawn at the end of a paragraph.
function block(token, ctx, depth, first, extra = []) {
  const { palette, size } = ctx, gap = size;
  switch (token.type) {
    case "heading": {
      const em = HEADING_SIZES[token.depth - 1] * size;
      return div().w_full().mt(first ? 0 : size * 1.5).mb(gap).font_weight(600).line_height(1.25).text_size(em)
        .when(token.depth <= 2, el => el.pb(em * 0.3).border_b(1).border_color(palette.borderMuted))
        .when(token.depth === 6, el => el.text_color(palette.muted))
        .child(inline(inlined(token.tokens, ctx), ctx));
    }
    case "paragraph":
      return div().w_full().mb(gap).child(inline(inlined(token.tokens, ctx), ctx, null, extra));
    case "text":
      return div().w_full().child(inline(token.tokens ? inlined(token.tokens, ctx) : [token], ctx));
    case "code":
      return codeBlock(token, ctx);
    case "blockquote": {
      if (token.alert) return alert(token, ctx, depth);
      return v_flex().w_full().mb(gap).px(size).border_l(ruleSize(size)).border_color(palette.border)
        .text_color(palette.muted).children(blocks(token.tokens, ctx, depth));
    }
    case "list":
      return v_flex().w_full().mb(depth ? 0 : size).children(token.items.map((_item, index) => listItem(token, index, ctx, depth, false)));
    case "table":
      return v_flex().w_full().children([token.header, ...token.rows].map((cells, index) => tableRow(token, cells, index - 1, ctx)));
    case "hr":
      return div().w_full().h(ruleSize(size)).my(size * 1.5).rounded(1).bg(palette.border);
    case "html":
      return div().w_full().mb(gap).child(plainHtml(token));
    default:
      return div().w_full().mb(gap).child(token.raw || "");
  }
}

// GitHub's alert: a colored left border, an icon and title in that color, the body in the text color.
// The body's last block keeps its bottom margin, so the body pulls it back, as GitHub's `:last-child` rule does.
function alert(token, ctx, depth) {
  const { palette, size } = ctx, kind = ALERTS[token.alert], [border, color] = palette.alerts[token.alert];
  return v_flex().w_full().mb(size).px(size).py(size * 0.5).border_l(ruleSize(size)).border_color(border)
    .child(h_flex().items_center().mb(size).line_height(1).font_weight(500).text_color(color)
      .child(svg(`${OCTICONS}/${kind.icon}.svg`).size(size).flex_none().mr(size * 0.5).text_color(color))
      .child(kind.title))
    .child(v_flex().w_full().mb(-size).children(blocks(token.tokens, ctx, depth)));
}

// GitHub's footnotes section: small muted text under a rule, without a visible title. Each note ends
// in links back to its refs, ↩, ↩², ..., inside its last paragraph or else under its last block.
function footnote(note, ctx, first) {
  const { palette, size } = ctx, small = { ...ctx, size: Math.round(size * SMALL) }, backrefs = backrefPieces(note);
  const body = shown(note.tokens), last = body.at(-1)?.type === "paragraph";
  return h_flex().w_full().items_start().text_size(small.size).text_color(palette.muted)
    .when(first, el => el.pt(size).border_t(1).border_color(palette.border))
    .child(h_flex().w(size).flex_shrink_0().justify_end().pr(small.size * 0.4).child(`${note.number}.`))
    .child(v_flex().flex_1().min_w(0)
      .children(body.map((token, index) => block(token, small, 1, index === 0, last && index === body.length - 1 ? backrefs : [])))
      .when(!last, el => el.child(div().w_full().mb(small.size).child(inline([], small, null, backrefs)))));
}

// ↩ for the first ref, ↩² for the second, and so on.
function backrefPieces(note) {
  const link = `#fnref-${note.number}`;
  return Array.from({ length: note.refs }, (_, index) => index).flatMap(index =>
    [{ text: " ↩", style: { link } }, ...(index ? [{ text: String(index + 1), style: { link, sup: true } }] : [])]);
}

// Code is drawn as text rows, not as a read-only Editor: an Editor scrolls past its last line
// under the wheel, and the list renderer allows no handler to stop that. Rows wrap at the block's
// width. `from`..`to` picks the rows of one list item; the block looks whole across its items.
function codeBlock(token, ctx, from = 0, to = Infinity, last = true) {
  const { palette, size } = ctx, first = from === 0;
  const font = codeSize(size), row = Math.round(font * 1.5);
  return v_flex().w_full().px(size).bg(palette.subtle).text_size(font).line_height(`${row}px`)
    .when(Boolean(ctx.mono), el => el.font_family(ctx.mono))
    .when(first, el => el.pt(size).rounded_t(6)).when(last, el => el.pb(size).mb(size).rounded_b(6))
    .children(codeLines(token, from, to).map(spans => h_flex().w_full().min_w(0).min_h(row).flex_wrap()
      .children(spans.map(span => div().min_w(0).text_color(palette.syntax[span.cls] || palette.fg).child(span.text)))));
}

const sourceLines = token => token.text.replace(/\n$/, "").replace(/\t/g, "    ").split("\n");

// Rows `from`..`to` of a code block as colored words, made the first time they are drawn. A word
// keeps its trailing spaces, so a row wraps between words as prose does, not only between colors.
// Colors carry state from row to row, so a colored block is made whole: a lexed fence is at most
// HARD long. Plain text can be far longer, so it is made one list item's rows at a time.
function codeLines(token, from, to) {
  const lang = languageOf(token.lang), key = lang ? 0 : from, made = token.rows ??= new Map();
  if (!made.has(key)) {
    const source = token.source ??= sourceLines(token);
    let state = null;
    made.set(key, (lang ? source : source.slice(from, to)).map(line => {
      const result = tokenize(line, lang, state);
      state = result.state;
      return result.spans.flatMap(span => span.text.split(/(?<=\s)(?=\S)/).filter(Boolean).map(text => ({ text, cls: span.cls })));
    }));
  }
  return lang ? made.get(0).slice(from, to) : made.get(key);
}

function listItem(token, index, ctx, depth, last) {
  const { palette, size } = ctx, item = token.items[index], start = token.start === "" ? 1 : Number(token.start);
  const bulleted = !item.task && !token.ordered;
  const marker = item.task ? checkbox(item.checked, ctx) : token.ordered ? div().child(`${start + index}.`) : bullet(depth, ctx);
  const indent = item.task ? size * 1.5 : size * 2, body = item.tokens.filter(child => child.type !== "checkbox");
  return h_flex().w_full().items_start().when(index > 0, el => el.mt(size * 0.25)).when(last, el => el.mb(size))
    .child(h_flex().w(indent).flex_shrink_0().justify_end().pr(item.task ? size * 0.5 : bulleted ? size * 0.55 : size * 0.4).child(marker))
    .child(v_flex().flex_1().min_w(0).children(blocks(body, ctx, depth + 1)));
}

// GitHub's list markers: shapes in the text color, a disc, then a circle, then a square, centered
// on the first line. Glyphs ("•", "◦") come out small and uneven in the prose font.
function bullet(depth, ctx) {
  const { palette, size } = ctx, dot = Math.round(size * 0.32), shape = depth % 3;
  return div().mt((size * 1.5 - dot) / 2).size(dot).flex_none()
    .when(shape === 0, el => el.rounded(dot).bg(palette.fg))
    .when(shape === 1, el => el.rounded(dot).border_1().border_color(palette.fg))
    .when(shape === 2, el => el.bg(palette.fg));
}

function checkbox(checked, ctx) {
  const { palette, size } = ctx, box = Math.round(size * 0.9);
  return div().mt((size * 1.5 - box) / 2).size(box).rounded(3).border_1().flex().items_center().justify_center()
    .border_color(checked ? palette.checked : palette.muted).bg(checked ? palette.checked : palette.canvas)
    .text_size(box * 0.8).line_height(1).text_color("#ffffff").child(checked ? "✓" : "");
}

// No table layout here: each column takes a share of the width by its longest cell.
function columnWeights(token) {
  return token.header.map((cell, column) =>
    Math.min(40, token.rows.reduce((longest, row) => Math.max(longest, row[column]?.text.length || 0), cell.text.length)) + 3);
}

// One table row; `row` is -1 for the header.
function tableRow(token, cells, row, ctx) {
  const { palette, size } = ctx, header = row < 0, weights = token.weights;
  // GitHub sizes a table to its content: estimate that from the text, with room for padding.
  const natural = weights.reduce((total, weight) => total + (weight - 3) * size * 0.6 + size * 1.6 + 1, 0);
  return h_flex().w_full().max_w(natural).items_stretch().bg(row % 2 === 1 ? palette.subtle : palette.canvas)
    .when(row === token.rows.length - 1, el => el.mb(size))
    .children(cells.map((cell, column) => div().flex_grow(weights[column]).flex_basis(0).min_w(0)
      .px(size * 0.8).py(size * 0.4).border_1().border_color(palette.border).ml(column ? -1 : 0).mt(header ? 0 : -1)
      .when(header, el => el.font_weight(600))
      .child(inline(inlined(cell.tokens, ctx), ctx, cell.align || (header ? "center" : null)))));
}

// Wraps inline text word by word. There is no rich-text element, so every
// whitespace-free run of styled pieces is one flex item in a wrapping row.
function inline(tokens, ctx, align = null, extra = []) {
  const pieces = [];
  flatten(tokens, {}, pieces);
  pieces.push(...extra);
  const words = [], space = ctx.size * 0.28;
  let word = [];
  const flush = () => { if (word.length) words.push(h_flex().flex_none().items_baseline().mr(space).children(word)); word = []; };
  for (const piece of pieces) {
    if (piece.br) { flush(); words.push(div().w_full().h(0)); continue; }
    if (piece.style.code) { word.push(styled(piece.text, piece.style, ctx)); continue; }
    const parts = piece.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (/^\s+$/.test(part)) flush();
      else word.push(styled(part, piece.style, ctx));
    }
  }
  flush();
  return h_flex().w_full().min_w(0).flex_wrap().items_baseline()
    .when(align === "center", el => el.justify_center())
    .when(align === "right", el => el.justify_end())
    .children(words);
}

function flatten(tokens, style, out) {
  for (const token of tokens || []) {
    switch (token.type) {
      case "strong": flatten(token.tokens, { ...style, bold: true }, out); break;
      case "em": flatten(token.tokens, { ...style, italic: true }, out); break;
      case "del": flatten(token.tokens, { ...style, strike: true }, out); break;
      // An autolink shows its address as written, without emoji.
      case "link": flatten(token.tokens, { ...style, link: token.href, verbatim: token.text === token.href }, out); break;
      case "codespan": out.push({ text: token.text, style: { ...style, code: true } }); break;
      case "br": out.push({ br: true }); break;
      // A loose task item keeps its checkbox inside the first paragraph; the marker draws it.
      case "checkbox": break;
      // Inline tags are dropped and the text between them stays.
      case "html": if (/^<br\s*\/?>$/i.test(token.text)) out.push({ br: true }); break;
      case "image": out.push({ text: token.text || token.href, style: { ...style, link: style.link || token.href } }); break;
      case "footnoteRef": out.push({ text: `[${token.note.number}]`, style: { ...style, link: `#fn-${token.note.number}`, sup: true } }); break;
      case "text": token.tokens ? flatten(token.tokens, style, out) : out.push({ text: style.verbatim ? decode(token.text) : emojify(decode(token.text)), style }); break;
      default: out.push({ text: decode(token.text ?? token.raw ?? ""), style });
    }
  }
}

function styled(text, style, ctx) {
  const { palette, size } = ctx, url = /^https?:\/\//i.test(style.link || "") ? style.link : null;
  // A Link opens its address natively: the list renderer allows no click handlers.
  const el = url ? Link.new(`${ctx.id}-link-${ctx.links.next++}`).href(url).cursor_pointer().hover(s => s.underline()) : div();
  return el.flex_none().child(text)
    // GitHub's inline code: 85% text, padding .2em .4em around one line of its own height, so a pill
    // stays shorter than the prose line and pills on two lines don't touch.
    .when(Boolean(style.code), el => el.px(size * 0.34).py(size * 0.17).line_height(1).rounded(6).bg(palette.code).text_size(size * 0.85))
    .when(Boolean(style.code && ctx.mono), el => el.font_family(ctx.mono))
    .when(Boolean(style.bold), el => el.font_weight(600))
    .when(Boolean(style.italic), el => el.italic())
    .when(Boolean(style.strike), el => el.line_through())
    .when(Boolean(style.link), el => el.text_color(palette.accent))
    // GitHub's superscript: 75% text, raised by half its height, so the line keeps its height.
    .when(Boolean(style.sup), el => el.relative().top(-size * SMALL / 2).text_size(size * SMALL));
}
