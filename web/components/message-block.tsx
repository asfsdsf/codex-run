import { useState, memo } from "react";
import type {
  ConversationMessage,
  ContentBlock,
  CodexUserInputRequest,
} from "@codex-run/api";
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
import {
  AskQuestionRenderer,
  BashRenderer,
  CopyButton,
  EditRenderer,
  FunctionToolResultRenderer,
  GlobRenderer,
  GrepRenderer,
  ReadRenderer,
  TaskRenderer,
  TodoRenderer,
  WriteRenderer,
} from "./tool-renderers";

interface MessageBlockProps {
  message: ConversationMessage;
  onPlanAction?: (action: "implement" | "stay") => void;
  pendingUserInputRequests?: CodexUserInputRequest[];
  selectedUserInputAnswers?: Record<string, Record<string, string>>;
  submittingUserInputRequestIds?: string[];
  onSelectUserInputOption?: (
    request: CodexUserInputRequest,
    questionId: string,
    optionLabel: string,
  ) => void;
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

function buildToolInputMap(
  content: ContentBlock[],
): Map<string, Record<string, unknown>> {
  const toolInputMap = new Map<string, Record<string, unknown>>();
  for (const block of content) {
    if (
      block.type === "tool_use" &&
      block.id &&
      block.input &&
      typeof block.input === "object" &&
      !Array.isArray(block.input)
    ) {
      toolInputMap.set(block.id, block.input as Record<string, unknown>);
    }
  }
  return toolInputMap;
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

type JsonViewMode = "formatted" | "raw";

type ProposedPlanParseResult = {
  planMarkdown: string;
  trailingMarkdown: string;
};

const PROPOSED_PLAN_BLOCK_REGEX =
  /^<proposed_plan>\n([\s\S]*?)\n<\/proposed_plan>([\s\S]*)$/;

function parseProposedPlanBlock(text: string): ProposedPlanParseResult | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = normalized.match(PROPOSED_PLAN_BLOCK_REGEX);
  if (!match) {
    return null;
  }

  const planMarkdown = match[1].trim();
  if (!planMarkdown) {
    return null;
  }

  return {
    planMarkdown,
    trailingMarkdown: match[2].trim(),
  };
}

function ProposedPlanRenderer(props: {
  planMarkdown: string;
  trailingMarkdown: string;
  onPlanAction?: (action: "implement" | "stay") => void;
}) {
  const { planMarkdown, trailingMarkdown, onPlanAction } = props;

  return (
    <div className="my-1 rounded-xl border border-sky-400/35 bg-sky-500/10 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-sky-200/90">
        Plan Proposal
      </div>
      <MarkdownRenderer content={planMarkdown} />
      {onPlanAction && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onPlanAction("implement")}
            className="rounded-lg border border-emerald-400/30 bg-emerald-500/15 px-2.5 py-1.5 text-[11px] text-emerald-100 transition-colors hover:bg-emerald-500/25"
          >
            Yes, implement this plan
          </button>
          <button
            type="button"
            onClick={() => onPlanAction("stay")}
            className="rounded-lg border border-zinc-500/35 bg-zinc-500/10 px-2.5 py-1.5 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-500/20"
          >
            No, stay in Plan mode
          </button>
        </div>
      )}
      {trailingMarkdown && (
        <div className="mt-2 border-t border-sky-500/20 pt-2">
          <MarkdownRenderer content={trailingMarkdown} />
        </div>
      )}
    </div>
  );
}

const MessageBlock = memo(function MessageBlock(props: MessageBlockProps) {
  const {
    message,
    onPlanAction,
    pendingUserInputRequests = [],
    selectedUserInputAnswers,
    submittingUserInputRequestIds = [],
    onSelectUserInputOption,
  } = props;

  const isUser = message.type === "user";
  const planActionHandler = isUser ? undefined : onPlanAction;
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
  const toolInputMap = Array.isArray(content)
    ? buildToolInputMap(content)
    : new Map<string, Record<string, unknown>>();
  const pendingUserInputRequestByItemId = new Map<string, CodexUserInputRequest>();
  for (const request of pendingUserInputRequests) {
    if (request.itemId) {
      pendingUserInputRequestByItemId.set(request.itemId, request);
    }
  }
  const submittingRequestIdSet = new Set(submittingUserInputRequestIds);

  if (!hasText && hasAuxiliary) {
    return (
      <div className="flex flex-col gap-1 py-0.5">
        {auxiliaryBlocks.map((block, index) => (
          <ContentBlockRenderer
            key={index}
            block={block}
            toolMap={toolMap}
            toolInputMap={toolInputMap}
            onPlanAction={planActionHandler}
            pendingUserInputRequestByItemId={pendingUserInputRequestByItemId}
            selectedUserInputAnswers={selectedUserInputAnswers}
            submittingUserInputRequestIds={submittingRequestIdSet}
            onSelectUserInputOption={onSelectUserInputOption}
          />
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
            (() => {
              const sanitized = sanitizeText(content);
              const proposedPlan = parseProposedPlanBlock(sanitized);
              if (proposedPlan) {
                return (
                  <ProposedPlanRenderer
                    planMarkdown={proposedPlan.planMarkdown}
                    trailingMarkdown={proposedPlan.trailingMarkdown}
                    onPlanAction={planActionHandler}
                  />
                );
              }
              return <MarkdownRenderer content={sanitized} />;
            })()
          ) : (
            <div className="flex flex-col gap-1">
              {visibleTextBlocks.map((block, index) => (
                <ContentBlockRenderer
                  key={index}
                  block={block}
                  toolMap={toolMap}
                  toolInputMap={toolInputMap}
                  onPlanAction={planActionHandler}
                  pendingUserInputRequestByItemId={pendingUserInputRequestByItemId}
                  selectedUserInputAnswers={selectedUserInputAnswers}
                  submittingUserInputRequestIds={submittingRequestIdSet}
                  onSelectUserInputOption={onSelectUserInputOption}
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
                toolInputMap={toolInputMap}
                onPlanAction={planActionHandler}
                pendingUserInputRequestByItemId={pendingUserInputRequestByItemId}
                selectedUserInputAnswers={selectedUserInputAnswers}
                submittingUserInputRequestIds={submittingRequestIdSet}
                onSelectUserInputOption={onSelectUserInputOption}
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
  toolInputMap?: Map<string, Record<string, unknown>>;
  onPlanAction?: (action: "implement" | "stay") => void;
  pendingUserInputRequestByItemId?: Map<string, CodexUserInputRequest>;
  selectedUserInputAnswers?: Record<string, Record<string, string>>;
  submittingUserInputRequestIds?: Set<string>;
  onSelectUserInputOption?: (
    request: CodexUserInputRequest,
    questionId: string,
    optionLabel: string,
  ) => void;
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

const PATCH_FILE_HEADER_REGEX = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE_TO_HEADER_REGEX = /^\*\*\* Move to: (.+)$/;
const PATCH_UNIFIED_HUNK_HEADER_REGEX =
  /^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/;

type PatchFileOperation = "add" | "update" | "delete";
type PatchLineNumberState = {
  oldLineNumber: number | null;
  newLineNumber: number | null;
};

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
    types.add(detectLanguageFromPath(match[2].trim()).label);
  }

  return [...types];
}

function getPatchFileOperation(line: string): PatchFileOperation | null {
  const fileHeaderMatch = line.match(PATCH_FILE_HEADER_REGEX);
  if (!fileHeaderMatch) {
    return null;
  }

  const operation = fileHeaderMatch[1].toLowerCase();
  if (operation === "add" || operation === "update" || operation === "delete") {
    return operation;
  }
  return null;
}

function getPatchHunkStartLineNumbers(line: string): PatchLineNumberState | null {
  const hunkMatch = line.match(PATCH_UNIFIED_HUNK_HEADER_REGEX);
  if (!hunkMatch) {
    return null;
  }

  return {
    oldLineNumber: Number.parseInt(hunkMatch[1], 10),
    newLineNumber: Number.parseInt(hunkMatch[2], 10),
  };
}

function getPatchLineNumbersForCodeLine(
  prefix: string,
  state: PatchLineNumberState,
): { oldLine: number | null; newLine: number | null } {
  if (prefix === "+") {
    const newLine = state.newLineNumber;
    if (state.newLineNumber !== null) {
      state.newLineNumber += 1;
    }
    return { oldLine: null, newLine };
  }

  if (prefix === "-") {
    const oldLine = state.oldLineNumber;
    if (state.oldLineNumber !== null) {
      state.oldLineNumber += 1;
    }
    return { oldLine, newLine: null };
  }

  const oldLine = state.oldLineNumber;
  const newLine = state.newLineNumber;
  if (state.oldLineNumber !== null) {
    state.oldLineNumber += 1;
  }
  if (state.newLineNumber !== null) {
    state.newLineNumber += 1;
  }

  return { oldLine, newLine };
}

function getPatchLineNumberDisplay(value: number | null): string {
  return value === null ? " " : String(value);
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

function ApplyPatchInputRenderer(props: {
  raw: string;
  embedded?: boolean;
  hideHeader?: boolean;
}) {
  const { raw, embedded = false, hideHeader = false } = props;
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const fileTypes = getPatchFileTypes(raw);
  const fileTypeLabel =
    fileTypes.length === 0
      ? "Patch"
      : fileTypes.length === 1
        ? fileTypes[0]
        : `${fileTypes.length} file types`;

  return (
    <div
      className={`overflow-hidden ${embedded ? "rounded-md border border-zinc-700/45 bg-zinc-950/70" : "rounded-lg border border-zinc-700/60 bg-zinc-950/80"}`}
    >
      {!hideHeader && (
        <div
          className={`flex items-center justify-between border-b border-zinc-700/50 px-3 py-1.5 ${embedded ? "bg-zinc-900/55" : "bg-zinc-900/70"}`}
        >
          <span className="text-[10px] font-mono text-zinc-400">apply_patch</span>
          <span className="text-[10px] font-mono text-zinc-500">
            {fileTypeLabel}
          </span>
        </div>
      )}
      <pre className="m-0 max-h-[420px] overflow-auto rounded-none border-0 bg-transparent p-0 text-xs leading-relaxed">
        {(() => {
          let activeLanguage: string | null = null;
          let currentFileOperation: PatchFileOperation | null = null;
          const lineNumberState: PatchLineNumberState = {
            oldLineNumber: null,
            newLineNumber: null,
          };

          return lines.map((line, index) => {
            const fileHeaderMatch = line.match(PATCH_FILE_HEADER_REGEX);
            if (fileHeaderMatch) {
              const operation = getPatchFileOperation(line);
              currentFileOperation = operation;
              const filePath = fileHeaderMatch[2].trim();
              activeLanguage = detectLanguageFromPath(filePath).highlight;

              if (operation === "add") {
                lineNumberState.oldLineNumber = null;
                lineNumberState.newLineNumber = 1;
              } else if (operation === "delete") {
                lineNumberState.oldLineNumber = 1;
                lineNumberState.newLineNumber = null;
              } else {
                // apply_patch hunks are typically plain "@@" without ranges.
                // Fall back to patch-local numbering so line numbers are always visible.
                lineNumberState.oldLineNumber = 1;
                lineNumberState.newLineNumber = 1;
              }
            }

            const moveToMatch = line.match(PATCH_MOVE_TO_HEADER_REGEX);
            if (moveToMatch) {
              activeLanguage = detectLanguageFromPath(
                moveToMatch[1].trim(),
              ).highlight;
            }

            const hunkStart = getPatchHunkStartLineNumbers(line);
            if (hunkStart) {
              lineNumberState.oldLineNumber = hunkStart.oldLineNumber;
              lineNumberState.newLineNumber = hunkStart.newLineNumber;
            } else if (line.startsWith("@@")) {
              if (currentFileOperation === "add") {
                lineNumberState.oldLineNumber = null;
                if (lineNumberState.newLineNumber === null) {
                  lineNumberState.newLineNumber = 1;
                }
              } else if (currentFileOperation === "delete") {
                if (lineNumberState.oldLineNumber === null) {
                  lineNumberState.oldLineNumber = 1;
                }
                lineNumberState.newLineNumber = null;
              } else if (currentFileOperation === "update") {
                if (lineNumberState.oldLineNumber === null) {
                  lineNumberState.oldLineNumber = 1;
                }
                if (lineNumberState.newLineNumber === null) {
                  lineNumberState.newLineNumber = 1;
                }
              }
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

            const lineNumbers = getPatchLineNumbersForCodeLine(
              codeLine.prefix,
              lineNumberState,
            );

            return (
              <div key={`${index}:${line}`} className={lineClass}>
                <span className="inline-block w-[5ch] select-none pr-2 text-right tabular-nums text-zinc-400">
                  {getPatchLineNumberDisplay(lineNumbers.oldLine)}
                </span>
                <span className="inline-block w-[5ch] select-none pr-2 text-right tabular-nums text-zinc-400">
                  {getPatchLineNumberDisplay(lineNumbers.newLine)}
                </span>
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

type NormalizedTodoItem = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

function normalizeTodoStatus(value: unknown): NormalizedTodoItem["status"] {
  if (value === "completed" || value === "in_progress" || value === "pending") {
    return value;
  }
  return "pending";
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getTodoItemsFromInput(input: Record<string, unknown>): NormalizedTodoItem[] {
  if (Array.isArray(input.todos)) {
    return input.todos
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        content:
          typeof item.content === "string" && item.content.trim().length > 0
            ? item.content
            : "(empty step)",
        status: normalizeTodoStatus(item.status),
      }));
  }

  if (Array.isArray(input.plan)) {
    return input.plan
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        content:
          typeof item.step === "string" && item.step.trim().length > 0
            ? item.step
            : "(empty step)",
        status: normalizeTodoStatus(item.status),
      }));
  }

  return [];
}

function toAskQuestionInput(input: Record<string, unknown>): {
  requestId?: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
} {
  if (!Array.isArray(input.questions)) {
    return { questions: [] };
  }

  const questions = input.questions
    .filter((question): question is Record<string, unknown> => isRecord(question))
    .map((question, index) => {
      const options = Array.isArray(question.options)
        ? question.options
            .filter((option): option is Record<string, unknown> => isRecord(option))
            .map((option) => ({
              label:
                typeof option.label === "string" && option.label.trim().length > 0
                  ? option.label
                  : "Option",
              description:
                typeof option.description === "string" ? option.description : "",
            }))
        : [];

      return {
        id:
          typeof question.id === "string" && question.id.trim().length > 0
            ? question.id
            : `question-${index}`,
        header:
          typeof question.header === "string" && question.header.trim().length > 0
            ? question.header
            : "Question",
        question:
          typeof question.question === "string" && question.question.trim().length > 0
            ? question.question
            : "",
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question) => question.question.length > 0);

  return { questions };
}

function summarizeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "string") {
    if (!value.trim()) {
      return "(empty)";
    }
    return value.length > 140 ? `${value.slice(0, 140)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item(s)`;
  }
  if (isRecord(value)) {
    return `${Object.keys(value).length} field(s)`;
  }
  return String(value);
}

function GenericToolInputRenderer(props: {
  input: Record<string, unknown>;
  embedded?: boolean;
  hideHeader?: boolean;
}) {
  const entries = Object.entries(props.input);
  const { embedded = false, hideHeader = false } = props;

  if (entries.length === 0) {
    return (
      <div
        className={`${embedded ? "rounded-md bg-zinc-900/40" : "rounded-lg border border-zinc-700/50 bg-zinc-900/70"} px-3 py-2 text-xs text-zinc-500`}
      >
        No input arguments
      </div>
    );
  }

  return (
    <div
      className={`overflow-hidden ${embedded ? "rounded-md bg-zinc-900/40" : "rounded-lg border border-zinc-700/50 bg-zinc-900/70"}`}
    >
      {!hideHeader && (
        <div
          className={`border-b border-zinc-700/50 px-3 py-2 text-xs font-medium text-zinc-300 ${embedded ? "bg-zinc-800/25" : "bg-zinc-800/30"}`}
        >
          Parameters
        </div>
      )}
      <div className="divide-y divide-zinc-800/50">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-start gap-3 px-3 py-2 text-xs">
            <span className="w-36 shrink-0 font-mono text-zinc-500">{key}</span>
            <span className="whitespace-pre-wrap break-all text-zinc-300">
              {summarizeValue(value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function getRawToolInputValue(
  block: ContentBlock,
  input: Record<string, unknown>,
): unknown {
  return {
    type: block.type,
    id: block.id,
    name: block.name,
    input,
  };
}

function renderFormattedToolInput(
  block: ContentBlock,
  input: Record<string, unknown>,
  embedded: boolean,
  hideHeader: boolean,
  requestUserInputRequest?: CodexUserInputRequest,
  selectedUserInputAnswers?: Record<string, string>,
  submittingUserInputRequest = false,
  onSelectUserInputOption?: (
    request: CodexUserInputRequest,
    questionId: string,
    optionLabel: string,
  ) => void,
): JSX.Element {
  const toolName = (block.name || "").toLowerCase();
  const rawInput = typeof input.raw === "string" ? input.raw : null;

  if (toolName === "apply_patch" && rawInput) {
    return (
      <ApplyPatchInputRenderer
        raw={rawInput}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (
    (toolName === "bash" || toolName === "exec_command" || toolName === "write_stdin") &&
    (typeof input.command === "string" ||
      typeof input.cmd === "string" ||
      typeof input.chars === "string")
  ) {
    const command =
      typeof input.command === "string"
        ? input.command
        : typeof input.cmd === "string"
          ? input.cmd
          : String(input.chars ?? "");
    if (command.length > 0) {
      const description =
        typeof input.description === "string"
          ? input.description
          : typeof input.session_id === "number"
            ? `session ${input.session_id}`
            : undefined;

      return (
        <BashRenderer
          input={{ command, description }}
          embedded={embedded}
          hideHeader={hideHeader}
        />
      );
    }
  }

  if (toolName === "read" && typeof input.file_path === "string") {
    return (
      <ReadRenderer
        input={{
          file_path: input.file_path,
          offset: asOptionalNumber(input.offset),
          limit: asOptionalNumber(input.limit),
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "grep" && typeof input.pattern === "string") {
    return (
      <GrepRenderer
        input={{
          pattern: input.pattern,
          path: asOptionalString(input.path),
          glob: asOptionalString(input.glob),
          type: asOptionalString(input.type),
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "glob" && typeof input.pattern === "string") {
    return (
      <GlobRenderer
        input={{
          pattern: input.pattern,
          path: asOptionalString(input.path),
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "edit" && typeof input.file_path === "string") {
    return (
      <EditRenderer
        input={{
          file_path: input.file_path,
          old_string: typeof input.old_string === "string" ? input.old_string : "",
          new_string: typeof input.new_string === "string" ? input.new_string : "",
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "write" && typeof input.file_path === "string") {
    return (
      <WriteRenderer
        input={{
          file_path: input.file_path,
          content:
            typeof input.content === "string"
              ? input.content
              : stringifyJson(input.content),
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  if (toolName === "update_plan" || toolName === "todowrite") {
    const todos = getTodoItemsFromInput(input);
    if (todos.length > 0) {
      return (
        <TodoRenderer
          todos={todos}
          embedded={embedded}
          hideHeader={hideHeader}
        />
      );
    }
  }

  if (toolName === "request_user_input" || toolName === "askuserquestion") {
    const normalizedInput = toAskQuestionInput(input);
    if (normalizedInput.questions.length > 0) {
      return (
        <AskQuestionRenderer
          input={normalizedInput}
          embedded={embedded}
          hideHeader={hideHeader}
          selectedAnswers={selectedUserInputAnswers}
          submitting={submittingUserInputRequest}
          onSelectOption={
            requestUserInputRequest && onSelectUserInputOption
              ? (questionId, optionLabel) =>
                  onSelectUserInputOption(
                    requestUserInputRequest,
                    questionId,
                    optionLabel,
                  )
              : undefined
          }
        />
      );
    }
  }

  if (toolName === "task" || toolName === "spawn_agent") {
    const prompt =
      typeof input.prompt === "string"
        ? input.prompt
        : typeof input.message === "string"
          ? input.message
          : "Task request";
    return (
      <TaskRenderer
        input={{
          description:
            typeof input.description === "string" ? input.description : "",
          prompt,
          subagent_type:
            typeof input.subagent_type === "string"
              ? input.subagent_type
              : typeof input.agent_type === "string"
                ? input.agent_type
                : "default",
          model: asOptionalString(input.model),
          run_in_background: input.run_in_background === true,
          resume:
            typeof input.resume === "string"
              ? input.resume
              : typeof input.id === "string"
                ? input.id
                : undefined,
        }}
        embedded={embedded}
        hideHeader={hideHeader}
      />
    );
  }

  return (
    <GenericToolInputRenderer
      input={input}
      embedded={embedded}
      hideHeader={hideHeader}
    />
  );
}

function renderToolInput(
  block: ContentBlock,
  input: Record<string, unknown>,
  viewMode: JsonViewMode,
  embedded: boolean,
  requestUserInputRequest?: CodexUserInputRequest,
  selectedUserInputAnswers?: Record<string, string>,
  submittingUserInputRequest = false,
  onSelectUserInputOption?: (
    request: CodexUserInputRequest,
    questionId: string,
    optionLabel: string,
  ) => void,
): JSX.Element {
  if (viewMode === "raw") {
    return <JsonRenderer value={getRawToolInputValue(block, input)} />;
  }

  return renderFormattedToolInput(
    block,
    input,
    embedded,
    embedded,
    requestUserInputRequest,
    selectedUserInputAnswers,
    submittingUserInputRequest,
    onSelectUserInputOption,
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

function getToolCopyText(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | null {
  if (!input) {
    return null;
  }

  const name = toolName.toLowerCase();
  if (name === "exec_command" || name === "bash") {
    if (typeof input.cmd === "string" && input.cmd.length > 0) {
      return input.cmd;
    }
    if (typeof input.command === "string" && input.command.length > 0) {
      return input.command;
    }
    return null;
  }

  if (name === "write_stdin") {
    return typeof input.chars === "string" && input.chars.length > 0
      ? input.chars
      : null;
  }

  return null;
}

function getToolExpandedLabel(toolName: string): string | null {
  const name = toolName.toLowerCase();
  if (name === "exec_command" || name === "bash" || name === "write_stdin") {
    return "Command";
  }
  return null;
}

interface ToolResultRendererProps {
  toolName: string;
  content: string;
  isError?: boolean;
  command?: string;
  embedded?: boolean;
  hideHeader?: boolean;
}

function parseJsonValue(content: string): { parsed: boolean; value: unknown } {
  const trimmed = content.trim();
  if (!trimmed) {
    return { parsed: false, value: null };
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
    return { parsed: false, value: null };
  }

  try {
    return { parsed: true, value: JSON.parse(trimmed) };
  } catch {
    return { parsed: false, value: null };
  }
}

function tryParseJson(content: string): unknown {
  const parsed = parseJsonValue(content);
  return parsed.parsed ? parsed.value : null;
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

function getExecBody(content: string): string {
  const outputMarker = "\nOutput:\n";
  const outputIndex = content.indexOf(outputMarker);
  return outputIndex >= 0
    ? content.slice(outputIndex + outputMarker.length).trimEnd()
    : content;
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

function getCommandFromToolInput(
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (!input) {
    return undefined;
  }

  if (typeof input.cmd === "string" && input.cmd.trim().length > 0) {
    return input.cmd;
  }

  if (typeof input.command === "string" && input.command.trim().length > 0) {
    return input.command;
  }

  return undefined;
}

function getToolResultRawValue(
  block: ContentBlock,
  toolName: string,
): unknown | null {
  if (typeof block.content === "string") {
    const parsed = parseJsonValue(block.content);
    if (!parsed.parsed) {
      return null;
    }

    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      name: toolName || block.name,
      is_error: block.is_error,
      content: parsed.value,
    };
  }

  if (
    block.content !== undefined &&
    (typeof block.content === "object" ||
      typeof block.content === "number" ||
      typeof block.content === "boolean")
  ) {
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      name: toolName || block.name,
      is_error: block.is_error,
      content: block.content,
    };
  }

  return null;
}

function ContentBlockRenderer(props: ContentBlockRendererProps) {
  const {
    block,
    toolMap,
    toolInputMap,
    onPlanAction,
    pendingUserInputRequestByItemId,
    selectedUserInputAnswers,
    submittingUserInputRequestIds,
    onSelectUserInputOption,
  } = props;
  const [expanded, setExpanded] = useState(
    block.type === "tool_use" || block.type === "tool_result",
  );
  const [jsonViewMode, setJsonViewMode] = useState<JsonViewMode>("formatted");

  if (block.type === "text" && block.text) {
    const sanitized = sanitizeText(block.text);
    if (!sanitized) {
      return null;
    }
    const proposedPlan = parseProposedPlanBlock(sanitized);
    if (proposedPlan) {
      return (
        <ProposedPlanRenderer
          planMarkdown={proposedPlan.planMarkdown}
          trailingMarkdown={proposedPlan.trailingMarkdown}
          onPlanAction={onPlanAction}
        />
      );
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
    const hasInput = !!input && Object.keys(input).length > 0;
    const Icon = getToolIcon(block.name || "");
    const preview = getToolPreview(block.name || "", input);
    const toolName = block.name?.toLowerCase() || "";
    const requestUserInputRequest =
      toolName === "request_user_input" && block.id
        ? pendingUserInputRequestByItemId?.get(block.id)
        : undefined;
    const selectedAnswersForRequest = requestUserInputRequest
      ? selectedUserInputAnswers?.[requestUserInputRequest.requestId]
      : undefined;
    const submittingUserInputRequest = requestUserInputRequest
      ? submittingUserInputRequestIds?.has(requestUserInputRequest.requestId) ===
        true
      : false;

    const shouldAutoExpand =
      toolName === "todowrite" ||
      toolName === "askuserquestion" ||
      toolName === "task";
    const isExpanded = expanded || shouldAutoExpand;
    const canToggleExpanded = hasInput && !shouldAutoExpand;
    const supportsRawToggle = hasInput;
    const expandedLabel = getToolExpandedLabel(toolName);
    const copyText = isExpanded ? getToolCopyText(toolName, input) : null;

    return (
      <div className={isExpanded ? "w-full" : ""}>
        <div className="overflow-hidden rounded-lg border border-slate-500/20 bg-slate-500/10">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5">
            <button
              type="button"
              onClick={() => canToggleExpanded && setExpanded(!expanded)}
              className={`flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] transition-colors ${
                canToggleExpanded
                  ? "cursor-pointer text-slate-200 hover:text-slate-100"
                  : "cursor-default text-slate-200"
              }`}
            >
              <Icon size={12} className="opacity-60" />
              <span className="font-medium">{block.name}</span>
              {expandedLabel && isExpanded && (
                <span className="font-normal text-slate-400">{expandedLabel}</span>
              )}
              {preview && !isExpanded && (
                <span className="truncate font-normal text-slate-400 max-w-[200px]">
                  {preview}
                </span>
              )}
              {canToggleExpanded && (
                <span className="ml-0.5 text-[10px] opacity-40">
                  {expanded ? "▼" : "▶"}
                </span>
              )}
            </button>
            {copyText && (
              <CopyButton
                text={copyText}
                title="Copy command"
                className="rounded-lg border border-slate-500/20 bg-slate-500/10 hover:bg-slate-500/15"
              />
            )}
            {supportsRawToggle && isExpanded && (
              <button
                type="button"
                onClick={() =>
                  setJsonViewMode((current) =>
                    current === "formatted" ? "raw" : "formatted",
                  )
                }
                className={`rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors ${
                  jsonViewMode === "raw"
                    ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                    : "border-slate-500/20 bg-slate-500/10 text-slate-300 hover:bg-slate-500/15"
                }`}
                title={
                  jsonViewMode === "raw"
                    ? "Show formatted view"
                    : "Show raw JSON"
                }
              >
                {"</>"}
              </button>
            )}
          </div>
          {isExpanded && hasInput && input && (
            <div className="border-t border-slate-500/20 px-2.5 py-2">
              {renderToolInput(
                block,
                input,
                jsonViewMode,
                true,
                requestUserInputRequest,
                selectedAnswersForRequest,
                submittingUserInputRequest,
                onSelectUserInputOption,
              )}
            </div>
          )}
        </div>
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
    const toolInput =
      block.tool_use_id && toolInputMap
        ? toolInputMap.get(block.tool_use_id)
        : undefined;
    const command = getCommandFromToolInput(toolInput);

    const contentPreview =
      hasContent && !expanded
        ? getToolResultPreview(toolName, resultContent) ||
          resultContent.slice(0, previewLength) +
            (resultContent.length > previewLength ? "..." : "")
        : null;
    const rawJsonValue = getToolResultRawValue(block, toolName);
    const supportsRawToggle = rawJsonValue !== null;
    const canToggleExpanded = hasContent;
    const normalizedToolName = toolName.toLowerCase();
    const isCommandResult =
      normalizedToolName === "exec_command" ||
      normalizedToolName === "write_stdin" ||
      normalizedToolName === "bash";
    const expandedLabel =
      expanded && isCommandResult ? "Terminal output" : null;
    const resultCopyText =
      expanded && isCommandResult && hasContent
        ? getExecBody(resultContent)
        : null;

    return (
      <div className={expanded ? "w-full" : ""}>
        <div
          className={`overflow-hidden rounded-lg border ${
            isError
              ? "border-rose-500/20 bg-rose-500/10"
              : "border-teal-500/20 bg-teal-500/10"
          }`}
        >
          <div className="flex items-center gap-1.5 px-2.5 py-1.5">
            <button
              type="button"
              onClick={() => canToggleExpanded && setExpanded(!expanded)}
              className={`flex min-w-0 flex-1 items-center gap-1.5 text-left text-[11px] transition-colors ${
                canToggleExpanded
                  ? isError
                    ? "cursor-pointer text-rose-300 hover:text-rose-200"
                    : "cursor-pointer text-teal-200 hover:text-teal-100"
                  : isError
                    ? "cursor-default text-rose-300"
                    : "cursor-default text-teal-200"
              }`}
            >
              {isError ? (
                <X size={12} className="opacity-70" />
              ) : (
                <Check size={12} className="opacity-70" />
              )}
              <span className="font-medium">{isError ? "error" : "result"}</span>
              {expandedLabel && (
                <span
                  className={`font-normal ${isError ? "text-rose-400/75" : "text-teal-400/75"}`}
                >
                  {expandedLabel}
                </span>
              )}
              {contentPreview && !expanded && (
                <span
                  className={`truncate font-normal max-w-[220px] ${isError ? "text-rose-400/70" : "text-teal-400/70"}`}
                >
                  {contentPreview}
                </span>
              )}
              {canToggleExpanded && (
                <span className="ml-0.5 text-[10px] opacity-40">
                  {expanded ? "▼" : "▶"}
                </span>
              )}
            </button>
            {resultCopyText && (
              <CopyButton
                text={resultCopyText}
                title="Copy output"
                className={`rounded-lg border ${
                  isError
                    ? "border-rose-500/25 bg-rose-500/10 hover:bg-rose-500/15"
                    : "border-teal-500/25 bg-teal-500/10 hover:bg-teal-500/15"
                }`}
              />
            )}
            {supportsRawToggle && expanded && (
              <button
                type="button"
                onClick={() =>
                  setJsonViewMode((current) =>
                    current === "formatted" ? "raw" : "formatted",
                  )
                }
                className={`rounded-lg border px-2 py-1 text-[11px] font-mono transition-colors ${
                  jsonViewMode === "raw"
                    ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-200"
                    : isError
                      ? "border-rose-500/25 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15"
                      : "border-teal-500/25 bg-teal-500/10 text-teal-200 hover:bg-teal-500/15"
                }`}
                title={
                  jsonViewMode === "raw"
                    ? "Show formatted view"
                    : "Show raw JSON"
                }
              >
                {"</>"}
              </button>
            )}
          </div>
          {expanded && hasContent && (
            <div
              className={`border-t px-2.5 py-2 ${
                isError ? "border-rose-500/20" : "border-teal-500/20"
              }`}
            >
              {supportsRawToggle && jsonViewMode === "raw" ? (
                <JsonRenderer value={rawJsonValue} />
              ) : (
                <ToolResultRenderer
                  toolName={toolName}
                  content={resultContent}
                  isError={isError}
                  command={command}
                  embedded
                  hideHeader={isCommandResult}
                />
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}

export default MessageBlock;
