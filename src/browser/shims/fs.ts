/**
 * Browser shim for `node:fs`.
 *
 * The browser demo runs the real `FeralGuard`, which reads the shipped policy
 * file and may write its state directory. Neither exists in a browser, so the
 * file system is virtual: reads are served from `globalThis.__FERAL_VFS__`
 * (the build inlines `examples/policy.yaml` into it), writes land in an
 * in-memory map that is discarded when the tab closes.
 *
 * The point is fidelity: the demo is not a re-implementation of the product,
 * it is the product with the disk replaced by memory.
 */

interface VirtualFs {
  files: Record<string, string>;
}

function store(): VirtualFs {
  const scope = globalThis as unknown as { __FERAL_VFS__?: VirtualFs };
  if (!scope.__FERAL_VFS__) scope.__FERAL_VFS__ = { files: {} };
  return scope.__FERAL_VFS__;
}

function normalize(path: string): string {
  const parts = String(path).replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

/** Resolve a requested path against the preloaded files, tolerating prefix differences. */
function lookup(path: string): string | undefined {
  const fs = store();
  const target = normalize(path);
  if (target in fs.files) return fs.files[target];
  for (const [key, value] of Object.entries(fs.files)) {
    const normalizedKey = normalize(key);
    if (target.endsWith(normalizedKey) || normalizedKey.endsWith(target)) return value;
  }
  return undefined;
}

export function readFileSync(path: string, encoding?: string): string {
  const value = lookup(path);
  if (value === undefined) {
    const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & { code?: string };
    error.code = 'ENOENT';
    throw error;
  }
  if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') return value;
  return value;
}

export function writeFileSync(path: string, data: string, encoding?: string): void {
  const fs = store();
  fs.files[normalize(path)] = typeof data === 'string' ? data : String(data);
}

export function existsSync(path: string): boolean {
  return lookup(path) !== undefined;
}

export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined {
  const fs = store();
  fs.files[normalize(path)] ??= '';
  return undefined;
}

export function readdirSync(path: string): string[] {
  const prefix = `${normalize(path)}/`;
  return Object.keys(store().files)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

export function rmSync(path: string): void {
  delete store().files[normalize(path)];
}

export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean; size: number } {
  const value = lookup(path);
  return {
    isFile: () => value !== undefined,
    isDirectory: () => value === undefined,
    size: value ? value.length : 0,
  };
}
