"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import {
  EditorView, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, keymap, drawSelection, dropCursor,
} from "@codemirror/view";
import {
  history, historyKeymap, defaultKeymap, indentWithTab,
} from "@codemirror/commands";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import {
  bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";
import {
  jsonToPythonDict, pythonDictToJson, formatJson, formatPythonDict,
  detectFormat, type Format, type ConvertOptions,
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

const BASE_EXTENSIONS = [
  lineNumbers(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  drawSelection(),
  dropCursor(),
  bracketMatching(),
  closeBrackets(),
  indentOnInput(),
  history(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  indentationMarkers(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
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
  const historyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved    = useRef<string>("");

  const outputFormat: Format = inputFormat === "json" ? "python" : "json";
  const opts: ConvertOptions = { sortKeys, minify };

  let rawOutput = "";
  let convertError: string | null = null;
  if (input.trim()) {
    try { rawOutput = convert(input, inputFormat, opts); }
    catch (e) { convertError = (e as Error).message; }
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

  // ── Extensions ──
  const inputExtensions  = useMemo(() => inputFormat  === "json" ? [...BASE_EXTENSIONS, json()] : BASE_EXTENSIONS, [inputFormat]);
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
          <div className="flex-1 min-h-0 overflow-hidden" style={{ background: "#1e2130" }}>
            <CodeMirror value={input} onChange={handleInput}
              theme={editorTheme} extensions={inputExtensions}
              height="100%" style={{ height: "100%", fontSize: "13px" }}
              placeholder={`Paste ${formatLabel(inputFormat)} here…`}
              basicSetup={false} />
          </div>

          {/* error bar */}
          {hasError && (
            <div className="shrink-0 px-4 py-2 text-[11px] font-mono truncate border-t"
              style={{ background: "#2a1010", borderColor: "#5c2c2c", color: "#f87171" }}>
              {error ?? convertError}
            </div>
          )}
        </div>

        {/* ── Swap ── */}
        <div className="flex flex-col items-center justify-center shrink-0 gap-1.5">
          <button onClick={handleSwap} title="Swap input ↔ output"
            className="flex flex-col items-center gap-1 px-2.5 py-3 rounded-xl cursor-pointer transition-all border"
            style={{ background: "#2a2f42", color: "#7c8cf8", borderColor: "#363d54" }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "#323858"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "#2a2f42"; }}>
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
          <div className="flex-1 min-h-0 overflow-hidden" style={{ background: "#1e2130" }}>
            <CodeMirror value={displayOutput}
              theme={editorTheme} extensions={outputExtensions}
              height="100%" style={{ height: "100%", fontSize: "13px" }}
              editable={false} basicSetup={false}
              placeholder="Output will appear here…" />
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
