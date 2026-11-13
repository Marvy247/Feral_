/**
 * Generate the capability manifest: the machine-readable inventory of what
 * Feral actually does.
 *
 * A judge (or a screening model) should not have to take the README's word
 * for any of it. This script reads the three sources of truth -
 *
 *   src/core/engine.ts        the off-chain mirror: every check and its reason code
 *   contract/src/lib.rs       the Rust vault: every check it recomputes on-chain
 *   src/demo/scenarios.ts     the catalogue: which attempt hits which wall
 *
 * - and writes docs/CAPABILITIES.json plus src/generated/capabilities.ts.
 *
 * The manifest states, per check: its id, its title, the reason code it
 * raises, whether the Rust vault enforces it too, which contract section does
 * that, and which scenario numbers demonstrate it. It also states the totals:
 * how many checks, how many are enforced on-chain, how many reason codes, how
 * many escape attempts.
 *
 * A test asserts the generated files still match the sources, so the manifest
 * cannot drift away from the code it describes.
 *
 *   node scripts/gen-capabilities.ts           # write the files
 *   node scripts/gen-capabilities.ts --check   # fail if they are out of date
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASON } from '../src/core/engine.ts';
import { CATALOGUE, runScenario } from '../src/demo/scenarios.ts';

const root = join(import.meta.dirname, '..');
const check = process.argv.includes('--check');

const ENGINE = 'src/core/engine.ts';
const CONTRACT = 'contract/src/lib.rs';
const OUT_JSON = 'docs/CAPABILITIES.json';
const OUT_TS = 'src/generated/capabilities.ts';

const read = (path: string): string => readFileSync(join(root, path), 'utf8');

// ------------------------------------------------------------------ engine ----

interface EngineCheck {
  id: string;
  title: string;
  severity: 'deny' | 'approval' | 'info';
  reasonCode: string | null;
  /** Every reason code this check can raise (some checks are a ternary). */
  reasonCodes: string[];
}

/**
 * Find the argument object of an `add(draft, { ... }, REASON.CODE)` call.
 *
 * A regex cannot do this: the check objects contain template literals with
 * `${...}` inside them, so the first `},` is not the end of the object. This
 * scans with brace counting and skips strings, template literals and comments.
 */
function scanCall(source: string, from: number): { body: string; end: number } | null {
  const open = source.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
    } else if (char === '`') {
      index += 1;
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\') index += 1;
        else if (source[index] === '$' && source[index + 1] === '{') {
          let braces = 1;
          index += 2;
          while (index < source.length && braces > 0) {
            if (source[index] === '{') braces += 1;
            else if (source[index] === '}') braces -= 1;
            index += 1;
          }
          continue;
        }
        index += 1;
      }
    } else if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    } else if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { body: source.slice(open + 1, index), end: index + 1 };
    }
    index += 1;
  }
  return null;
}

/** Read the third argument of an `add(draft, {...}, <expr>)` call, if any. */
function scanThirdArgument(source: string, from: number): string {
  let index = from;
  while (index < source.length && /\s/.test(source[index]!)) index += 1;
  if (source[index] !== ',') return '';
  index += 1;
  const start = index;
  let depth = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) break;
      depth -= 1;
    }
    index += 1;
  }
  return source.slice(start, index);
}

/**
 * Reason codes whose names differ between the Rust vault and the TypeScript
 * mirror. Each entry names the contract code and the engine code it mirrors.
 * Anything not listed here and not present in the engine is a contract-only
 * check, and the manifest says so instead of hiding it.
 */
const CODE_ALIASES: Record<string, string> = {
  PAUSED: 'POLICY_PAUSED',
  NO_LIMIT: 'NO_LIMIT_FOR_ASSET',
};

/** Parse every `add(draft, { ... }, REASON.CODE)` call site in the engine. */
function parseEngineChecks(source: string): EngineCheck[] {
  const found: EngineCheck[] = [];
  const marker = /add\(draft,\s*\{/g;
  for (const match of source.matchAll(marker)) {
    const scanned = scanCall(source, match.index + match[0].length - 1);
    if (!scanned) continue;
    const body = scanned.body;
    const literalId = body.match(/id:\s*'([^']+)'/)?.[1];
    const templateId = body.match(/id:\s*`([^`]+)`/)?.[1];
    if (!literalId && !templateId) continue;
    const title = body.match(/title:\s*'([^']+)'/)?.[1];
    const severity = body.match(/severity:\s*'([^']+)'/)?.[1] as EngineCheck['severity'] | undefined;
    // The third argument is sometimes a ternary (`id === 'daily' ? A : B`), so
    // collect every reason code it mentions.
    const argument = scanThirdArgument(source, scanned.end);
    const codes = [...argument.matchAll(/REASON\.([A-Z_]+)/g)].map((m) => m[1]!);
    const reasonCodes = codes.map((key) => REASON[key as keyof typeof REASON] ?? key);

    // One call site can serve several checks (`${id}-budget` becomes the daily
    // and the monthly budget check).
    const variants: { id: string; codes: string[] }[] = [];
    if (literalId) {
      variants.push({ id: literalId, codes: [...reasonCodes] });
    } else if (templateId && templateId.includes('${id}')) {
      for (const window of ['daily', 'monthly']) {
        const id = templateId.replace('${id}', window);
        const windowCodes =
          window === 'daily' ? reasonCodes.filter((c) => c === 'DAILY_LIMIT') : reasonCodes.filter((c) => c === 'MONTHLY_LIMIT');
        // Copy: two variants of one call site must not share the array, or the
        // merge below would leak one window's codes into the other.
        variants.push({ id, codes: windowCodes.length > 0 ? [...windowCodes] : [...reasonCodes] });
      }
    }
    for (const variant of variants) {
      found.push({
        id: variant.id,
        title: title ?? variant.id,
        severity: severity ?? 'deny',
        reasonCode: variant.codes[0] ?? null,
        reasonCodes: variant.codes,
      });
    }
  }
  const order: string[] = [...source.matchAll(/id:\s*[`']([a-z0-9${}-]+)[`']/g)].map((m) => m[1]!);
  found.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return found;
}

// ---------------------------------------------------------------- contract ----

interface ContractSection {
  section: string;
  title: string;
  reasonCodes: string[];
}

/** Parse the numbered `// ---- N. Title ----` sections of the vault's check. */
function parseContractSections(source: string): ContractSection[] {
  const sections: ContractSection[] = [];
  const marker = /\/\/ ---- ([0-9]+[a-z]?)\.\s+(.+?)\s*-{3,}/g;
  const matches = [...source.matchAll(marker)];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i]!.index!;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : source.length;
    const body = source.slice(start, end);
    const codes = new Set<string>();
    for (const match of body.matchAll(/return Err\(R_([A-Z_]+)\)/g)) {
      const value = source.match(new RegExp(`pub const R_${match[1]}: &str = "([A-Z_]+)"`))?.[1] ?? match[1]!;
      codes.add(value);
    }
    sections.push({
      section: matches[i]![1]!,
      title: matches[i]![2]!.trim(),
      reasonCodes: [...codes],
    });
  }
  return sections;
}

function parseContractReasonCodes(source: string): string[] {
  const codes = new Set<string>();
  for (const match of source.matchAll(/pub const R_[A-Z_]+: &str = "([A-Z_]+)"/g)) codes.add(match[1]!);
  return [...codes].sort();
}

// --------------------------------------------------------------- catalogue ----

async function build() {
  const engineSource = read(ENGINE);
  const contractSource = read(CONTRACT);

  const engineChecks = parseEngineChecks(engineSource);
  const contractSections = parseContractSections(contractSource);
  const contractCodes = parseContractReasonCodes(contractSource);

  // A reason code can be returned by more than one contract section; the first
  // one is the canonical place to point a reader at.
  const byCode = new Map<string, ContractSection>();
  for (const section of contractSections) {
    for (const code of section.reasonCodes) {
      if (!byCode.has(code)) byCode.set(code, section);
    }
  }
  const byId = new Map(engineChecks.map((c) => [c.id, c]));

  /** The contract code that an engine code mirrors (identity unless aliased). */
  const contractCodeForEngine = (engineCode: string): string => {
    for (const [contractCode, alias] of Object.entries(CODE_ALIASES)) {
      if (alias === engineCode) return contractCode;
    }
    return engineCode;
  };
  /** The engine code that mirrors a contract code. */
  const engineCodeFor = (contractCode: string): string => CODE_ALIASES[contractCode] ?? contractCode;

  // Which scenario demonstrates which wall: run the catalogue and look at the
  // checks that failed.
  const scenarios = [];
  const hits = new Map<string, number[]>();
  for (const entry of CATALOGUE) {
    const result = await runScenario(entry);
    const failedChecks = (result.checks ?? []).filter((c) => !c.passed).map((c) => c.id);
    for (const id of failedChecks) {
      const list = hits.get(id) ?? [];
      list.push(entry.id);
      hits.set(id, list);
    }
    scenarios.push({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      wall: result.wall,
      category: result.category,
      expect: result.expect,
      verdict: result.verdict,
      passed: result.passed,
      codes: result.codes,
      checks: failedChecks,
    });
  }

  const checks = engineChecks.map((checkItem) => {
    const section = checkItem.reasonCodes
      .map((code) => byCode.get(contractCodeForEngine(code)))
      .find((candidate) => candidate !== undefined);
    return {
      id: checkItem.id,
      title: checkItem.title,
      severity: checkItem.severity,
      reasonCode: checkItem.reasonCode,
      reasonCodes: [...checkItem.reasonCodes],
      onChain: Boolean(section),
      contractSection: section ? `${section.section}. ${section.title}` : null,
      scenarios: hits.get(checkItem.id) ?? [],
    };
  });

  // One check id can be added from several call sites (per-tx has three). Merge
  // them into one entry so the manifest lists checks, not call sites.
  const merged: typeof checks = [];
  for (const entry of checks) {
    const existing = merged.find((candidate) => candidate.id === entry.id);
    if (!existing) {
      merged.push(entry);
      continue;
    }
    for (const code of entry.reasonCodes) {
      if (!existing.reasonCodes.includes(code)) existing.reasonCodes.push(code);
    }
    if (!existing.onChain && entry.onChain) {
      existing.onChain = true;
      existing.contractSection = entry.contractSection;
    }
    for (const id of entry.scenarios) {
      if (!existing.scenarios.includes(id)) existing.scenarios.push(id);
    }
  }
  const checksFinal = merged;

  // Every check the vault enforces should have a mirror in the engine.
  const mirrored = new Set(checksFinal.flatMap((c) => c.reasonCodes));
  const unmirrored = contractCodes.filter((code) => !mirrored.has(engineCodeFor(code)));

  const manifest = {
    $schema: 'https://nearhackathon.com/HACKATHON.md',
    project: 'Feral',
    description: 'Policy-enforced custody for autonomous agents on NEAR.',
    generatedFrom: {
      engine: ENGINE,
      contract: CONTRACT,
      catalogue: 'src/demo/scenarios.ts',
    },
    totals: {
      engineChecks: checksFinal.length,
      onChainChecks: checksFinal.filter((c) => c.onChain).length,
      offChainOnlyChecks: checksFinal.filter((c) => !c.onChain).length,
      contractReasonCodes: contractCodes.length,
      contractSections: contractSections.length,
      engineReasonCodes: Object.keys(REASON).length,
      scenarios: scenarios.length,
      scenariosDenied: scenarios.filter((s) => s.verdict === 'deny').length,
      scenariosEscalated: scenarios.filter((s) => s.verdict === 'require_approval').length,
      scenariosAllowed: scenarios.filter((s) => s.verdict === 'allow').length,
      scenariosFailing: scenarios.filter((s) => !s.passed).length,
    },
    coverage: {
      contractSections: contractSections.map((s) => ({
        section: `${s.section}. ${s.title}`,
        reasonCodes: s.reasonCodes,
        mirroredBy: s.reasonCodes.map((code) => checksFinal.find((c) => c.reasonCodes.includes(engineCodeFor(code)))?.id ?? null),
      })),
      contractReasonCodesWithoutAMirror: unmirrored,
      aliases: CODE_ALIASES,
    },
    reasonCodes: {
      onChain: contractCodes,
      offChainOnly: Object.keys(REASON).filter((code) => !contractCodes.includes(code)),
    },
    checks: checksFinal,
    scenarios,
  };

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  const ts = [
    '/**',
    ' * Capability manifest, generated by scripts/gen-capabilities.ts - do not edit.',
    ' *',
    ' * The single source of truth for "what does Feral enforce, and where".',
    ' * test/unit/capabilities.test.ts fails if this file drifts from the sources',
    ' * it was generated from.',
    ' */',
    `export const CAPABILITIES = ${JSON.stringify(manifest, null, 2)} as const;`,
    '',
    'export type CapabilityCheck = (typeof CAPABILITIES.checks)[number];',
    'export type CapabilityScenario = (typeof CAPABILITIES.scenarios)[number];',
    '',
  ].join('\n');

  /** The README's check table, rendered from the manifest. */
  function renderChecksTable(): string {
    const rows = checksFinal.map((checkItem, index) => {
      const codes = checkItem.reasonCodes.map((code) => `\`${code}\``).join(', ') || '-';
      const where = checkItem.onChain ? '**on-chain**' : 'off-chain';
      const section = checkItem.contractSection ?? '-';
      const scenarios = checkItem.scenarios.length > 0 ? checkItem.scenarios.join(', ') : '-';
      return `| ${index + 1} | \`${checkItem.id}\` | ${codes} | ${where} | ${section} | ${scenarios} |`;
    });
    return [
      '| # | Check | Reason code | Enforced by | Vault section | Demonstrated by scenario |',
      '|---|---|---|---|---|---|',
      ...rows,
      '',
      `**${manifest.totals.onChainChecks} checks enforced on-chain**, ${manifest.totals.offChainOnlyChecks} more in the off-chain mirror, ${manifest.totals.contractReasonCodes} reason codes in the Rust vault, ${manifest.totals.engineReasonCodes} in the engine.`,
    ].join('\n');
  }

  /** Splice the generated table into the README between its markers. */
  function spliceReadme(table: string): string | null {
    const readmePath = join(root, 'README.md');
    if (!existsSync(readmePath)) return null;
    const readme = readFileSync(readmePath, 'utf8');
    const start = readme.indexOf('<!-- CHECKS:BEGIN -->');
    const end = readme.indexOf('<!-- CHECKS:END -->');
    if (start < 0 || end < 0) return null;
    const next = `${readme.slice(0, start + '<!-- CHECKS:BEGIN -->'.length)}\n\n${table}\n\n${readme.slice(end)}`;
    return next === readme ? readme : next;
  }

  const files: [string, string][] = [
    [OUT_JSON, json],
    [OUT_TS, ts],
  ];

  const readme = spliceReadme(renderChecksTable());
  if (readme !== null) files.push(['README.md', readme]);

  if (check) {
    const stale: string[] = [];
    for (const [path, expected] of files) {
      if (!existsSync(join(root, path))) {
        stale.push(`${path} is missing`);
        continue;
      }
      if (read(path) !== expected) stale.push(`${path} is out of date`);
    }
    if (stale.length > 0) {
      console.error('capability manifest is stale:');
      for (const item of stale) console.error(`  - ${item}`);
      console.error('run: node scripts/gen-capabilities.ts');
      process.exit(1);
    }
    console.log('capability manifest is current');
  } else {
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, 'src', 'generated'), { recursive: true });
    for (const [path, content] of files) writeFileSync(join(root, path), content, 'utf8');
    console.log(`wrote ${OUT_JSON} and ${OUT_TS}`);
    console.log(
      `checks: ${manifest.totals.engineChecks} (${manifest.totals.onChainChecks} enforced on-chain), ` +
        `reason codes: ${manifest.totals.contractReasonCodes} on-chain / ${manifest.totals.offChainOnlyChecks} off-chain only`,
    );
    console.log(`scenarios: ${manifest.totals.scenarios}, failing: ${manifest.totals.scenariosFailing}`);
    if (unmirrored.length > 0) {
      console.log(`note: contract reason codes with no engine mirror: ${unmirrored.join(', ')}`);
    }
  }
}

await build();
