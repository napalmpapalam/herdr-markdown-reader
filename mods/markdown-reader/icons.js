import ICONS from "./vendor/material-icon-theme/table.js";

const DIR = "mods/markdown-reader/vendor/material-icon-theme/icons";

// Material Icon Theme's rules, as VS Code applies them: names match case-insensitively; a
// path rule (".github/workflows") beats a name, a name beats an extension, and the longest
// extension wins ("stories.mdx" over "mdx"). Light themes check the theme's light table first.
const bare = name => name.replace(/^__(.+)__$/, "$1").replace(/^[._-]/, "");
const opened = id => id.endsWith("_light") ? `${id.slice(0, -6)}-open_light` : `${id}-open`;
// Own keys only: a folder named "constructor" or "__proto__" must not read Object's properties.
const own = (names, key) => Object.prototype.hasOwnProperty.call(names, key) ? names[key] : undefined;
const lookup = (table, key, dark) => (dark ? undefined : own(ICONS.light[table], key)) ?? own(ICONS[table], key);

// The icon file for a workspace-relative path, as a path that image() draws.
export function iconFile(path, dir, open, dark) {
  const parts = path.toLowerCase().split("/"), name = parts[parts.length - 1];
  const table = dir ? "folderNames" : "fileNames";
  const find = key => lookup(table, key, dark) ?? (dir ? lookup(table, bare(key), dark) : undefined);
  let id;
  for (let i = 0; !id && i < parts.length - 1; i++) id = find(parts.slice(i).join("/"));
  if (dir) {
    id ??= find(name) ?? ICONS.folder;
    return `${DIR}/${open ? opened(id) : id}.svg`;
  }
  id ??= find(name);
  for (let dot = name.indexOf("."); !id && dot !== -1; dot = name.indexOf(".", dot + 1)) id = lookup("fileExtensions", name.slice(dot + 1), dark);
  return `${DIR}/${id ?? ICONS.file}.svg`;
}
