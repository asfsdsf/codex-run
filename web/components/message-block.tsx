import { useState, memo } from "react";
import type { ConversationMessage, ContentBlock } from "@codex-run/api";
import hljs from "highlight.js/lib/core";
import bashLanguage from "highlight.js/lib/languages/bash";
import cppLanguage from "highlight.js/lib/languages/cpp";
import cssLanguage from "highlight.js/lib/languages/css";
import goLanguage from "highlight.js/lib/languages/go";
import javaLanguage from "highlight.js/lib/languages/java";
import javascriptLanguage from "highlight.js/lib/languages/javascript";
import jsonLanguage from "highlight.js/lib/languages/json";
import kotlinLanguage from "highlight.js/lib/languages/kotlin";
import markdownLanguage from "highlight.js/lib/languages/markdown";
import phpLanguage from "highlight.js/lib/languages/php";
import plaintextLanguage from "highlight.js/lib/languages/plaintext";
import pythonLanguage from "highlight.js/lib/languages/python";
import rubyLanguage from "highlight.js/lib/languages/ruby";
import rustLanguage from "highlight.js/lib/languages/rust";
import scssLanguage from "highlight.js/lib/languages/scss";
import swiftLanguage from "highlight.js/lib/languages/swift";
import typescriptLanguage from "highlight.js/lib/languages/typescript";
import xmlLanguage from "highlight.js/lib/languages/xml";
import yamlLanguage from "highlight.js/lib/languages/yaml";
import {
  Lightbulb,
  Wrench,
  Check,
  X,
  Terminal,
  Search,
  Pencil,
  FolderOpen,
  Globe,
  MessageSquare,
  ListTodo,
  FilePlus2,
  FileCode,
  GitBranch,
  Database,
  HardDrive,
  Bot,
  ImageIcon,
} from "lucide-react";
import { sanitizeText } from "../utils";
import { getFencedCodeBlock, MarkdownRenderer } from "./markdown-renderer";
import { FunctionToolResultRenderer } from "./tool-renderers";

interface MessageBlockProps {
  message: ConversationMessage;
}

function buildToolMap(content: ContentBlock[]): Map<string, string> {
  const toolMap = new Map<string, string>();
  for (const block of content) {
    if (block.type === "tool_use" && block.id && block.name) {
      toolMap.set(block.id, block.name);
    }
  }
  return toolMap;
}

function formatReasoningText(text: string): string {
  const sanitized = sanitizeText(text).trim();
  return sanitized.replace(/^\*\*(.*?)\*\*$/s, "$1").trim();
}

function getReasoningPreview(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function stringifyJson(value: unknown): string {
  try {
    return sanitizeText(JSON.stringify(value, null, 2) ?? "null");
  } catch {
    return sanitizeText(String(value));
  }
}

function JsonRenderer(props: { value: unknown }) {
  const content = stringifyJson(props.value);

  if (!content) {
    return null;
  }

  return <MarkdownRenderer content={getFencedCodeBlock(content, "json")} />;
}

const MessageBlock = memo(function MessageBlock(props: MessageBlockProps) {
  const { message } = props;

  const isUser = message.type === "user";
  const content = message.message?.content;

  const getTextBlocks = (): ContentBlock[] => {
    if (!content || typeof content === "string") {
      return [];
    }
    return content.filter((b) => b.type === "text");
  };

  const getAuxiliaryBlocks = (): ContentBlock[] => {
    if (!content || typeof content === "string") {
      return [];
    }
    return content.filter(
      (b) =>
        b.type === "tool_use" ||
        b.type === "tool_result" ||
        b.type === "thinking" ||
        b.type === "reasoning" ||
        b.type === "agent_reasoning",
    );
  };

  const getVisibleTextBlocks = (): ContentBlock[] => {
    return getTextBlocks().filter(
      (b) => b.text && sanitizeText(b.text).length > 0,
    );
  };

  const hasVisibleText = (): boolean => {
    if (typeof content === "string") {
      return sanitizeText(content).length > 0;
    }
    return getVisibleTextBlocks().length > 0;
  };

  const auxiliaryBlocks = getAuxiliaryBlocks();
  const visibleTextBlocks = getVisibleTextBlocks();
  const hasText = hasVisibleText();
  const hasAuxiliary = auxiliaryBlocks.length > 0;

  const toolMap = Array.isArray(content)
    ? buildToolMap(content)
    : new Map<string, string>();

  if (!hasText && hasAuxiliary) {
    return (
      <div className="flex flex-col gap-1 py-0.5">
        {auxiliaryBlocks.map((block, index) => (
          <ContentBlockRenderer key={index} block={block} toolMap={toolMap} />
        ))}
      </div>
    );
  }

  if (!hasText && !hasAuxiliary) {
    return null;
  }

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} min-w-0`}>
      <div className="max-w-[85%] min-w-0">
        <div
          className={`px-3.5 py-2.5 rounded-2xl overflow-hidden ${
            isUser
              ? "bg-indigo-600/80 text-indigo-50 rounded-br-md"
              : "bg-cyan-700/50 text-zinc-100 rounded-bl-md"
          }`}
        >
          {typeof content === "string" ? (
            <MarkdownRenderer content={sanitizeText(content)} />
          ) : (
            <div className="flex flex-col gap-1">
              {visibleTextBlocks.map((block, index) => (
                <ContentBlockRenderer
                  key={index}
                  block={block}
                  toolMap={toolMap}
                />
              ))}
            </div>
          )}
        </div>

        {hasAuxiliary && (
          <div className="flex flex-col gap-1 mt-1.5">
            {auxiliaryBlocks.map((block, index) => (
              <ContentBlockRenderer
                key={index}
                block={block}
                toolMap={toolMap}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

interface ContentBlockRendererProps {
  block: ContentBlock;
  toolMap?: Map<string, string>;
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  todowrite: ListTodo,
  read: FileCode,
  bash: Terminal,
  grep: Search,
  edit: Pencil,
  write: FilePlus2,
  glob: FolderOpen,
  task: Bot,
  exec_command: Terminal,
  write_stdin: Terminal,
  apply_patch: Pencil,
  update_plan: ListTodo,
  js_repl: FileCode,
  js_repl_reset: FileCode,
  spawn_agent: Bot,
  wait: Bot,
  close_agent: Bot,
  request_user_input: MessageSquare,
  view_image: ImageIcon,
};

const TOOL_ICON_PATTERNS: Array<{ patterns: string[]; icon: typeof Wrench }> = [
  { patterns: ["web", "fetch", "url"], icon: Globe },
  { patterns: ["ask", "question"], icon: MessageSquare },
  { patterns: ["git", "commit"], icon: GitBranch },
  { patterns: ["sql", "database", "query"], icon: Database },
  { patterns: ["file", "disk"], icon: HardDrive },
];

function getToolIcon(toolName: string) {
  const name = toolName.toLowerCase();

  if (TOOL_ICONS[name]) {
    return TOOL_ICONS[name];
  }

  for (const { patterns, icon } of TOOL_ICON_PATTERNS) {
    if (patterns.some((p) => name.includes(p))) {
      return icon;
    }
  }

  return Wrench;
}

function getFilePathPreview(filePath: string): string {
  const parts = filePath.split("/");
  return parts.slice(-2).join("/");
}

type PreviewHandler = (input: Record<string, unknown>) => string | null;

function getTruncatedPreview(value: string, maxLength: number = 50): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function getApplyPatchPreview(raw: string): string | null {
  const match = raw.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/);
  if (!match) {
    return null;
  }

  return getFilePathPreview(match[1].trim());
}

const PATCH_FILE_HEADER_REGEX = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_TO_HEADER_REGEX = /^\*\*\* Move to: (.+)$/;

type PatchLanguageInfo = {
  label: string;
  highlight: string | null;
};

const PATCH_EXTENSION_LANGUAGE_MAP: Record<string, PatchLanguageInfo> = {
  ts: { label: "TypeScript", highlight: "typescript" },
  tsx: { label: "TypeScript React", highlight: "typescript" },
  js: { label: "JavaScript", highlight: "javascript" },
  jsx: { label: "JavaScript React", highlight: "javascript" },
  mjs: { label: "JavaScript", highlight: "javascript" },
  cjs: { label: "JavaScript", highlight: "javascript" },
  json: { label: "JSON", highlight: "json" },
  css: { label: "CSS", highlight: "css" },
  scss: { label: "SCSS", highlight: "scss" },
  html: { label: "HTML", highlight: "html" },
  md: { label: "Markdown", highlight: "markdown" },
  yml: { label: "YAML", highlight: "yaml" },
  yaml: { label: "YAML", highlight: "yaml" },
  sh: { label: "Shell", highlight: "bash" },
  py: { label: "Python", highlight: "python" },
  go: { label: "Go", highlight: "go" },
  rs: { label: "Rust", highlight: "rust" },
  java: { label: "Java", highlight: "java" },
  kt: { label: "Kotlin", highlight: "kotlin" },
  swift: { label: "Swift", highlight: "swift" },
  rb: { label: "Ruby", highlight: "ruby" },
  php: { label: "PHP", highlight: "php" },
  c: { label: "C", highlight: "cpp" },
  cc: { label: "C++", highlight: "cpp" },
  cpp: { label: "C++", highlight: "cpp" },
  h: { label: "C/C++ Header", highlight: "cpp" },
  hpp: { label: "C++ Header", highlight: "cpp" },
  vue: { label: "Vue", highlight: "html" },
  svelte: { label: "Svelte", highlight: "html" },
};

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

function registerPatchLanguage(
  languageName: string,
  languageDefinition: Parameters<typeof hljs.registerLanguage>[1],
) {
  if (!hljs.getLanguage(languageName)) {
    hljs.registerLanguage(languageName, languageDefinition);
  }
}

registerPatchLanguage("bash", bashLanguage);
registerPatchLanguage("cpp", cppLanguage);
registerPatchLanguage("css", cssLanguage);
registerPatchLanguage("go", goLanguage);
registerPatchLanguage("java", javaLanguage);
registerPatchLanguage("javascript", javascriptLanguage);
registerPatchLanguage("json", jsonLanguage);
registerPatchLanguage("kotlin", kotlinLanguage);
registerPatchLanguage("markdown", markdownLanguage);
registerPatchLanguage("php", phpLanguage);
registerPatchLanguage("plaintext", plaintextLanguage);
registerPatchLanguage("python", pythonLanguage);
registerPatchLanguage("ruby", rubyLanguage);
registerPatchLanguage("rust", rustLanguage);
registerPatchLanguage("scss", scssLanguage);
registerPatchLanguage("swift", swiftLanguage);
registerPatchLanguage("typescript", typescriptLanguage);
registerPatchLanguage("xml", xmlLanguage);
registerPatchLanguage("yaml", yamlLanguage);
registerPatchLanguage("html", xmlLanguage);

function detectLanguageFromPath(filePath: string): PatchLanguageInfo {
  const ext = filePath.toLowerCase().split(".").pop() || "";
  const knownLanguage = PATCH_EXTENSION_LANGUAGE_MAP[ext];
  if (knownLanguage) {
    return knownLanguage;
  }
  if (ext) {
    return { label: ext.toUpperCase(), highlight: null };
  }
  return { label: "Text", highlight: null };
}

function getPatchFileTypes(raw: string): string[] {
  const lines = raw.split("\n");
  const types = new Set<string>();

  for (const line of lines) {
    const match = line.match(PATCH_FILE_HEADER_REGEX);
    if (!match) {
      continue;
    }
    types.add(detectLanguageFromPath(match[1].trim()).label);
  }

  return [...types];
}

function getPatchLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "bg-emerald-500/14";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "bg-rose-500/14";
  }
  if (line.startsWith("@@")) {
    return "bg-amber-500/12 text-amber-200";
  }
  if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
    return "bg-sky-500/12 text-sky-200";
  }
  if (line.match(PATCH_FILE_HEADER_REGEX)) {
    return "bg-indigo-500/14 text-indigo-200";
  }
  if (line.startsWith("***")) {
    return "bg-zinc-700/40 text-zinc-200";
  }
  return "text-zinc-300";
}

function getPatchLineCode(
  line: string,
): { prefix: string; code: string } | null {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return null;
  }

  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
    return { prefix: line[0], code: line.slice(1) };
  }

  return null;
}

function getPatchPrefixClass(prefix: string): string {
  if (prefix === "+") {
    return "text-emerald-300";
  }
  if (prefix === "-") {
    return "text-rose-300";
  }
  return "text-zinc-500";
}

function highlightPatchCode(code: string, language: string | null): string {
  if (!code.length) {
    return "&nbsp;";
  }

  if (!language || !hljs.getLanguage(language)) {
    return escapeHtml(code);
  }

  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function ApplyPatchInputRenderer(props: { raw: string }) {
  const { raw } = props;
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const fileTypes = getPatchFileTypes(raw);
  const fileTypeLabel =
    fileTypes.length === 0
      ? "Patch"
      : fileTypes.length === 1
        ? fileTypes[0]
        : `${fileTypes.length} file types`;

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700/60 bg-zinc-950/80">
      <div className="flex items-center justify-between border-b border-zinc-700/50 bg-zinc-900/70 px-3 py-1.5">
        <span className="text-[10px] font-mono text-zinc-400">apply_patch</span>
        <span className="text-[10px] font-mono text-zinc-500">
          {fileTypeLabel}
        </span>
      </div>
      <pre className="m-0 max-h-[420px] overflow-auto rounded-none border-0 bg-transparent p-0 text-xs leading-relaxed">
        {(() => {
          let activeLanguage: string | null = null;

          return lines.map((line, index) => {
            const fileHeaderMatch = line.match(PATCH_FILE_HEADER_REGEX);
            if (fileHeaderMatch) {
              activeLanguage = detectLanguageFromPath(
                fileHeaderMatch[1].trim(),
              ).highlight;
            }

            const moveToMatch = line.match(PATCH_MOVE_TO_HEADER_REGEX);
            if (moveToMatch) {
              activeLanguage = detectLanguageFromPath(
                moveToMatch[1].trim(),
              ).highlight;
            }

            const codeLine = getPatchLineCode(line);
            const lineClass = `px-3 py-0.5 font-mono whitespace-pre ${getPatchLineClass(
              line,
            )}`;

            if (!codeLine) {
              return (
                <div key={`${index}:${line}`} className={lineClass}>
                  {line || " "}
                </div>
              );
            }

            return (
              <div key={`${index}:${line}`} className={lineClass}>
                <span
                  className={`inline-block w-[1ch] select-none ${getPatchPrefixClass(
                    codeLine.prefix,
                  )}`}
                >
                  {codeLine.prefix}
                </span>
                <span
                  className="patch-syntax"
                  dangerouslySetInnerHTML={{
                    __html: highlightPatchCode(codeLine.code, activeLanguage),
                  }}
                />
              </div>
            );
          });
        })()}
      </pre>
    </div>
  );
}

function renderToolInput(
  block: ContentBlock,
  input: Record<string, unknown>,
): JSX.Element {
  const toolName = (block.name || "").toLowerCase();
  const rawInput = typeof input.raw === "string" ? input.raw : null;

  if (toolName === "apply_patch" && rawInput) {
    return <ApplyPatchInputRenderer raw={rawInput} />;
  }

  return (
    <JsonRenderer
      value={{
        type: block.type,
        id: block.id,
        name: block.name,
        input,
      }}
    />
  );
}

const TOOL_PREVIEW_HANDLERS: Record<string, PreviewHandler> = {
  read: (input) =>
    input.file_path ? getFilePathPreview(String(input.file_path)) : null,
  edit: (input) =>
    input.file_path ? getFilePathPreview(String(input.file_path)) : null,
  write: (input) =>
    input.file_path ? getFilePathPreview(String(input.file_path)) : null,
  bash: (input) => {
    if (!input.command) {
      return null;
    }
    const cmd = String(input.command);
    return cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd;
  },
  grep: (input) => (input.pattern ? `"${String(input.pattern)}"` : null),
  glob: (input) => (input.pattern ? String(input.pattern) : null),
  task: (input) => (input.description ? String(input.description) : null),
  exec_command: (input) =>
    input.cmd ? getTruncatedPreview(String(input.cmd)) : null,
  write_stdin: (input) =>
    input.session_id ? `session ${String(input.session_id)}` : null,
  apply_patch: (input) =>
    typeof input.raw === "string" ? getApplyPatchPreview(input.raw) : null,
  update_plan: (input) =>
    Array.isArray(input.plan) ? `${input.plan.length} steps` : null,
  js_repl: (input) =>
    typeof input.raw === "string"
      ? getTruncatedPreview(input.raw.split("\n")[0]?.trim() || "js")
      : null,
  spawn_agent: (input) => {
    if (input.agent_type) {
      return String(input.agent_type);
    }
    if (input.message) {
      return getTruncatedPreview(String(input.message));
    }
    return null;
  },
  request_user_input: (input) =>
    Array.isArray(input.questions)
      ? `${input.questions.length} question(s)`
      : null,
  wait: (input) =>
    Array.isArray(input.ids) ? `${input.ids.length} agent(s)` : null,
  close_agent: (input) =>
    input.id ? getTruncatedPreview(String(input.id), 24) : null,
  view_image: (input) =>
    input.path ? getFilePathPreview(String(input.path)) : null,
};

function getToolPreview(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!input) {
    return null;
  }

  const name = toolName.toLowerCase();
  const handler = TOOL_PREVIEW_HANDLERS[name];

  if (handler) {
    return handler(input);
  }

  if (name.includes("web") && input.url) {
    try {
      const url = new URL(String(input.url));
      return url.hostname;
    } catch {
      return String(input.url).slice(0, 30);
    }
  }

  return null;
}

interface ToolResultRendererProps {
  toolName: string;
  content: string;
  isError?: boolean;
}

function tryParseJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const startsLikeJson =
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith('"') ||
    trimmed === "null" ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d/.test(trimmed);

  if (!startsLikeJson) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseExecPreview(content: string): string | null {
  const outputMarker = "\nOutput:\n";
  const outputIndex = content.indexOf(outputMarker);
  const body =
    outputIndex >= 0
      ? content.slice(outputIndex + outputMarker.length)
      : content;
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine ? getTruncatedPreview(firstLine, 60) : null;
}

function getToolResultPreview(
  toolName: string,
  content: string,
): string | null {
  const name = toolName.toLowerCase();
  const parsed = tryParseJson(content);

  if (name === "view_image" && Array.isArray(parsed)) {
    const imageCount = parsed.filter(
      (item) => isRecord(item) && item.type === "input_image",
    ).length;
    return imageCount > 0
      ? `${imageCount} image${imageCount > 1 ? "s" : ""}`
      : null;
  }

  if (name === "spawn_agent" && isRecord(parsed)) {
    if (typeof parsed.nickname === "string") {
      return parsed.nickname;
    }
    if (typeof parsed.agent_id === "string") {
      return getTruncatedPreview(parsed.agent_id, 24);
    }
  }

  if (name === "wait" && isRecord(parsed)) {
    if (typeof parsed.timed_out === "boolean" && parsed.timed_out) {
      return "timed out";
    }
    if (isRecord(parsed.status)) {
      return `${Object.keys(parsed.status).length} status result(s)`;
    }
  }

  if (
    name === "close_agent" &&
    isRecord(parsed) &&
    typeof parsed.status === "string"
  ) {
    return parsed.status;
  }

  if (
    name === "request_user_input" &&
    isRecord(parsed) &&
    isRecord(parsed.answers)
  ) {
    return `${Object.keys(parsed.answers).length} answer set(s)`;
  }

  if (
    name === "apply_patch" &&
    isRecord(parsed) &&
    typeof parsed.output === "string"
  ) {
    return getTruncatedPreview(parsed.output.split("\n")[0]?.trim() || "", 60);
  }

  if (name === "exec_command" || name === "write_stdin") {
    return parseExecPreview(content);
  }

  return null;
}

function ToolResultRenderer(props: ToolResultRendererProps) {
  return <FunctionToolResultRenderer {...props} />;
}

function ContentBlockRenderer(props: ContentBlockRendererProps) {
  const { block, toolMap } = props;
  const [expanded, setExpanded] = useState(false);

  if (block.type === "text" && block.text) {
    const sanitized = sanitizeText(block.text);
    if (!sanitized) {
      return null;
    }
    return <MarkdownRenderer content={sanitized} />;
  }

  if (block.type === "thinking" && block.thinking) {
    return (
      <div className={expanded ? "w-full" : ""}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/15 text-[11px] text-amber-400/90 transition-colors border border-amber-500/20"
        >
          <Lightbulb size={12} className="opacity-70" />
          <span className="font-medium">thinking</span>
          <span className="text-[10px] opacity-50 ml-0.5">
            {expanded ? "▼" : "▶"}
          </span>
        </button>
        {expanded && (
          <pre className="text-xs text-zinc-400 bg-zinc-900/80 border border-zinc-800 rounded-lg p-3 mt-2 whitespace-pre-wrap max-h-80 overflow-y-auto">
            {block.thinking}
          </pre>
        )}
      </div>
    );
  }

  if (block.type === "agent_reasoning" && block.text) {
    const reasoningText = formatReasoningText(block.text);
    if (!reasoningText) {
      return null;
    }

    return (
      <div className="rounded-xl border border-fuchsia-500/20 bg-fuchsia-500/8 px-3 py-2.5">
        <div className="inline-flex items-center gap-1.5 rounded-lg border border-fuchsia-400/20 bg-fuchsia-400/10 px-2 py-1 text-[11px] text-fuchsia-200/90">
          <Bot size={12} className="opacity-75" />
          <span className="font-medium">agent step</span>
        </div>
        <div className="mt-2">
          <MarkdownRenderer content={reasoningText} />
        </div>
      </div>
    );
  }

  if (block.type === "reasoning" && block.text) {
    const reasoningText = formatReasoningText(block.text);
    if (!reasoningText) {
      return null;
    }

    const shouldCollapse = reasoningText.length > 120;

    if (!shouldCollapse) {
      return (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/8 px-3 py-2.5">
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200/90">
            <Lightbulb size={12} className="opacity-75" />
            <span className="font-medium">reasoning</span>
          </div>
          <div className="mt-2">
            <MarkdownRenderer content={reasoningText} />
          </div>
        </div>
      );
    }

    return (
      <div className={expanded ? "w-full" : ""}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-300 transition-colors hover:bg-amber-500/15"
        >
          <Lightbulb size={12} className="opacity-70" />
          <span className="font-medium">reasoning</span>
          {!expanded && (
            <span className="max-w-[260px] truncate text-amber-100/65">
              {getReasoningPreview(reasoningText, 80)}
            </span>
          )}
          <span className="ml-0.5 text-[10px] opacity-40">
            {expanded ? "▼" : "▶"}
          </span>
        </button>
        {expanded && (
          <div className="mt-2 rounded-xl border border-amber-500/20 bg-amber-500/8 px-3 py-2.5">
            <MarkdownRenderer content={reasoningText} />
          </div>
        )}
      </div>
    );
  }

  if (block.type === "tool_use") {
    const input =
      block.input && typeof block.input === "object"
        ? (block.input as Record<string, unknown>)
        : undefined;
    const hasInput = input && Object.keys(input).length > 0;
    const Icon = getToolIcon(block.name || "");
    const preview = getToolPreview(block.name || "", input);
    const toolName = block.name?.toLowerCase() || "";

    const shouldAutoExpand =
      toolName === "todowrite" ||
      toolName === "askuserquestion" ||
      toolName === "task";
    const isExpanded = expanded || shouldAutoExpand;

    return (
      <div className={isExpanded ? "w-full" : ""}>
        <button
          onClick={() =>
            hasInput && !shouldAutoExpand && setExpanded(!expanded)
          }
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-500/10 hover:bg-slate-500/15 text-[11px] text-slate-300 transition-colors border border-slate-500/20"
        >
          <Icon size={12} className="opacity-60" />
          <span className="font-medium text-slate-200">{block.name}</span>
          {preview && (
            <span className="text-slate-500 font-normal truncate max-w-[200px]">
              {preview}
            </span>
          )}
          {hasInput && !shouldAutoExpand && (
            <span className="text-[10px] opacity-40 ml-0.5">
              {expanded ? "▼" : "▶"}
            </span>
          )}
        </button>
        {isExpanded && hasInput && (
          <div className="mt-2">{renderToolInput(block, input)}</div>
        )}
      </div>
    );
  }

  if (block.type === "tool_result") {
    const isError = block.is_error;
    const rawContent =
      typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content, null, 2);
    const resultContent = sanitizeText(rawContent);
    const hasContent = resultContent.length > 0;
    const previewLength = 60;
    const toolName =
      block.name ||
      (block.tool_use_id && toolMap
        ? toolMap.get(block.tool_use_id) || ""
        : "");

    const contentPreview =
      hasContent && !expanded
        ? getToolResultPreview(toolName, resultContent) ||
          resultContent.slice(0, previewLength) +
            (resultContent.length > previewLength ? "..." : "")
        : null;

    return (
      <div className={expanded ? "w-full" : ""}>
        <button
          onClick={() => hasContent && setExpanded(!expanded)}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] transition-colors border ${
            isError
              ? "bg-rose-500/10 hover:bg-rose-500/15 text-rose-400/90 border-rose-500/20"
              : "bg-teal-500/10 hover:bg-teal-500/15 text-teal-400/90 border-teal-500/20"
          }`}
        >
          {isError ? (
            <X size={12} className="opacity-70" />
          ) : (
            <Check size={12} className="opacity-70" />
          )}
          <span className="font-medium">{isError ? "error" : "result"}</span>
          {contentPreview && !expanded && (
            <span
              className={`font-normal truncate max-w-[200px] ${isError ? "text-rose-500/70" : "text-teal-500/70"}`}
            >
              {contentPreview}
            </span>
          )}
          {hasContent && (
            <span className="text-[10px] opacity-40 ml-0.5">
              {expanded ? "▼" : "▶"}
            </span>
          )}
        </button>
        {expanded && hasContent && (
          <ToolResultRenderer
            toolName={toolName}
            content={resultContent}
            isError={isError}
          />
        )}
      </div>
    );
  }

  return null;
}

export default MessageBlock;
