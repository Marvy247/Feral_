/**
 * Build the judge-facing browser demo: the real Feral engine, compiled to a
 * static page.
 *
 * Why this exists: a judge should not need Node, a terminal or a wallet to see
 * the product. This script takes the same TypeScript sources the CLI and the
 * dashboard run, strips the types, rewrites the module graph into a single
 * self-contained bundle, and writes two artefacts:
 *
 *   docs/demo/feral-demo.js   the bundle (also used by the test that proves
 *                             the bundle and the engine agree)
 *   docs/demo/index.html      the page: one file, no network, nothing leaves
 *                             the tab
 *
 * It has no dependencies. Node's own `stripTypeScriptTypes` does the type
 * erasure and a small resolver below does the module rewriting.
 *
 *   node scripts/build-demo.ts           # write the artefacts
 *   node scripts/build-demo.ts --check   # fail if the committed artefacts are
 *                                        # not what this script produces now
 *
 * The output is deterministic: same source in, byte-identical files out, so
 * `--check` is a real regression gate and not a timestamp diff.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const ENTRY = 'src/browser/main.ts';
const OUT_JS = 'docs/demo/feral-demo.js';
const OUT_HTML = 'docs/demo/index.html';
const TEMPLATE = 'src/browser/index.template.html';

/** Node built-ins the core touches, and the browser module that replaces each. */
const SHIMS: Record<string, string> = {
  'node:crypto': 'src/browser/shims/crypto.ts',
  'node:fs': 'src/browser/shims/fs.ts',
  'node:path': 'src/browser/shims/path.ts',
};

const check = process.argv.includes('--check');

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

// ------------------------------------------------------------- resolution ----

function resolveSpecifier(spec: string, fromFile: string): string {
  if (SHIMS[spec]) return SHIMS[spec];
  if (!spec.startsWith('.')) {
    throw new Error(`bare import "${spec}" in ${fromFile}: the browser bundle must stay dependency-free`);
  }
  const resolved = join(dirname(fromFile), spec).replace(/\\/g, '/');
  if (!existsSync(join(root, resolved))) {
    throw new Error(`cannot resolve "${spec}" from ${fromFile} (looked for ${resolved})`);
  }
  return resolved;
}

// ------------------------------------------------------------- transform ----

interface Transformed {
  code: string;
  exports: string[];
}

const IMPORT_RE = /^import\s+(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"];?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_DESTRUCTURED_RE = /^export\s+(const|let|var)\s*\{([^}]*)\}/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\};?[ \t]*$/gm;
const EXPORT_DEFAULT_RE = /^export\s+default\s+/gm;

/** Rewrite one import clause into plain `require` calls. */
function rewriteClause(clause: string, moduleId: string): string {
  const trimmed = clause.trim();
  if (trimmed === '') return `require(${JSON.stringify(moduleId)});`;
  if (trimmed.startsWith('*')) {
    const name = trimmed.replace(/^\*\s*as\s*/, '').trim();
    return `const ${name} = require(${JSON.stringify(moduleId)});`;
  }
  const defaultMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s*(?:,\s*([\s\S]*))?$/);
  if (defaultMatch && !trimmed.startsWith('{')) {
    const defaultName = defaultMatch[1]!;
    const rest = (defaultMatch[2] ?? '').trim();
    if (rest.startsWith('*')) {
      const name = rest.replace(/^\*\s*as\s*/, '').trim();
      return (
        `const ${defaultName} = require(${JSON.stringify(moduleId)}).default;` +
        `const ${name} = require(${JSON.stringify(moduleId)});`
      );
    }
    if (rest.startsWith('{')) {
      const named = rest.slice(1, -1).trim();
      return (
        `const ${defaultName} = require(${JSON.stringify(moduleId)}).default;` +
        `const { ${named} } = require(${JSON.stringify(moduleId)});`
      );
    }
    return `const ${defaultName} = require(${JSON.stringify(moduleId)}).default;`;
  }
  if (trimmed.startsWith('{')) {
    const named = trimmed.slice(1, -1).trim();
    return `const { ${named} } = require(${JSON.stringify(moduleId)});`;
  }
  throw new Error(`unsupported import clause: ${trimmed}`);
}

/** Rewrite a named-export list (`{ a, b as c }`) into export assignments. */
function namedAssignments(list: string): { code: string; names: string[] } {
  const assignments: string[] = [];
  const names: string[] = [];
  for (const raw of list.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [local, exported = local] = entry.split(/\s+as\s+/).map((part) => part.trim());
    assignments.push(`exports[${JSON.stringify(exported)}] = ${local};`);
    names.push(exported);
  }
  return { code: assignments.join('\n'), names };
}

function transform(source: string, fileId: string): Transformed {
  // 1. erase the types with Node's own stripper (transform mode also handles
  //    enums and parameter properties, which the plain strip mode leaves as
  //    invalid JavaScript).
  let code = stripTypeScriptTypes(source, { mode: 'transform' }) as string;

  // 2. imports -> require calls with resolved module ids.
  code = code.replace(IMPORT_RE, (_match, clause: string | undefined, spec: string) => {
    const moduleId = resolveSpecifier(spec, fileId);
    return rewriteClause(clause ?? '', moduleId);
  });

  // 3. exports -> assignments collected at the end of the module body.
  const exported: string[] = [];
  code = code.replace(EXPORT_DECL_RE, (_match, keyword: string, name: string) => {
    exported.push(name);
    return `${keyword} ${name}`;
  });
  code = code.replace(EXPORT_DESTRUCTURED_RE, (_match, keyword: string, list: string) => {
    const { names } = namedAssignments(list);
    exported.push(...names);
    return `${keyword} {${list}}`;
  });
  code = code.replace(EXPORT_LIST_RE, (_match, list: string) => {
    const { code: assignments, names } = namedAssignments(list);
    exported.push(...names);
    return assignments;
  });
  code = code.replace(EXPORT_DEFAULT_RE, () => {
    // The default export is assigned in place; there is no local binding to
    // re-export at the end of the module.
    return 'exports.default = ';
  });

  // 4. `import.meta` has no meaning in a classic script.
  const virtualDir = `/${dirname(fileId)}`;
  code = code.replace(/import\.meta\.dirname/g, JSON.stringify(virtualDir));
  code = code.replace(/import\.meta\.url/g, JSON.stringify(`file://${virtualDir}/`));
  code = code.replace(/import\.meta\.filename/g, JSON.stringify(`/${fileId}`));

  const tail = exported.map((name) => `exports[${JSON.stringify(name)}] = ${name};`).join('\n');
  return { code: `${code}\n${tail}\n`, exports: exported };
}

// ------------------------------------------------------------------ graph ----

interface Module {
  id: string;
  code: string;
  exports: string[];
}

function collect(entry: string): Module[] {
  const seen = new Map<string, Module>();
  const queue = [entry];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    const source = read(id);
    const transformed = transform(source, id);
    seen.set(id, { id, code: transformed.code, exports: transformed.exports });
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[2]!;
      queue.push(resolveSpecifier(spec, id));
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ----------------------------------------------------------------- output ----

function renderBundle(modules: Module[], vfs: Record<string, string>): string {
  const parts: string[] = [];
  parts.push('/* Feral browser demo bundle. Generated by scripts/build-demo.ts - do not edit. */');
  parts.push('(function (scope) {');
  parts.push("  'use strict';");
  parts.push('  var __modules = {};');
  parts.push('  var __cache = {};');
  parts.push('  function __require(id) {');
  parts.push('    if (__cache[id]) return __cache[id].exports;');
  parts.push('    var module = { exports: {} };');
  parts.push('    __cache[id] = module;');
  parts.push('    __modules[id](module, module.exports, __require);');
  parts.push('    return module.exports;');
  parts.push('  }');
  parts.push(`  scope.__FERAL_VFS__ = { files: ${JSON.stringify(vfs, null, 2)} };`);
  for (const mod of modules) {
    parts.push(`  __modules[${JSON.stringify(mod.id)}] = function (module, exports, require) {`);
    parts.push(mod.code);
    parts.push('  };');
  }
  parts.push(`  scope.FERAL_DEMO = __require(${JSON.stringify(ENTRY)});`);
  parts.push('})(typeof globalThis !== "undefined" ? globalThis : this);');
  return `${parts.join('\n')}\n`;
}

function renderHtml(bundle: string): string {
  const template = read(TEMPLATE);
  // A function replacement, not a string: the bundle contains `${...}` and `$&`
  // sequences that `String.replace` would otherwise interpret.
  return template.replace('/*__FERAL_BUNDLE__*/', () => bundle.trimEnd());
}

// ------------------------------------------------------------------- main ----

const modules = collect(ENTRY);
const vfs: Record<string, string> = {
  'examples/policy.yaml': read('examples/policy.yaml'),
};

/**
 * Facts about the Rust vault, read out of the contract source at build time so
 * the page cannot drift from the code it describes: the reason codes the vault
 * enforces, how big it is, and how many tests it carries.
 */
function contractSummary(): { reasonCodes: string[]; lines: number; tests: number } {
  const source = read('contract/src/lib.rs');
  const codes = new Set<string>();
  for (const match of source.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) codes.add(match[1]!);
  const reasonCodes = [...codes].sort();
  return {
    reasonCodes,
    lines: source.split('\n').length,
    tests: (source.match(/#\[test\]/g) ?? []).length,
  };
}
vfs['contract/contract-summary.json'] = JSON.stringify(contractSummary(), null, 2);

const bundle = renderBundle(modules, vfs);
const html = renderHtml(bundle);

if (check) {
  const problems: string[] = [];
  for (const [path, expected] of [
    [OUT_JS, bundle],
    [OUT_HTML, html],
  ] as const) {
    if (!existsSync(join(root, path))) {
      problems.push(`${path} is missing`);
      continue;
    }
    const actual = read(path);
    if (actual !== expected) {
      problems.push(`${path} is out of date (committed ${actual.length} bytes, rebuilt ${expected.length} bytes)`);
    }
  }
  if (problems.length > 0) {
    console.error('demo bundle is stale:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('run: node scripts/build-demo.ts');
    process.exit(1);
  }
  console.log(`demo bundle is current: ${modules.length} modules, ${bundle.length} bytes`);
} else {
  mkdirSync(join(root, 'docs', 'demo'), { recursive: true });
  writeFileSync(join(root, OUT_JS), bundle, 'utf8');
  writeFileSync(join(root, OUT_HTML), html, 'utf8');
  console.log(`built ${OUT_JS} (${bundle.length} bytes)`);
  console.log(`built ${OUT_HTML} (${html.length} bytes)`);
  console.log(`modules: ${modules.map((m) => m.id).join(', ')}`);
  console.log(`relative to repo root: ${relative(root, root)}`);
}
