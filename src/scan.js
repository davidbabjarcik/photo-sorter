// Rekurzívne prehľadanie priečinka cez File System Access API.
export const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif)$/i;
const SKIP_DIRS = new Set(['@eaDir', '#recycle', '$RECYCLE.BIN', 'System Volume Information', 'node_modules', '.git']);

/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {(n:number)=>void} [onCount]
 * @returns {Promise<{name:string,path:string,handle:FileSystemFileHandle,parent:FileSystemDirectoryHandle}[]>}
 */
export async function scanDirectory(dir, onCount) {
  const out = [];
  const stack = [[dir, '']];
  let last = 0;
  while (stack.length) {
    const [d, prefix] = stack.pop();
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'directory') {
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
        stack.push([h, prefix + name + '/']);
      } else if (IMAGE_RE.test(name) && !name.startsWith('._')) {
        out.push({ name, path: prefix + name, handle: h, parent: d });
        if (onCount && out.length - last >= 250) {
          last = out.length;
          onCount(out.length);
        }
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  onCount?.(out.length);
  return out;
}

export const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
