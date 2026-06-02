"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import {
  EditorView, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, keymap, dropCursor, Decoration,
} from "@codemirror/view";
import {
  history, historyKeymap, defaultKeymap, indentWithTab,
} from "@codemirror/commands";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import {
  bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle,
  foldGutter, codeFolding, foldKeymap, foldService,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";
import {
  jsonToPythonDict, pythonDictToJson, formatJson, formatPythonDict,
  detectFormat, ParseError, findAllJsonErrors,
  type Format, type ConvertOptions,
} from "@/lib/converter";

// ── CodeMirror theme ───────────────────────────────────────────────────────

const editorTheme = createTheme({
  theme: "dark",
  settings: {
    background: "#1e2130",
    foreground: "#c8cfe0",
    caret: "#7c8cf8",
    selection: "#3a4060",
    selectionMatch: "#2e3450",
    lineHighlight: "#262b3e",
    gutterBackground: "#191d2c",
    gutterForeground: "#404660",
    gutterBorder: "#252a3a",
    gutterActiveForeground: "#6e7aac",
  },
  styles: [
    { tag: t.string,       color: "#98c379" },
    { tag: t.number,       color: "#e5c07b" },
    { tag: t.bool,         color: "#c678dd" },
    { tag: t.null,         color: "#c678dd" },
    { tag: t.propertyName, color: "#61afef" },
    { tag: t.punctuation,  color: "#7a8099" },
    { tag: t.bracket,      color: "#abb2bf" },
    { tag: t.comment,      color: "#5c6370", fontStyle: "italic" },
  ],
});

const editorLayoutTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  ".cm-foldGutter .cm-gutterElement": {
    cursor: "pointer",
    color: "#4a5280",
    paddingLeft: "3px",
    userSelect: "none",
  },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "#7c8cf8" },
  ".cm-foldPlaceholder": {
    background: "#2a2f42",
    border: "1px solid #363d54",
    color: "#7c8cf8",
    borderRadius: "3px",
    padding: "0 4px",
    cursor: "pointer",
    fontSize: "11px",
  },
  ".cm-error-line": {
    background: "rgba(239,68,68,0.18)",
    borderLeft: "3px solid #ef4444",
  },
  ".cm-error-highlight": {
    background: "rgba(239,68,68,0.42)",
    borderBottom: "2px solid #ef4444",
    borderRadius: "2px",
  },
});

// Bracket-based fold service — works for both JSON { } / [ ] and Python dict
const bracketFold = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart);
  const trimmed = line.text.trimEnd();
  if (!trimmed) return null;
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar !== "{" && lastChar !== "[") return null;
  const closeChar = lastChar === "{" ? "}" : "]";
  let depth = 1;
  const rest = state.sliceDoc(line.to, state.doc.length);
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === lastChar) depth++;
    else if (ch === closeChar && --depth === 0) return { from: line.to, to: line.to + i };
  }
  return null;
});

const BASE_EXTENSIONS = [
  editorLayoutTheme,
  lineNumbers(),
  foldGutter(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  dropCursor(),
  bracketMatching(),
  closeBrackets(),
  indentOnInput(),
  bracketFold,
  codeFolding(),
  history(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  indentationMarkers(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
  EditorView.lineWrapping,
];

// ── Constants ──────────────────────────────────────────────────────────────

const EXAMPLES: Record<Format, string> = {
  json: `{
  "name": "Alice",
  "age": 30,
  "active": true,
  "score": null,
  "tags": ["python", "json"],
  "meta": {
    "verified": false,
    "level": 2
  }
}`,
  python: `{
    "name": "Alice",
    "age": 30,
    "active": True,
    "score": None,
    "tags": ["python", "json"],
    "meta": {
        "verified": False,
        "level": 2
    }
}`,
};

// ── Types ──────────────────────────────────────────────────────────────────

interface HistoryEntry {
  id: string;
  input: string;
  inputFormat: Format;
  ts: number;
}

// ── Utilities ──────────────────────────────────────────────────────────────

function convert(input: string, from: Format, opts: ConvertOptions): string {
  if (!input.trim()) return "";
  return from === "json" ? jsonToPythonDict(input, opts) : pythonDictToJson(input, opts);
}

function wrapOutput(raw: string, outputFormat: Format): string {
  if (!raw.trim()) return "";
  if (outputFormat === "python") {
    return `import json\n\ndata = ${raw}\n\n# serialize back to JSON\nprint(json.dumps(data, indent=2))`;
  }
  return `import json\n\n# parse JSON string into Python dict\ndata = json.loads("""\n${raw}\n""")`;
}

function encodeShare(input: string, fmt: Format): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify({ input, fmt }))));
}

function decodeShare(hash: string): { input: string; fmt: Format } | null {
  try {
    const obj = JSON.parse(decodeURIComponent(escape(atob(hash))));
    if (typeof obj.input === "string" && (obj.fmt === "json" || obj.fmt === "python")) return obj;
  } catch { /* ignore */ }
  return null;
}

function downloadFile(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function formatLabel(f: Format) { return f === "json" ? "JSON" : "Python dict"; }

function lineCharCount(s: string) {
  const lines = s ? s.split("\n").length : 0;
  return `${lines}L · ${s.length}c`;
}

// ── Component ──────────────────────────────────────────────────────────────

export default function Home() {
  const [inputFormat, setInputFormat] = useState<Format>("json");
  const [input, setInput]             = useState(EXAMPLES.json);
  const [sortKeys, setSortKeys]       = useState(false);
  const [minify, setMinify]           = useState(false);
  const [wrap, setWrap]               = useState(false);
  const [copied, setCopied]           = useState(false);
  const [sharedToast, setSharedToast] = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [history2, setHistory2]       = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [isDragOver, setIsDragOver]   = useState(false);
  const [swapBlocked, setSwapBlocked] = useState(false);
  const historyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved    = useRef<string>("");

  const outputFormat: Format = inputFormat === "json" ? "python" : "json";
  const opts: ConvertOptions = { sortKeys, minify };

  let rawOutput = "";
  let convertError: string | null = null;

  // Each entry is the final (heuristic-applied) position for one error.
  type ErrorMark = { from: number; to: number; lineStart: number };
  let syntaxErrors: ErrorMark[] = [];

  /** Apply the "go back one line" heuristic to a raw error position. */
  function applyHeuristic(rawFrom: number, rawTo: number): ErrorMark {
    let eFrom = Math.min(rawFrom, input.length);
    let eTo   = Math.min(rawTo,   input.length);
    let lineStart = input.lastIndexOf("\n", eFrom - 1) + 1;
    const charsBeforeOnLine = input.slice(lineStart, eFrom);
    if (charsBeforeOnLine.trim() === "" && lineStart > 0) {
      const prevNl      = lineStart - 1;
      const prevLnStart = input.lastIndexOf("\n", prevNl - 1) + 1;
      const prevLnText  = input.slice(prevLnStart, prevNl).trimEnd();
      const incomplete  = prevLnText.endsWith('"') || prevLnText.endsWith("'") || prevLnText.endsWith(":");
      if (incomplete) {
        lineStart = prevLnStart;
        const lead = prevLnText.length - prevLnText.trimStart().length;
        eFrom = prevLnStart + lead;
        eTo   = prevLnStart + prevLnText.trimEnd().length;
        if (eTo <= eFrom) { eFrom = prevLnStart; eTo = prevNl; }
      }
    }
    return { from: eFrom, to: eTo, lineStart };
  }

  if (input.trim()) {
    try { rawOutput = convert(input, inputFormat, opts); }
    catch (e) {
      convertError = (e as Error).message;
      if (inputFormat === "json") {
        // Compiler-style: collect ALL errors from the JSON source.
        const allErrors = findAllJsonErrors(input);
        if (allErrors.length > 0) {
          syntaxErrors = allErrors.map(err => applyHeuristic(err.from, err.to));
        } else if (e instanceof ParseError && (e as ParseError).from >= 0) {
          // Fallback to the single ParseError if scanner found nothing.
          syntaxErrors = [applyHeuristic((e as ParseError).from, (e as ParseError).to)];
        }
      } else if (e instanceof ParseError && (e as ParseError).from >= 0) {
        // Python dict: single error from the recursive-descent parser.
        syntaxErrors = [applyHeuristic((e as ParseError).from, (e as ParseError).to)];
      }
    }
  }
  const displayOutput = wrap ? wrapOutput(rawOutput, outputFormat) : rawOutput;
  const hasError = !!(error || convertError);
  const isValid  = !!input.trim() && !hasError && !convertError;

  // ── Load from URL hash on mount ──
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const decoded = decodeShare(hash);
    if (decoded) { setInput(decoded.input); setInputFormat(decoded.fmt); }
  }, []);

  // ── Auto-save history (debounced 2s after typing stops) ──
  useEffect(() => {
    if (!isValid || input === lastSaved.current) return;
    if (historyTimer.current) clearTimeout(historyTimer.current);
    historyTimer.current = setTimeout(() => {
      lastSaved.current = input;
      setHistory2((prev) => {
        const entry: HistoryEntry = { id: Date.now().toString(), input, inputFormat, ts: Date.now() };
        return [entry, ...prev.filter((e) => e.input !== input)].slice(0, 8);
      });
    }, 2000);
    return () => { if (historyTimer.current) clearTimeout(historyTimer.current); };
  }, [input, inputFormat, isValid]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if (e.shiftKey && e.key === "F") { e.preventDefault(); handleFormat(); }
      if (e.shiftKey && e.key === "M") { e.preventDefault(); setMinify((v) => !v); }
      if (e.shiftKey && e.key === "D") { e.preventDefault(); handleDownload(); }
      if (e.shiftKey && e.key === "U") { e.preventDefault(); handleShare(); }
      if (e.shiftKey && e.key === "K") { e.preventDefault(); handleClear(); }
      if (e.key === "/")               { e.preventDefault(); setShowShortcuts((v) => !v); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, inputFormat, rawOutput]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleInput = useCallback((val: string) => {
    setInput(val);
    setError(null);
    if (val.trim()) {
      try { convert(val, inputFormat, opts); }
      catch (e) { setError((e as Error).message); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputFormat, sortKeys, minify]);

  const handleSwap = () => {
    if (convertError) {
      setSwapBlocked(true);
      setTimeout(() => setSwapBlocked(false), 2500);
      return;
    }
    const nf: Format = inputFormat === "json" ? "python" : "json";
    setInput(rawOutput || EXAMPLES[nf]);
    setInputFormat(nf);
    setError(null);
    setWrap(false);
  };

  const handleFormat = () => {
    if (!input.trim()) return;
    try {
      const formatted = inputFormat === "json"
        ? formatJson(input, { sortKeys, minify })
        : formatPythonDict(input, { sortKeys, minify });
      setInput(formatted);
      setError(null);
    } catch (e) { setError((e as Error).message); }
  };

  const handleDownload = () => {
    if (!displayOutput) return;
    const ext  = outputFormat === "json" ? "json" : "py";
    downloadFile(displayOutput, `output.${ext}`);
  };

  const handleShare = () => {
    const encoded = encodeShare(input, inputFormat);
    window.location.hash = encoded;
    navigator.clipboard.writeText(window.location.href);
    setSharedToast(true);
    setTimeout(() => setSharedToast(false), 2000);
  };

  const handleCopy = () => {
    if (!displayOutput) return;
    navigator.clipboard.writeText(displayOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleClear = () => { setInput(""); setError(null); };

  const handleLoadExample = () => { setInput(EXAMPLES[inputFormat]); setError(null); };

  const handleLoadHistory = (e: HistoryEntry) => {
    setInput(e.input);
    setInputFormat(e.inputFormat);
    setError(null);
    setShowHistory(false);
  };

  // ── Drag & drop ──
  const handleDragOver = (ev: React.DragEvent) => {
    if (ev.dataTransfer.types.includes("Files")) { ev.preventDefault(); setIsDragOver(true); }
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    setIsDragOver(false);
    const file = ev.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (text) { handleInput(text); }
    };
    reader.readAsText(file);
  };

  // Stable key for useMemo deps — encodes all error positions.
  const errorsKey = syntaxErrors.map(e => `${e.lineStart}:${e.from}:${e.to}`).join("|");

  // ── Extensions ──
  const inputExtensions = useMemo(() => {
    const base = inputFormat === "json" ? [...BASE_EXTENSIONS, json()] : BASE_EXTENSIONS;
    if (syntaxErrors.length === 0) return base;

    // Build decorations: one Decoration.line per unique lineStart, one
    // Decoration.mark per unique (from, to) pair. All sorted by `from`.
    const seenLines = new Set<number>();
    const seenMarks = new Set<string>();
    const allDecos: import("@codemirror/state").Range<Decoration>[] = [];

    for (const err of syntaxErrors) {
      if (!seenLines.has(err.lineStart)) {
        seenLines.add(err.lineStart);
        allDecos.push(Decoration.line({ class: "cm-error-line" }).range(err.lineStart));
      }
      const markKey = `${err.from}:${err.to}`;
      if (err.from >= 0 && err.to > err.from && !seenMarks.has(markKey)) {
        seenMarks.add(markKey);
        allDecos.push(Decoration.mark({ class: "cm-error-highlight" }).range(err.from, err.to));
      }
    }

    // Decoration.set requires ranges sorted by from, line decos before marks at the same pos.
    allDecos.sort((a, b) => a.from !== b.from ? a.from - b.from : (a.value.spec.class === "cm-error-line" ? -1 : 1));

    return [...base, EditorView.decorations.of(Decoration.set(allDecos))];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputFormat, errorsKey]);
  const outputExtensions = useMemo(() => outputFormat === "json" ? [...BASE_EXTENSIONS, json()] : BASE_EXTENSIONS, [outputFormat]);

  const detectedFormat = input.trim() ? detectFormat(input) : inputFormat;

  // ── Button style helpers ──
  const ghostBtn  = "text-[11px] px-2.5 py-1 rounded font-medium cursor-pointer border transition-colors";
  const activeToggle = { background: "#363d5a", color: "#9ba8ff", borderColor: "#4a5280" };
  const inactiveToggle = { background: "#22273a", color: "#6b7280", borderColor: "#363d54" };

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{ background: "#d8dce6", color: "#1e2030" }}
      onClick={() => { setShowHistory(false); setShowShortcuts(false); }}>

      {/* ── Header ── */}
      <header className="shrink-0 flex items-center justify-between px-5 py-2.5 border-b"
        style={{ background: "#e4e7ef", borderColor: "#c4c9d6" }}
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h1 className="text-sm font-bold tracking-tight" style={{ color: "#1a1d2e" }}>JSON ↔ Python Dict</h1>
          <p className="text-[10px] mt-0.5" style={{ color: "#7a7f96" }}>Real-time converter</p>
        </div>

        <div className="flex items-center gap-2 relative">
          {/* Share toast */}
          {sharedToast && (
            <span className="text-[11px] px-2 py-1 rounded" style={{ background: "#1a3a2a", color: "#4ade80" }}>
              Link copied!
            </span>
          )}

          {/* Shortcuts toggle */}
          <div className="relative">
            <button onClick={(e) => { e.stopPropagation(); setShowShortcuts((v) => !v); setShowHistory(false); }}
              className={`${ghostBtn}`}
              style={showShortcuts ? activeToggle : inactiveToggle}>
              ⌘ /
            </button>
            {showShortcuts && (
              <div className="absolute right-0 top-8 z-50 rounded-xl p-4 w-72 text-[11px] space-y-1.5 border shadow-xl"
                style={{ background: "#1e2130", borderColor: "#363d54", color: "#8892b0" }}
                onClick={(e) => e.stopPropagation()}>
                <p className="font-bold text-[10px] uppercase tracking-widest mb-2" style={{ color: "#6b7280" }}>Keyboard Shortcuts</p>
                {[
                  ["Ctrl+Shift+F", "Format / prettify input"],
                  ["Ctrl+Shift+M", "Toggle minify"],
                  ["Ctrl+Shift+D", "Download output"],
                  ["Ctrl+Shift+U", "Copy share link"],
                  ["Ctrl+Shift+K", "Clear input"],
                  ["Ctrl+/",       "Toggle this panel"],
                ].map(([key, desc]) => (
                  <div key={key} className="flex justify-between">
                    <span style={{ color: "#c8cfe0" }}>{desc}</span>
                    <kbd className="font-mono px-1.5 py-0.5 rounded text-[10px]" style={{ background: "#2a2f42", color: "#7c8cf8", border: "1px solid #363d54" }}>{key}</kbd>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* History */}
          <div className="relative">
            <button onClick={(e) => { e.stopPropagation(); setShowHistory((v) => !v); setShowShortcuts(false); }}
              className={`${ghostBtn}`}
              style={showHistory ? activeToggle : inactiveToggle}>
              History {history2.length > 0 && <span className="ml-1 px-1 rounded-full text-[9px]" style={{ background: "#4a5280" }}>{history2.length}</span>}
            </button>
            {showHistory && (
              <div className="absolute right-0 top-8 z-50 rounded-xl w-80 overflow-hidden border shadow-xl"
                style={{ background: "#1e2130", borderColor: "#363d54" }}
                onClick={(e) => e.stopPropagation()}>
                <p className="text-[10px] uppercase tracking-widest px-4 py-2 border-b font-bold" style={{ color: "#6b7280", borderColor: "#363d54" }}>
                  Recent Conversions
                </p>
                {history2.length === 0 ? (
                  <p className="px-4 py-4 text-[11px]" style={{ color: "#4b5563" }}>No history yet — conversions auto-save after 2s.</p>
                ) : history2.map((e) => (
                  <button key={e.id} onClick={() => handleLoadHistory(e)}
                    className="w-full text-left px-4 py-2.5 border-b transition-colors cursor-pointer"
                    style={{ borderColor: "#252a3a", color: "#c8cfe0" }}
                    onMouseEnter={(ev) => (ev.currentTarget.style.background = "#262b3e")}
                    onMouseLeave={(ev) => (ev.currentTarget.style.background = "")}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: "#2a2f42", color: "#7c8cf8" }}>
                        {formatLabel(e.inputFormat)}
                      </span>
                      <span className="text-[10px]" style={{ color: "#4b5563" }}>
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-[11px] truncate font-mono mt-0.5" style={{ color: "#8892b0" }}>
                      {e.input.slice(0, 60).replace(/\n/g, " ")}…
                    </p>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Share */}
          <button onClick={(e) => { e.stopPropagation(); handleShare(); }}
            className={`${ghostBtn}`} style={inactiveToggle}>
            Share
          </button>

          {/* Example */}
          <button onClick={handleLoadExample}
            className={`${ghostBtn}`} style={inactiveToggle}>
            Example
          </button>
        </div>
      </header>

      {/* ── Columns ── */}
      <div className="flex flex-1 gap-4 p-4 overflow-hidden">

        {/* ── Input pane ── */}
        <div className="flex flex-col flex-1 min-w-0 rounded-xl overflow-hidden relative"
          style={{
            border: hasError ? "1.5px solid #f87171" : "1.5px solid #363d54",
            boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}>

          {/* drag overlay */}
          {isDragOver && (
            <div className="absolute inset-0 z-20 flex items-center justify-center rounded-xl"
              style={{ background: "rgba(30,33,48,0.92)", border: "2px dashed #7c8cf8" }}>
              <p className="text-base font-semibold" style={{ color: "#7c8cf8" }}>Drop .json or .py file</p>
            </div>
          )}

          {/* toolbar row 1 */}
          <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b"
            style={{ background: "#2a2f42", borderColor: "#363d54" }}>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#7c8cf8" }}>Input</span>
              <span className="text-[11px] px-2 py-0.5 rounded font-mono" style={{ background: "#363d5a", color: "#9ba8ff" }}>
                {formatLabel(inputFormat)}
              </span>
              {/* valid dot */}
              <span title={isValid ? "Valid" : hasError ? "Error" : "Empty"}
                className="w-2 h-2 rounded-full"
                style={{ background: input.trim() ? (isValid ? "#4ade80" : "#f87171") : "#374151" }} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono" style={{ color: "#4b5563" }}>{lineCharCount(input)}</span>
              <button onClick={handleFormat} className={`${ghostBtn}`} style={inactiveToggle} title="Ctrl+Shift+F">Format</button>
              <button onClick={() => setMinify((v) => !v)} className={`${ghostBtn}`}
                style={minify ? activeToggle : inactiveToggle} title="Ctrl+Shift+M">
                {minify ? "Minified" : "Minify"}
              </button>
              <button onClick={handleClear}
                className={`${ghostBtn}`}
                style={{ background: "#3d1f1f", color: "#f87171", borderColor: "#5c2c2c" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "#4d2525")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "#3d1f1f")}>
                Clear
              </button>
            </div>
          </div>

          {/* auto-detect banner */}
          {input.trim() && detectedFormat !== inputFormat && (
            <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-[11px] border-b"
              style={{ background: "#2d2200", borderColor: "#78350f", color: "#fbbf24" }}>
              Looks like <span className="font-mono font-semibold">{formatLabel(detectedFormat)}</span> —{" "}
              <button className="underline cursor-pointer" onClick={() => setInputFormat(detectedFormat)}>
                switch mode
              </button>
            </div>
          )}

          {/* CodeMirror */}
          <div className="flex-1 min-h-0 relative" style={{ background: "#1e2130" }}>
            <div className="absolute inset-0">
              <CodeMirror value={input} onChange={handleInput}
                theme={editorTheme} extensions={inputExtensions}
                height="100%" style={{ height: "100%", fontSize: "13px" }}
                placeholder={`Paste ${formatLabel(inputFormat)} here…`}
                basicSetup={false} />
            </div>
          </div>

          {/* error bar */}
          {hasError && (
            <div className="shrink-0 px-4 py-2 text-[11px] font-mono truncate border-t"
              style={{ background: "#2a1010", borderColor: "#5c2c2c", color: "#f87171" }}>
              {syntaxErrors.length > 1
                ? `${syntaxErrors.length} errors · ${convertError}`
                : (error ?? convertError)}
            </div>
          )}
        </div>

        {/* ── Swap ── */}
        <div className="flex flex-col items-center justify-center shrink-0 gap-1.5 relative">
          {/* blocked toast */}
          {swapBlocked && (
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 whitespace-nowrap text-[10px] px-2.5 py-1.5 rounded-lg border z-50"
              style={{ background: "#2a1010", borderColor: "#5c2c2c", color: "#f87171" }}>
              Fix errors first
            </div>
          )}
          <button onClick={handleSwap} title="Swap input ↔ output"
            className="flex flex-col items-center gap-1 px-2.5 py-3 rounded-xl cursor-pointer transition-all border"
            style={convertError
              ? { background: "#2a1a1a", color: "#7c5050", borderColor: "#5c2c2c" }
              : { background: "#2a2f42", color: "#7c8cf8", borderColor: "#363d54" }}
            onMouseEnter={(e) => { if (!convertError) (e.currentTarget as HTMLElement).style.background = "#323858"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = convertError ? "#2a1a1a" : "#2a2f42"; }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M7 16V4m0 0L3 8m4-4 4 4" />
            </svg>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M17 8v12m0 0 4-4m-4 4-4-4" />
            </svg>
          </button>
          <span className="text-[9px] font-semibold uppercase tracking-widest" style={{ color: "#4b5563" }}>swap</span>
        </div>

        {/* ── Output pane ── */}
        <div className="flex flex-col flex-1 min-w-0 rounded-xl overflow-hidden"
          style={{ border: "1.5px solid #363d54", boxShadow: "0 2px 12px rgba(0,0,0,0.18)" }}>

          {/* toolbar */}
          <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b"
            style={{ background: "#2a2f42", borderColor: "#363d54" }}>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "#4ade80" }}>Output</span>
              <span className="text-[11px] px-2 py-0.5 rounded font-mono" style={{ background: "#1a3a2a", color: "#4ade80" }}>
                {formatLabel(outputFormat)}
              </span>
              <button onClick={() => setSortKeys((v) => !v)} className={`${ghostBtn}`}
                style={sortKeys ? activeToggle : inactiveToggle}>
                Sort keys
              </button>
              <button onClick={() => setWrap((v) => !v)} className={`${ghostBtn}`}
                style={wrap ? activeToggle : inactiveToggle}
                title={outputFormat === "python" ? "Wrap in json.dumps()" : "Wrap in json.loads()"}>
                {outputFormat === "python" ? "dumps()" : "loads()"}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono" style={{ color: "#4b5563" }}>{lineCharCount(displayOutput)}</span>
              <button onClick={handleDownload} disabled={!displayOutput}
                className={`${ghostBtn} disabled:opacity-30 disabled:cursor-not-allowed`}
                style={inactiveToggle} title="Ctrl+Shift+D">
                Download
              </button>
              <button onClick={handleCopy} disabled={!displayOutput}
                className={`${ghostBtn} disabled:opacity-30 disabled:cursor-not-allowed`}
                style={copied
                  ? { background: "#1a3a2a", color: "#4ade80", borderColor: "#2a6040" }
                  : { background: "#1a2e20", color: "#34c468", borderColor: "#1f4030" }}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          {/* CodeMirror read-only */}
          <div className="flex-1 min-h-0 relative" style={{ background: "#1e2130" }}>
            <div className="absolute inset-0">
              <CodeMirror value={displayOutput}
                theme={editorTheme} extensions={outputExtensions}
                height="100%" style={{ height: "100%", fontSize: "13px" }}
                readOnly={true} basicSetup={false}
                placeholder="Output will appear here…" />
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <footer className="shrink-0 flex flex-wrap gap-x-6 gap-y-1 px-5 py-2 text-[10px] border-t"
        style={{ background: "#e4e7ef", borderColor: "#c4c9d6", color: "#7a7f96" }}>
        <span>true/false ↔ True/False</span>
        <span>null ↔ None</span>
        <span>arrays ↔ lists</span>
        <span>objects ↔ dicts</span>
        <span>tuples () → arrays</span>
        <span className="ml-auto" style={{ color: "#b0b4c4" }}>Drag & drop .json / .py files onto input</span>
      </footer>
    </div>
  );
}
