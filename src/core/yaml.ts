/**
 * A small, strict YAML subset parser.
 *
 * Policies are written by humans, so YAML beats JSON for readability. The
 * subset is deliberately tiny — maps, lists, inline arrays, scalars, comments —
 * and it rejects anything it does not understand instead of guessing. A
 * security policy that is silently half-parsed is worse than one that fails to
 * load.
 */

export class YamlError extends Error {
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = 'YamlError';
  }
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

function stripComment(input: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#' && (i === 0 || input[i - 1] === ' ' || input[i - 1] === '\t')) break;
    out += ch;
  }
  return out.replace(/[ \t]+$/, '');
}

function splitInlineList(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

function unquote(value: string, lineNo: number): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1);
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    throw new YamlError(`unterminated quoted string: ${value}`, lineNo);
  }
  return value;
}

export function parseScalar(raw: string, lineNo: number): unknown {
  const value = raw.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return splitInlineList(inner).map((item) => parseScalar(item, lineNo));
  }
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  return unquote(value, lineNo);
}

function tokenize(source: string): Line[] {
  const lines: Line[] = [];
  const raw = source.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < raw.length; i++) {
    const noComment = stripComment(raw[i]);
    if (noComment.trim() === '') continue;
    const indent = noComment.length - noComment.trimStart().length;
    if (noComment.includes('\t')) throw new YamlError('tabs are not allowed for indentation', i + 1);
    lines.push({ indent, text: noComment.trim(), no: i + 1 });
  }
  return lines;
}

function parseMapEntry(text: string, lineNo: number): { key: string; rest: string } {
  const colon = text.indexOf(':');
  if (colon <= 0) throw new YamlError(`expected "key: value", got "${text}"`, lineNo);
  const key = unquote(text.slice(0, colon).trim(), lineNo);
  if (key === '') throw new YamlError('empty key', lineNo);
  return { key, rest: text.slice(colon + 1).trim() };
}

function parseBlock(lines: Line[], start: number, indent: number): { value: unknown; next: number } {
  if (start >= lines.length) return { value: null, next: start };
  const first = lines[start];
  if (first.indent !== indent) {
    throw new YamlError(`unexpected indentation (expected ${indent}, got ${first.indent})`, first.no);
  }
  if (first.text === '-' || first.text.startsWith('- ')) {
    return parseList(lines, start, indent);
  }
  return parseMap(lines, start, indent);
}

function parseList(lines: Line[], start: number, indent: number): { value: unknown[]; next: number } {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation inside list', line.no);
    if (!(line.text === '-' || line.text.startsWith('- '))) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseBlock(lines, i + 1, lines[i + 1].indent);
        items.push(nested.value);
        i = nested.next;
      } else {
        items.push(null);
        i++;
      }
      continue;
    }
    // List item that is itself a map entry: "- key: value" possibly followed by more keys.
    if (rest.includes(':') && !rest.startsWith('[') && !rest.startsWith('"') && !rest.startsWith("'")) {
      const { key, rest: valueText } = parseMapEntry(rest, line.no);
      const entry: Record<string, unknown> = {};
      const itemIndent = line.indent + 2;
      if (valueText === '') {
        if (i + 1 < lines.length && lines[i + 1].indent > itemIndent) {
          const nested = parseBlock(lines, i + 1, lines[i + 1].indent);
          entry[key] = nested.value;
          i = nested.next;
        } else {
          entry[key] = null;
          i++;
        }
      } else {
        entry[key] = parseScalar(valueText, line.no);
        i++;
      }
      // Remaining keys of the same map item.
      while (i < lines.length && lines[i].indent === itemIndent && !lines[i].text.startsWith('- ')) {
        const extra = parseMapEntry(lines[i].text, lines[i].no);
        if (extra.rest === '') {
          if (i + 1 < lines.length && lines[i + 1].indent > itemIndent) {
            const nested = parseBlock(lines, i + 1, lines[i + 1].indent);
            entry[extra.key] = nested.value;
            i = nested.next;
          } else {
            entry[extra.key] = null;
            i++;
          }
        } else {
          entry[extra.key] = parseScalar(extra.rest, lines[i].no);
          i++;
        }
      }
      items.push(entry);
      continue;
    }
    items.push(parseScalar(rest, line.no));
    i++;
  }
  return { value: items, next: i };
}

function parseMap(lines: Line[], start: number, indent: number): { value: Record<string, unknown>; next: number } {
  const map: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation inside map', line.no);
    if (line.text.startsWith('- ')) break;
    const { key, rest } = parseMapEntry(line.text, line.no);
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseBlock(lines, i + 1, lines[i + 1].indent);
        map[key] = nested.value;
        i = nested.next;
      } else {
        map[key] = null;
        i++;
      }
    } else {
      map[key] = parseScalar(rest, line.no);
      i++;
    }
  }
  return { value: map, next: i };
}

export function parseYaml(source: string): unknown {
  const lines = tokenize(source);
  if (lines.length === 0) return null;
  const result = parseBlock(lines, 0, lines[0].indent);
  if (result.next !== lines.length) {
    throw new YamlError('trailing content after document', lines[result.next].no);
  }
  return result.value;
}

/** Parse either JSON or YAML, whichever the text looks like. */
export function parseConfig(source: string): unknown {
  const trimmed = source.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new YamlError(`invalid JSON: ${(err as Error).message}`);
    }
  }
  return parseYaml(source);
}
