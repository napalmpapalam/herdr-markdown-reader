const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = path.join(__dirname, '../../mods/markdown-reader');
function moduleSource(name) {
  return fs.readFileSync(path.join(mod, name), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
}
const search = new Function(moduleSource('search.js') + '\nreturn { clean, resolvePath, rankFiles, isMarkdown, isFolderQuery, searchMatches };')();
const { folderContext } = new Function(moduleSource('context.js') + '\nreturn { folderContext };')();
// The vendored parser is one minified ES module; turn its export list into a return value.
const { Lexer } = new Function(fs.readFileSync(path.join(mod, 'vendor/marked.esm.js'), 'utf8')
  .replace(/export\{([^}]*)\};?/, (_match, names) => 'return {' + names.replace(/(\w+) as (\w+)/g, '$2: $1') + '};'))();
if (typeof Lexer?.lex !== 'function') throw new Error('Cannot load the vendored marked lexer');

// Record native element descriptions so tests can use the controls' real handlers.
// Herdr's check and screenshot commands verify the native rendering separately.
function element(type, id) {
  const node = { type, elementId: id, kids: [], slots: {}, handlers: {}, styles: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === 'child') target.kids.push(args[0]);
      else if (key === 'children') target.kids.push(...args[0]);
      else if (key === 'trigger' || key === 'content') target.slots[key] = args[0];
      else if (key === 'when') { if (args[0]) args[1](proxy); }
      else if (key === 'id') target.elementId = args[0];
      else if (key.startsWith('on_')) target.handlers[key] = args[0];
      else target.styles[key] = args.length === 1 ? args[0] : args;
      return proxy;
    };
  } });
  return proxy;
}

function createReader({ root, properties = {}, appearance = { dark: true, font_family: 'Mono' }, focus, fileRead, picker = async () => null, discovery, storage = new Map() } = {}) {
  const timers = [], tasks = new Set(), errors = [], commands = [];
  const stop = new Error('stop command listener');
  const cx = {
    notify() {}, stop_propagation() {}, sleep: async () => {},
    focus_handle: () => ({ focus() {} }),
    timer: { after: (_delay, callback) => timers.push(callback), every() {} },
    spawn(callback) {
      const promise = Promise.resolve().then(() => callback(cx)).catch(error => { if (error !== stop) errors.push(error); });
      tasks.add(promise); promise.finally(() => tasks.delete(promise));
    },
  };
  const inputs = [];
  const InputState = { new({ value = '' }) {
    const handlers = {};
    const input = { text: value, handlers, on: (name, handler) => { handlers[name] = handler; }, value: () => input.text,
      set_value: value => { input.text = value; }, focus: () => handlers.focus?.({}, cx), set_selected_range() {} };
    inputs.push(input);
    return input;
  } };
  const exec = async (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8' });
    return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
  };
  const platform = () => ({ platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux' });
  const files = new Function('exec', 'window', 'isMarkdown', moduleSource('files.js') + '\nreturn { indexMarkdown, listFolder, skipFolder };')(exec, platform, search.isMarkdown);
  const editors = [];
  const EditorState = { new(options) {
    if (options.language === 'boom') throw new Error('Cannot highlight boom');
    const editor = { options, released: false, release() { editor.released = true; return true; } };
    editors.push(editor);
    return editor;
  } };
  const list = (id, count, getKey, render) => {
    const node = element('list', id);
    node.keys = Array.from({ length: count }, (_, i) => getKey(i));
    node.kids.push(...node.keys.map((_key, i) => render(i, cx)));
    return node;
  };
  const markdown = new Function('div', 'list', 'h_flex', 'v_flex', 'Editor', 'EditorState', 'Link', 'Scrollbar', 'Lexer',
    moduleSource('markdown.js') + '\nreturn { lexDocument, makeCodeViews, releaseCodeViews, documentView };')(
    () => element('div'), list, () => element('row'), () => element('column'),
    { new: state => { const node = element('editor'); node.state = state; return node; } }, EditorState,
    { new: id => element('link', id) }, { vertical: () => element('scrollbar') }, Lexer);
  const bindings = {
    View: class {}, div: () => element('div'), svg: file => element('svg', file),
    h_flex: () => element('row'), v_flex: () => element('column'),
    Button: { new: id => element('button', id) }, Input: { new: () => element('input') }, InputState,
    Popover: { new: id => element('popover', id) }, Scrollbar: { vertical: () => element('scrollbar') },
    v_virtual_list: (id, count, _size, getKey, render) => {
      const node = element('list', id);
      node.keys = Array.from({ length: count }, (_, i) => getKey(i));
      node.kids.push(...render({ start: 0, end: count }));
      return node;
    },
    VirtualListScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    shared: key => storage.get(key), setShared: (key, value) => storage.set(key, structuredClone(value)),
    theme: () => ({}), settings: () => appearance, props: () => properties, ...markdown,
    focused: () => focus || { cwd: root, tab: 'tab', space: 'space', terminal: 't1' }, panes: () => [],
    spaces: () => [{ id: 'space', active: true, folder: root, machine: null }], home: () => root,
    readTextFile: fileRead || (async file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }),
    pickFolder: picker, run: (name, args) => commands.push({ name, args }), closeOverlay: id => commands.push({ close: id }),
    nextCommand: async () => { throw stop; }, ...search, ...files, ...discovery, folderContext,
  };
  const source = moduleSource('main.js').replace('default class MarkdownReader', 'return class MarkdownReader');
  const Reader = new Function(...Object.keys(bindings), source)(...Object.values(bindings));
  const reader = new Reader(); reader.init({}, cx);
  async function settle() {
    for (let i = 0; i < 20; i++) {
      for (const timer of timers.splice(0)) timer(cx);
      await Promise.all([...tasks]);
      if (!timers.length && !tasks.size) break;
    }
    if (errors.length) throw errors[0];
  }
  function find(id, node = reader.render()) {
    if (!node || typeof node !== 'object') return null;
    if (node.elementId === id) return node;
    for (const child of [...node.kids, ...Object.values(node.slots)]) {
      const match = find(id, child);
      if (match) return match;
    }
    return null;
  }
  return { reader, cx, settle, files, search, commands, find, editors, markdown, Lexer,
    click: id => { const node = find(id); if (!node) throw new Error('Control not found: ' + id); node.handlers.on_click({}, cx); },
    type: value => { reader.input.set_value(value); reader.input.handlers.change({}, cx); },
  };
}

module.exports = { createReader, search, folderContext };
