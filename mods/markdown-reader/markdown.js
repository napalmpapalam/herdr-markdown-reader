// Draws a Markdown document as native elements in GitHub's style.
import { div, list } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState, Link, Scrollbar } from "gpui-base";
import { Lexer } from "./vendor/marked.esm.js";

// GitHub's own colors (github-markdown-css), so documents look like github.com.
const PALETTE = {
  dark: {
    fg: "#f0f6fc", muted: "#9198a1", accent: "#4493f8", canvas: "#0d1117", subtle: "#151b23",
    code: "#656c7633", border: "#3d444d", borderMuted: "#3d444db3", checked: "#1f6feb",
    syntax: { keyword: "#ff7b72", string: "#a5d6ff", comment: "#9198a1", function: "#d2a8ff", type: "#ffa657",
      number: "#79c0ff", constant: "#79c0ff", boolean: "#79c0ff", variable: "#ffa657", operator: "#ff7b72" },
  },
  light: {
    fg: "#1f2328", muted: "#59636e", accent: "#0969da", canvas: "#ffffff", subtle: "#f6f8fa",
    code: "#818b981f", border: "#d1d9e0", borderMuted: "#d1d9e0b3", checked: "#0969da",
    syntax: { keyword: "#cf222e", string: "#0a3069", comment: "#59636e", function: "#6639ba", type: "#953800",
      number: "#0550ae", constant: "#0550ae", boolean: "#0550ae", variable: "#953800", operator: "#cf222e" },
  },
};

// Fence names mapped to the Editor's grammar names.
const LANGUAGES = {
  javascript: "js", jsx: "js", ts: "js", typescript: "js", tsx: "js", mjs: "js", cjs: "js",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", yml: "yaml", toml: "yaml", rs: "rust",
  py: "python", rb: "ruby", golang: "go", jsonc: "json", md: "markdown", htm: "html", xml: "html",
};

// GitHub's -apple-system stack. The app's default UI font may ship one face only, which drops bold and italic.
const PROSE_FONT = ".SystemUIFont";
// The code view's row height (measured, rounded to whole pixels like GPUI) and a monospace advance.
const CODE_LINE = 1.5, MONO_ADVANCE = 0.6;
const codeSize = fontSize => Math.round(fontSize * 0.85);
const MAX_WIDTH = 820, EDGE = 18, SLICE_MS = 30;
const HEADING_SIZES = [2, 1.5, 1.25, 1, 0.875, 0.85];
const BULLETS = ["•", "◦", "▪"];
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", mdash: "—", ndash: "–", hellip: "…" };

function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? match;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

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
const HARD = 16000, INLINE = 8000, PLAIN_LINES = 60;
export async function lexDocument(text, key, pause, stale) {
  const lexer = new Lexer({ gfm: true }), slice = { at: Date.now() };
  let words = 0, carry = "";
  for (const chunk of chunks(text.replace(/\r\n?/g, "\n"))) {
    carry = lexChunk(lexer, carry + chunk);
    words += (chunk.match(/\S+/g) || []).length;
    if (!(await breathe(slice, pause, stale))) return null;
  }
  if (carry) lexChunk(lexer, carry, true);
  for (const next of lexer.inlineQueue) {
    if (next.src.length > INLINE) next.tokens.push({ type: "text", raw: next.src, text: next.src });
    else next.tokens.pending = next.src;
  }
  lexer.inlineQueue = [];
  const code = [];
  visit(lexer.tokens, token => {
    if (token.type === "table") token.weights = columnWeights(token);
    if (token.type === "code") code.push(token);
  });
  return { items: documentItems(lexer.tokens), lexer, code, words, text, key };
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

// Too long to lex in one slice: monospaced text, PLAIN_LINES rows per item.
function plain(tokens, source) {
  const lines = source.replace(/\n+$/, "").split("\n");
  for (let i = 0; i < lines.length; i += PLAIN_LINES) {
    const text = lines.slice(i, i + PLAIN_LINES).join("\n");
    tokens.push({ type: "code", raw: text, text, lang: "", plain: { first: i === 0, last: i + PLAIN_LINES >= lines.length } });
  }
}

// One read-only code view per code block. They are retained native state: make them outside
// render, and release them. Resolves to null, with everything released, once `stale()` is true.
export async function makeCodeViews(doc, { dark, fontSize, fontFamily }, pause, stale) {
  const views = new Map(), slice = { at: Date.now() }, syntax = (dark ? PALETTE.dark : PALETTE.light).syntax;
  try {
    for (const token of doc.code) {
      const lang = (token.lang || "").trim().split(/\s+/)[0].toLowerCase();
      views.set(token, EditorState.new({
        language: LANGUAGES[lang] ?? (lang || "text"), value: token.text.replace(/\n$/, ""), readonly: true,
        font_family: fontFamily, font_size: codeSize(fontSize), line_numbers: false, folding: false, soft_wrap: true, syntax,
      }));
      if (!(await breathe(slice, pause, stale))) { releaseCodeViews(views); return null; }
    }
  } catch (error) { releaseCodeViews(views); throw error; }
  return views;
}

export function releaseCodeViews(views) {
  for (const view of views?.values() || []) view.release();
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
// so a long one costs only its visible part.
function documentItems(tokens) {
  const items = [];
  for (const token of shown(tokens)) {
    if (token.type === "list") token.items.forEach((item, index) => items.push({ list: token, item, index }));
    else if (token.type === "table") [token.header, ...token.rows].forEach((cells, index) => items.push({ table: token, cells, row: index - 1 }));
    else items.push({ token });
  }
  return items;
}

const shown = tokens => tokens.filter(token => token.type !== "space" && token.type !== "def" && (token.type !== "html" || plainHtml(token)));
const plainHtml = token => (token.plainText ??= htmlText(token.text));

// The document as a lazy list: GPUI describes and lays out only the blocks on screen.
// Colors and sizes apply here, so a theme or size change doesn't lex again. The list renderer
// allows no handlers, so the width code blocks wrap at is measured around it, into `layout`.
export function documentView(doc, views, { dark, fontSize: size, fontFamily }, layout, id, padding) {
  const palette = dark ? PALETTE.dark : PALETTE.light, items = doc.items;
  const width = Math.min(MAX_WIDTH, layout.width - padding * 2);
  return div().id(`${id}-area`).relative().size_full().min_w(0).min_h(0)
    .on_size_change((bounds, cx) => { if (layout.width !== bounds.width) { layout.width = bounds.width; cx.notify(); } })
    .child(list(id, items.length, index => `block-${index}`, index => {
      const ctx = { palette, size, mono: fontFamily, lexer: doc.lexer, views, id: `${id}-${index}`, links: { next: 0 }, width };
      return div().w_full().px(padding).pt(index ? 0 : EDGE).pb(index === items.length - 1 ? EDGE : 0)
        .child(v_flex().w_full().max_w(MAX_WIDTH).mx_auto().font_family(PROSE_FONT).text_size(size).line_height(1.5).text_color(palette.fg)
          .child(documentItem(items[index], ctx, index === 0)));
    }).size_full())
    .child(Scrollbar.vertical(id).absolute().inset_0());
}

function documentItem(item, ctx, first) {
  if (item.list) return listItem(item.list, item.index, ctx, 0, item.index === item.list.items.length - 1);
  if (item.table) return tableRow(item.table, item.cells, item.row, ctx);
  return block(item.token, ctx, 0, first);
}

function blocks(tokens, ctx, depth) {
  return shown(tokens).map((token, index) => block(token, ctx, depth, index === 0));
}

function block(token, ctx, depth, first) {
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
      return div().w_full().mb(gap).child(inline(inlined(token.tokens, ctx), ctx));
    case "text":
      return div().w_full().child(inline(token.tokens ? inlined(token.tokens, ctx) : [token], ctx));
    case "code":
      return codeBlock(token, ctx);
    case "blockquote": {
      const border = Math.max(3, size * 0.25);
      return v_flex().w_full().mb(gap).px(size).border_l(border).border_color(palette.border)
        .text_color(palette.muted).children(blocks(token.tokens, { ...ctx, width: ctx.width - size * 2 - border }, depth));
    }
    case "list":
      return v_flex().w_full().mb(depth ? 0 : size).children(token.items.map((_item, index) => listItem(token, index, ctx, depth, false)));
    case "table":
      return v_flex().w_full().children([token.header, ...token.rows].map((cells, index) => tableRow(token, cells, index - 1, ctx)));
    case "hr":
      return div().w_full().h(Math.max(3, size * 0.25)).my(size * 1.5).rounded(1).bg(palette.border);
    case "html":
      return div().w_full().mb(gap).child(plainHtml(token));
    default:
      return div().w_full().mb(gap).child(token.raw || "");
  }
}

// The code view has no automatic height and scrolls whatever overflows it.
// Size it to every row its soft wrap makes at the width left for it. The view wraps a little
// before the full width, so count two columns fewer: a spare row is better than a scrolled one.
// Plain-text pieces join into one block.
function codeBlock(token, ctx) {
  const { palette, size } = ctx, font = codeSize(size), inner = ctx.width - size * 2, view = ctx.views?.get(token);
  const columns = inner > 0 ? Math.max(1, Math.floor(inner / (font * MONO_ADVANCE)) - 2) : 0;
  if (token.wrap?.columns !== columns) token.wrap = { columns, rows: wrappedRows(token.text, columns) };
  const { first = true, last = true } = token.plain || {};
  return div().w_full().px(size).bg(palette.subtle)
    .when(first, el => el.pt(size).rounded_t(6)).when(last, el => el.pb(size).mb(size).rounded_b(6))
    .child(view ? Editor.new(view).w_full().h(token.wrap.rows * Math.round(font * CODE_LINE)).bg(palette.subtle) : div());
}

// Rows of `text` wrapped at word boundaries to `columns` characters; 0 means no wrapping.
function wrappedRows(text, columns) {
  let rows = 0;
  for (const line of text.replace(/\n$/, "").replace(/\t/g, "    ").split("\n")) {
    rows++;
    if (columns <= 0 || line.length <= columns) continue;
    let used = 0;
    for (const word of line.split(/(?<=\s)(?=\S)/)) {
      const visible = word.trimEnd().length;
      if (used && used + visible > columns) { rows++; used = 0; }
      if (visible > columns) { rows += Math.floor((visible - 1) / columns); used = (visible - 1) % columns + 1 + word.length - visible; }
      else used += word.length;
    }
  }
  return rows;
}

function listItem(token, index, ctx, depth, last) {
  const { palette, size } = ctx, item = token.items[index], start = token.start === "" ? 1 : Number(token.start);
  const marker = item.task
    ? checkbox(item.checked, ctx)
    : div().text_color(token.ordered ? palette.fg : palette.muted).child(token.ordered ? `${start + index}.` : BULLETS[depth % 3]);
  const indent = item.task ? size * 1.5 : size * 2, body = item.tokens.filter(child => child.type !== "checkbox");
  return h_flex().w_full().items_start().when(index > 0, el => el.mt(size * 0.25)).when(last, el => el.mb(size))
    .child(h_flex().w(indent).flex_shrink_0().justify_end().pr(item.task ? size * 0.5 : size * 0.4).child(marker))
    .child(v_flex().flex_1().min_w(0).children(blocks(body, { ...ctx, width: ctx.width - indent }, depth + 1)));
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
function inline(tokens, ctx, align = null) {
  const pieces = [];
  flatten(tokens, {}, pieces);
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
      case "link": flatten(token.tokens, { ...style, link: token.href }, out); break;
      case "codespan": out.push({ text: token.text, style: { ...style, code: true } }); break;
      case "br": out.push({ br: true }); break;
      // A loose task item keeps its checkbox inside the first paragraph; the marker draws it.
      case "checkbox": break;
      // Inline tags are dropped and the text between them stays.
      case "html": if (/^<br\s*\/?>$/i.test(token.text)) out.push({ br: true }); break;
      case "image": out.push({ text: token.text || token.href, style: { ...style, link: style.link || token.href } }); break;
      case "text": token.tokens ? flatten(token.tokens, style, out) : out.push({ text: decode(token.text), style }); break;
      default: out.push({ text: decode(token.text ?? token.raw ?? ""), style });
    }
  }
}

function styled(text, style, ctx) {
  const { palette, size } = ctx, url = /^https?:\/\//i.test(style.link || "") ? style.link : null;
  // A Link opens its address natively: the list renderer allows no click handlers.
  const el = url ? Link.new(`${ctx.id}-link-${ctx.links.next++}`).href(url).cursor_pointer().hover(s => s.underline()) : div();
  return el.flex_none().child(text)
    .when(Boolean(style.code), el => el.px(size * 0.4).rounded(6).bg(palette.code).text_size(size * 0.85))
    .when(Boolean(style.code && ctx.mono), el => el.font_family(ctx.mono))
    .when(Boolean(style.bold), el => el.font_weight(600))
    .when(Boolean(style.italic), el => el.italic())
    .when(Boolean(style.strike), el => el.line_through())
    .when(Boolean(style.link), el => el.text_color(palette.accent));
}
