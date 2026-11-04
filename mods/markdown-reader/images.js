// Copies a document's images into the app folder: `image()` loads nothing from anywhere else.
import { exec, appHome } from "herdr";

export const WEB = /^https?:\/\//i;
const CACHE = "cache/markdown-reader/images";
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// One image into the cache, named `<hash>-<stamp>` so a changed image gets a new path: GPUI keeps
// what it loaded per path. A local file's stamp is its mtime; a web image's is the time its document
// opened, so every open downloads it again. Only regular files up to 20 MB. Copies unused for a day
// are deleted, not older stamps: another reader can still show those.
const FETCH = `dir=$1 hash=$2 src=$3 stamp=$4 max=20000000
mkdir -p "$dir" || exit 1
find "$dir" -type f -mtime +0 -delete 2>/dev/null
if [ -z "$stamp" ]; then
  [ -f "$src" ] && [ $(( $(wc -c < "$src") )) -le $max ] || exit 1
  stamp=$(stat -c %Y "$src" 2>/dev/null || stat -f %m "$src") || exit 1
fi
name="$hash-$stamp" part="$dir/$hash-$stamp.$$.part"
if [ -f "$dir/$name" ]; then touch "$dir/$name"
elif [ "$4" ]; then curl -fsSL --proto =http,https --proto-redir =http,https --max-time 25 --max-filesize $max -o "$part" "$src" && mv "$part" "$dir/$name" || { rm -f "$part"; exit 1; }
else cp "$src" "$part" && mv "$part" "$dir/$name" || { rm -f "$part"; exit 1; }
fi
printf %s "$name"`;

// The images of the open document: `find` answers at render, `load` fetches what render asked for.
export class ImageCache {
  constructor() {
    this.version = 0;
    this.reset(null);
  }

  // Forgets every image, so a newly opened file loads its own again. `on`: the file's machine.
  reset(on) {
    this.local = !on;
    this.stamp = String(Date.now());
    this.entries = new Map(); this.wanted = [];
    this.version++;
  }

  // The path for `image()` of `href` in the document `file`, or null until it loads or when it can't.
  find(href, file) {
    const src = this.source(href, file);
    if (!src) return null;
    const entry = this.entries.get(src);
    if (entry !== undefined) return entry;
    this.entries.set(src, null); this.wanted.push(src);
    return null;
  }

  // Fetches what `find` was asked for since the last call. Resolves to true when an image arrived.
  async load() {
    const wanted = this.wanted, version = this.version;
    this.wanted = [];
    const paths = await Promise.all(wanted.map(src => this.fetch(src)));
    if (version !== this.version) return false;
    wanted.forEach((src, index) => this.entries.set(src, paths[index]));
    const arrived = paths.some(Boolean);
    if (arrived) this.version++;
    return arrived;
  }

  async fetch(src) {
    const args = ["-c", FETCH, "sh", `${appHome()}/${CACHE}`, hash(src), src, WEB.test(src) ? this.stamp : ""];
    // exec rejects only when `sh` can't start; the image then keeps its alt text, as a failed copy does.
    const result = await exec("sh", args).catch(() => null);
    return result && result.code === 0 && result.stdout ? `${CACHE}/${result.stdout}` : null;
  }

  // A web address, or a file path relative to the document. Other schemes, and local files of a
  // document on another machine, have no source.
  source(href, file) {
    if (WEB.test(href)) return href;
    if (SCHEME.test(href) || href.startsWith("#") || !this.local || !file?.includes("/")) return null;
    const path = safeDecode(href.replace(/[?#].*$/, ""));
    return path.startsWith("/") ? path : `${file.replace(/\/[^/]*$/, "")}/${path}`;
  }
}

function safeDecode(text) {
  try { return decodeURI(text); } catch { return text; }
}

// FNV-1a, 32-bit: a short stable file name per source.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
