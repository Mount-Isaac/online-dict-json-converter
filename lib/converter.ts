export type Format = "json" | "python";

export interface ConvertOptions {
  sortKeys?: boolean;
  minify?: boolean;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function jsonToPythonDict(input: string, opts: ConvertOptions = {}): string {
  const parsed = JSON.parse(input);
  return valueToPython(opts.sortKeys ? sortObject(parsed) : parsed, 0, opts);
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
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "none" }
  | { type: "punct"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }

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
      tokens.push({ type: "string", value: str });
      continue;
    }

    if (/[-\d]/.test(src[i]) && !(src[i] === "-" && !/\d/.test(src[i + 1] ?? ""))) {
      let num = "";
      if (src[i] === "-") num += src[i++];
      while (i < src.length && /[\d.eE+\-]/.test(src[i])) num += src[i++];
      tokens.push({ type: "number", value: Number(num) });
      continue;
    }

    if (src.startsWith("True", i) || src.startsWith("true", i))   { tokens.push({ type: "bool", value: true });  i += 4; continue; }
    if (src.startsWith("False", i) || src.startsWith("false", i)) { tokens.push({ type: "bool", value: false }); i += 5; continue; }
    if (src.startsWith("None", i) || src.startsWith("null", i))   { tokens.push({ type: "none" });               i += 4; continue; }

    if ("{}[]():,".includes(src[i])) { tokens.push({ type: "punct", value: src[i] }); i++; continue; }
    i++;
  }

  return tokens;
}

// ── Recursive descent parser ───────────────────────────────────────────────

function parseValue(tokens: Token[], pos: number): [unknown, number] {
  const tok = tokens[pos];
  if (!tok) throw new Error("Unexpected end of input");
  if (tok.type === "string") return [tok.value, pos + 1];
  if (tok.type === "number") return [tok.value, pos + 1];
  if (tok.type === "bool")   return [tok.value, pos + 1];
  if (tok.type === "none")   return [null,       pos + 1];
  if (tok.type === "punct" && tok.value === "{") return parseDict(tokens, pos);
  if (tok.type === "punct" && tok.value === "[") return parseList(tokens, pos);
  if (tok.type === "punct" && tok.value === "(") return parseTuple(tokens, pos);
  throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
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
    if (tokens[pos]?.type === "punct" && (tokens[pos] as {type:string;value:string}).value === ":") pos++;
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
