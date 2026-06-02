export type Format = "json" | "python";

export interface ConvertOptions {
  sortKeys?: boolean;
  minify?: boolean;
}

// ── Parse error with source position ──────────────────────────────────────

export class ParseError extends Error {
  readonly from: number;
  readonly to: number;
  constructor(message: string, from: number, to: number) {
    super(message);
    this.name = "ParseError";
    this.from = from;
    this.to = to;
  }
}

export interface JsonSyntaxError {
  from: number;
  to: number;
  message: string;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function jsonToPythonDict(input: string, opts: ConvertOptions = {}): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (e) {
    const msg = (e as Error).message;
    // Our scanner gives the most useful position for UI highlighting (e.g. it
    // returns the start of the "next key used as value" rather than the stray ":").
    // Use it first; fall back to the "at position N" the runtime may provide.
    const found = findJsonErrorPos(input);
    if (found) throw new ParseError(msg, found.from, found.to);
    const posMatch = msg.match(/\bat position (\d+)/i);
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      throw new ParseError(msg, pos, pos + 1);
    }
    throw e;
  }
  return valueToPython(opts.sortKeys ? sortObject(parsed) : parsed, 0, opts);
}

// Minimal JSON scanner — returns the char range of the first syntax error.
// Only runs after JSON.parse has already rejected the input.
function findJsonErrorPos(src: string): { from: number; to: number } | null {
  let i = 0;

  function ws() { while (i < src.length && " \t\n\r".includes(src[i])) i++; }

  // Returns null on clean scan, error range on bad string.
  function scanStr(): { from: number; to: number } | null {
    const start = i++;
    while (i < src.length) {
      if (src[i] === "\n") return { from: start, to: i }; // unclosed — newline in string
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === '"')  { i++; return null; }
      i++;
    }
    return { from: start, to: i }; // unclosed at EOF
  }

  function scanValue(): { from: number; to: number } | null {
    ws();
    if (i >= src.length) return null;
    if (src[i] === '"')  return scanStr();
    if (src[i] === '{')  return scanObject();
    if (src[i] === '[')  return scanArray();
    if (src.startsWith("true",  i)) { i += 4; return null; }
    if (src.startsWith("false", i)) { i += 5; return null; }
    if (src.startsWith("null",  i)) { i += 4; return null; }
    if (/[-\d]/.test(src[i])) {
      while (i < src.length && /[\d.eE+\-]/.test(src[i])) i++;
      return null;
    }
    // Unknown identifier (Python keywords, unquoted values, etc.)
    const start = i;
    while (i < src.length && /[A-Za-z_]/.test(src[i])) i++;
    return { from: start, to: i > start ? i : start + 1 };
  }

  function scanObject(): { from: number; to: number } | null {
    i++; ws();
    if (i < src.length && src[i] === "}") { i++; return null; }
    while (i < src.length) {
      ws(); if (i >= src.length) break;
      // Key must be a quoted string
      if (src[i] !== '"') return { from: i, to: i + 1 };
      const keyErr = scanStr(); if (keyErr) return keyErr;
      ws();
      // Colon separator
      if (i >= src.length || src[i] !== ":") return { from: i, to: i + 1 };
      i++;
      // Value
      ws();
      const valStart = i;             // remember start of value token
      const err = scanValue();
      if (err) return err;
      const valEnd = i;               // end of successfully scanned value
      ws(); if (i >= src.length) break;
      if (src[i] === "}") { i++; return null; }
      if (src[i] !== ",") {
        // If next char is ":" the "value" we just scanned is actually the NEXT
        // key — report its span so the heuristic can jump back to the bad line.
        if (src[i] === ":") return { from: valStart, to: valEnd };
        return { from: i, to: i + 1 };
      }
      i++;
    }
    return null;
  }

  function scanArray(): { from: number; to: number } | null {
    i++; ws();
    if (i < src.length && src[i] === "]") { i++; return null; }
    while (i < src.length) {
      const err = scanValue(); if (err) return err;
      ws(); if (i >= src.length) break;
      if (src[i] === "]") { i++; return null; }
      if (src[i] !== ",") return { from: i, to: i + 1 };
      i++;
    }
    return null;
  }

  try { return scanValue(); } catch { return null; }
}

// ── Compiler-style: collect ALL JSON errors with recovery ─────────────────

export function findAllJsonErrors(src: string): JsonSyntaxError[] {
  const errors: JsonSyntaxError[] = [];
  let i = 0;

  function ws() { while (i < src.length && " \t\n\r".includes(src[i])) i++; }

  function pushError(msg: string, from: number, to: number) {
    const clampedTo = Math.max(to, from + 1);
    if (!errors.some(e => e.from === from)) {
      errors.push({ from, to: clampedTo, message: msg });
    }
  }

  function scanStr(): boolean {
    const start = i++;
    while (i < src.length) {
      if (src[i] === "\n") { pushError("Unclosed string", start, i); return false; }
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === '"')  { i++; return true; }
      i++;
    }
    pushError("Unclosed string", start, i);
    return false;
  }

  function scanValue(): boolean {
    ws();
    if (i >= src.length) return false;
    if (src[i] === '"')  return scanStr();
    if (src[i] === '{')  return scanObject();
    if (src[i] === '[')  return scanArray();
    if (src.startsWith("true",  i)) { i += 4; return true; }
    if (src.startsWith("false", i)) { i += 5; return true; }
    if (src.startsWith("null",  i)) { i += 4; return true; }
    if (/[-\d]/.test(src[i])) {
      while (i < src.length && /[\d.eE+\-]/.test(src[i])) i++;
      return true;
    }
    // Unknown identifier (Python keywords, unquoted values, etc.)
    const start = i;
    while (i < src.length && /[A-Za-z_]/.test(src[i])) i++;
    const end = i > start ? i : start + 1;
    pushError(`Unexpected identifier`, start, end);
    i = end;
    return false;
  }

  /** Skip to the next key (`"`), comma, or closing `}` at depth 0. */
  function resyncInObject() {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '{' || ch === '[') { depth++; i++; }
      else if (ch === '}' || ch === ']') {
        if (depth === 0) return; // let outer loop handle
        depth--; i++;
      }
      else if (depth === 0 && ch === ',') { i++; return; }
      else if (depth === 0 && ch === '"') return;
      else i++;
    }
  }

  function scanObject(): boolean {
    i++; ws();
    if (i < src.length && src[i] === "}") { i++; return true; }
    while (i < src.length) {
      ws();
      if (i >= src.length) break;
      if (src[i] === "}") { i++; return true; }
      if (src[i] === ",") { i++; continue; }

      // Key must be a quoted string
      if (src[i] !== '"') {
        const errStart = i;
        while (i < src.length && src[i] !== ':' && src[i] !== ',' && src[i] !== '}' && src[i] !== '"' && src[i] !== '\n') i++;
        pushError("Keys must be quoted strings", errStart, i);
        if (i < src.length && src[i] === ':') {
          i++; ws();
          const valStart = i;
          scanValue();
          const valEnd = i; ws();
          if (i < src.length && src[i] === ':') {
            pushError("Missing value for key", valStart, valEnd);
            i = valStart; continue;
          }
        }
        resyncInObject(); continue;
      }

      if (!scanStr()) { resyncInObject(); continue; }
      ws();

      // Colon separator
      if (i >= src.length || src[i] !== ':') {
        pushError("Expected ':' after key", i, i + 1);
        resyncInObject(); continue;
      }
      i++;

      // Value
      ws();
      const valStart = i;
      scanValue();
      const valEnd = i;
      ws();

      if (i >= src.length) break;
      if (src[i] === "}") { i++; return true; }
      if (src[i] === ":") {
        // The "value" we scanned was actually the next key
        pushError("Missing value for key", valStart, valEnd);
        i = valStart; continue;
      }
      if (src[i] !== ",") {
        pushError("Expected ',' or '}'", i, i + 1);
        if (src[i] === '"') continue; // treat next `"` as next key
        i++;
      } else {
        i++;
      }
    }
    return errors.length === 0;
  }

  function scanArray(): boolean {
    i++; ws();
    if (i < src.length && src[i] === "]") { i++; return true; }
    while (i < src.length) {
      if (!scanValue()) {
        let depth = 0;
        while (i < src.length) {
          const ch = src[i];
          if (ch === '{' || ch === '[') { depth++; i++; }
          else if (ch === ']') { if (depth === 0) break; depth--; i++; }
          else if (ch === '}') { if (depth > 0) { depth--; } i++; }
          else if (depth === 0 && ch === ',') { i++; break; }
          else i++;
        }
        continue;
      }
      ws();
      if (i >= src.length) break;
      if (src[i] === "]") { i++; return true; }
      if (src[i] !== ",") {
        pushError("Expected ',' or ']'", i, i + 1);
        if (src[i] === ']') { i++; return true; }
        i++;
      } else {
        i++;
      }
    }
    return true;
  }

  try { scanValue(); } catch { /* ignore */ }
  return errors;
}

export function pythonDictToJson(input: string, opts: ConvertOptions = {}): string {
  const tokens = tokenize(input);
  const [value] = parseValue(tokens, 0);
  const sorted = opts.sortKeys ? sortObject(value) : value;
  return JSON.stringify(sorted, null, opts.minify ? undefined : 2);
}

/** Format JSON in-place (pretty or minify, optionally sort keys). */
export function formatJson(input: string, opts: ConvertOptions = {}): string {
  const parsed = JSON.parse(input);
  const val = opts.sortKeys ? sortObject(parsed) : parsed;
  return JSON.stringify(val, null, opts.minify ? undefined : 2);
}

/** Format Python dict in-place (re-indent or minify, optionally sort keys). */
export function formatPythonDict(input: string, opts: ConvertOptions = {}): string {
  const tokens = tokenize(input);
  const [value] = parseValue(tokens, 0);
  return valueToPython(opts.sortKeys ? sortObject(value) : value, 0, opts);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sortObject(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortObject);
  if (val !== null && typeof val === "object") {
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortObject(v)])
    );
  }
  return val;
}

function valueToPython(val: unknown, indent: number, opts: ConvertOptions): string {
  const { minify = false } = opts;
  const pad      = minify ? "" : "    ".repeat(indent);
  const innerPad = minify ? "" : "    ".repeat(indent + 1);

  if (val === null) return "None";
  if (typeof val === "boolean") return val ? "True" : "False";
  if (typeof val === "number") return String(val);
  if (typeof val === "string") return pythonString(val);

  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    if (minify) return `[${val.map((v) => valueToPython(v, 0, opts)).join(", ")}]`;
    const items = val.map((v) => innerPad + valueToPython(v, indent + 1, opts));
    return `[\n${items.join(",\n")}\n${pad}]`;
  }

  if (typeof val === "object") {
    const entries = Object.entries(val as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    if (minify) {
      return `{${entries.map(([k, v]) => `${pythonString(k)}: ${valueToPython(v, 0, opts)}`).join(", ")}}`;
    }
    const items = entries.map(
      ([k, v]) => `${innerPad}${pythonString(k)}: ${valueToPython(v, indent + 1, opts)}`
    );
    return `{\n${items.join(",\n")}\n${pad}}`;
  }

  return String(val);
}

function pythonString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

type Token =
  | { type: "string"; value: string; start: number; end: number }
  | { type: "number"; value: number; start: number; end: number }
  | { type: "bool";   value: boolean; start: number; end: number }
  | { type: "none";   start: number; end: number }
  | { type: "punct";  value: string; start: number; end: number };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    const start = i;

    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i++];
      let str = "";
      while (i < src.length) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const esc = src[i + 1];
          const escMap: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' };
          str += escMap[esc] ?? esc;
          i += 2;
        } else if (src[i] === quote) { i++; break; }
        else str += src[i++];
      }
      tokens.push({ type: "string", value: str, start, end: i });
      continue;
    }

    if (/[-\d]/.test(src[i]) && !(src[i] === "-" && !/\d/.test(src[i + 1] ?? ""))) {
      let num = "";
      if (src[i] === "-") num += src[i++];
      while (i < src.length && /[\d.eE+\-]/.test(src[i])) num += src[i++];
      tokens.push({ type: "number", value: Number(num), start, end: i });
      continue;
    }

    if (src.startsWith("True", i) || src.startsWith("true", i))   { tokens.push({ type: "bool", value: true,  start, end: i + 4 }); i += 4; continue; }
    if (src.startsWith("False", i) || src.startsWith("false", i)) { tokens.push({ type: "bool", value: false, start, end: i + 5 }); i += 5; continue; }
    if (src.startsWith("None", i)  || src.startsWith("null", i))  { tokens.push({ type: "none",               start, end: i + 4 }); i += 4; continue; }

    if ("{}[]():,".includes(src[i])) {
      tokens.push({ type: "punct", value: src[i], start, end: i + 1 });
      i++;
      continue;
    }
    i++;
  }

  return tokens;
}

// ── Recursive descent parser ───────────────────────────────────────────────

function parseValue(tokens: Token[], pos: number): [unknown, number] {
  const tok = tokens[pos];
  if (!tok) throw new ParseError("Unexpected end of input", -1, -1);
  if (tok.type === "string") return [tok.value, pos + 1];
  if (tok.type === "number") return [tok.value, pos + 1];
  if (tok.type === "bool")   return [tok.value, pos + 1];
  if (tok.type === "none")   return [null,       pos + 1];
  if (tok.type === "punct" && tok.value === "{") return parseDict(tokens, pos);
  if (tok.type === "punct" && tok.value === "[") return parseList(tokens, pos);
  if (tok.type === "punct" && tok.value === "(") return parseTuple(tokens, pos);
  throw new ParseError(
    `Unexpected token: ${JSON.stringify({ type: tok.type, value: (tok as { value?: unknown }).value })}`,
    tok.start,
    tok.end,
  );
}

function parseDict(tokens: Token[], pos: number): [Record<string, unknown>, number] {
  pos++;
  const obj: Record<string, unknown> = {};
  while (pos < tokens.length) {
    const tok = tokens[pos];
    if (tok.type === "punct" && tok.value === "}") return [obj, pos + 1];
    if (tok.type === "punct" && tok.value === ",") { pos++; continue; }
    const [key, pos2] = parseValue(tokens, pos);
    pos = pos2;
    if (tokens[pos]?.type === "punct" && (tokens[pos] as { type: string; value: string }).value === ":") pos++;
    const [val, pos3] = parseValue(tokens, pos);
    pos = pos3;
    obj[String(key)] = val;
  }
  return [obj, pos];
}

function parseList(tokens: Token[], pos: number): [unknown[], number] {
  pos++;
  const arr: unknown[] = [];
  while (pos < tokens.length) {
    const tok = tokens[pos];
    if (tok.type === "punct" && tok.value === "]") return [arr, pos + 1];
    if (tok.type === "punct" && tok.value === ",") { pos++; continue; }
    const [val, pos2] = parseValue(tokens, pos);
    arr.push(val); pos = pos2;
  }
  return [arr, pos];
}

function parseTuple(tokens: Token[], pos: number): [unknown[], number] {
  pos++;
  const arr: unknown[] = [];
  while (pos < tokens.length) {
    const tok = tokens[pos];
    if (tok.type === "punct" && tok.value === ")") return [arr, pos + 1];
    if (tok.type === "punct" && tok.value === ",") { pos++; continue; }
    const [val, pos2] = parseValue(tokens, pos);
    arr.push(val); pos = pos2;
  }
  return [arr, pos];
}

// ── Auto-detect ────────────────────────────────────────────────────────────

export function detectFormat(input: string): Format {
  const t = input.trim();
  if (/\bTrue\b|\bFalse\b|\bNone\b/.test(t)) return "python";
  if (/'[^']*'/.test(t)) return "python";
  if (t.startsWith("{") || t.startsWith("[")) {
    try { JSON.parse(t); return "json"; } catch { return "python"; }
  }
  return "json";
}
