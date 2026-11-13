/**
 * Browser shim for `node:path` (POSIX subset).
 *
 * The core only uses `join` to reach `examples/policy.yaml` and the state
 * directory. In the browser the paths are virtual, so this is the small
 * POSIX-only subset that the engine actually touches.
 */

export const sep = '/';

function normalize(parts: string[]): string {
  const absolute = parts.length > 0 && parts[0]!.startsWith('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      const last = stack[stack.length - 1];
      if (stack.length > 0 && last !== '..') stack.pop();
      else if (!absolute) stack.push('..');
      continue;
    }
    stack.push(part);
  }
  const joined = stack.join('/');
  return absolute ? `/${joined}` : joined;
}

export function join(...parts: string[]): string {
  if (parts.length === 0) return '.';
  return normalize(parts.map((part) => String(part)));
}

export function resolve(...parts: string[]): string {
  const joined = join(...parts);
  return joined.startsWith('/') ? joined : `/${joined}`;
}

export function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

export function extname(path: string): string {
  const base = basename(path);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index);
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/');
}
