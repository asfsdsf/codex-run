import { readdir, readFile, stat, open } from "fs/promises";
import { basename, join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

export interface HistoryEntry {
  sessionId: string;
  timestamp: number;
  text: string;
}

export interface Session {
  id: string;
  display: string;
  timestamp: number;
  project: string;
  projectName: string;
}

export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface CodexModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort: CodexReasoningEffort | null;
  supportedReasoningEfforts: CodexReasoningEffort[];
}

export interface CodexCollaborationModeSettings {
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  developerInstructions?: string | null;
}

export interface CodexCollaborationModeOption {
  mode: string;
  name: string;
  model?: string | null;
  reasoningEffort?: CodexReasoningEffort | null;
  developerInstructions?: string | null;
}

export interface CodexCollaborationModeInput {
  mode: string;
  settings?: CodexCollaborationModeSettings;
}

export interface CreateCodexThreadRequest {
  cwd: string;
  model?: string | null;
  effort?: CodexReasoningEffort | null;
}

export interface CreateCodexThreadResponse {
  threadId: string;
}

export interface SendCodexMessageRequest {
  text: string;
  cwd?: string;
  model?: string | null;
  effort?: CodexReasoningEffort | null;
  collaborationMode?: CodexCollaborationModeInput | null;
}

export interface SendCodexMessageResponse {
  ok: boolean;
  turnId: string | null;
}

export type CodexTurnStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "interrupted";

export interface CodexThreadStateResponse {
  threadId: string;
  activeTurnId: string | null;
  isGenerating: boolean;
  requestedTurnId: string | null;
  requestedTurnStatus: CodexTurnStatus | null;
}

export interface CodexUserInputQuestionOption {
  label: string;
  description: string;
}

export interface CodexUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexUserInputQuestionOption[];
}

export interface CodexUserInputRequest {
  requestId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexUserInputQuestion[];
}

export interface CodexUserInputResponsePayload {
  answers: Record<string, { answers: string[] }>;
}

export interface CodexSessionContextResponse {
  sessionId: string;
  contextLeftPercent: number | null;
  usedTokens: number | null;
  modelContextWindow: number | null;
}

export interface ConversationMessage {
  type:
    | "user"
    | "assistant"
    | "summary"
    | "file-history-snapshot"
    | "reasoning"
    | "agent_reasoning";
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role: string;
    content: string | ContentBlock[];
    model?: string;
    usage?: TokenUsage;
  };
  summary?: string;
}

export interface ContentBlock {
  type:
    | "text"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "reasoning"
    | "agent_reasoning";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface StreamResult {
  messages: ConversationMessage[];
  nextOffset: number;
}

interface SessionMeta {
  id: string;
  cwd: string;
  timestamp: number;
}

interface SessionHistory {
  timestamp: number;
  text: string;
}

interface LineWithOffset {
  line: string;
  offset: number;
}

interface PendingToolUse {
  callId: string;
  name: string;
  input: Record<string, unknown>;
  timestamp?: string;
  lineOffset: number;
}

const TOOL_RESULT_MAX_LENGTH = 200_000;
const CONTEXT_WINDOW_BASELINE_TOKENS = 12_000;

let codexDir = join(homedir(), ".codex");
let codexHistoryPath = join(codexDir, "history.jsonl");
let codexSessionsDir = join(codexDir, "sessions");

const fileIndex = new Map<string, string>();
const sessionMetaIndex = new Map<string, SessionMeta>();
const sessionDisplayCache = new Map<string, string>();
let historyCache: Map<string, SessionHistory> | null = null;

const pendingRequests = new Map<string, Promise<unknown>>();
const sessionToolNameIndex = new Map<string, Map<string, string>>();

export function initStorage(dir?: string): void {
  codexDir = dir ?? join(homedir(), ".codex");
  codexHistoryPath = join(codexDir, "history.jsonl");
  codexSessionsDir = join(codexDir, "sessions");
}

export function getCodexDir(): string {
  return codexDir;
}

// Backward-compatible export to avoid breaking existing imports.
export function getClaudeDir(): string {
  return getCodexDir();
}

export function invalidateHistoryCache(): void {
  historyCache = null;
}

export function addToFileIndex(sessionId: string, filePath: string): void {
  fileIndex.set(sessionId, filePath);
  sessionDisplayCache.delete(sessionId);
  void hydrateSessionMeta(sessionId, filePath);
}

function getProjectName(projectPath: string): string {
  const parts = projectPath.split("/").filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

function normalizeDisplayText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(no prompt text)";
  }
  return normalized.length > 240
    ? `${normalized.slice(0, 240)}...`
    : normalized;
}

function extractSessionIdFromPath(filePath: string): string | null {
  const name = basename(filePath);
  const match = name.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber;
    }
    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate)) {
      return asDate;
    }
  }
  return 0;
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function computeContextLeftPercent(totalTokens: number, contextWindow: number): number {
  if (contextWindow <= CONTEXT_WINDOW_BASELINE_TOKENS) {
    return 0;
  }

  const effectiveWindow = contextWindow - CONTEXT_WINDOW_BASELINE_TOKENS;
  const used = Math.max(totalTokens - CONTEXT_WINDOW_BASELINE_TOKENS, 0);
  const remaining = Math.max(effectiveWindow - used, 0);
  const percent = Math.round((remaining / effectiveWindow) * 100);
  return Math.max(0, Math.min(100, percent));
}

async function readFirstLine(filePath: string): Promise<string | null> {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const stream = fileHandle.createReadStream({
      start: 0,
      end: 64 * 1024,
      encoding: "utf-8",
    });

    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      return line;
    }

    return null;
  } catch {
    return null;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

function parseSessionMetaLine(line: string): SessionMeta | null {
  const parsed = safeJsonParse(line);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const record = parsed as { type?: string; payload?: Record<string, unknown> };
  if (record.type !== "session_meta" || !record.payload) {
    return null;
  }

  const id =
    typeof record.payload.id === "string" ? record.payload.id.trim() : "";
  if (!id) {
    return null;
  }

  return {
    id,
    cwd:
      typeof record.payload.cwd === "string" ? record.payload.cwd.trim() : "",
    timestamp: parseTimestamp(record.payload.timestamp),
  };
}

async function readSessionMetaFromFile(
  filePath: string,
): Promise<SessionMeta | null> {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine) {
    return null;
  }
  return parseSessionMetaLine(firstLine);
}

async function hydrateSessionMeta(
  sessionId: string,
  filePath: string,
): Promise<void> {
  if (sessionMetaIndex.has(sessionId)) {
    return;
  }

  const meta = await readSessionMetaFromFile(filePath);
  if (meta) {
    sessionMetaIndex.set(sessionId, meta);
  }
}

async function collectSessionFiles(
  dirPath: string,
  output: string[],
): Promise<void> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await collectSessionFiles(fullPath, output);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        output.push(fullPath);
      }
    }
  } catch {
    // Session directory may not exist yet.
  }
}

async function buildFileIndex(): Promise<void> {
  fileIndex.clear();
  sessionMetaIndex.clear();

  const files: string[] = [];
  await collectSessionFiles(codexSessionsDir, files);

  for (const filePath of files) {
    const fileSessionId = extractSessionIdFromPath(filePath);

    let sessionId = fileSessionId;
    const meta = await readSessionMetaFromFile(filePath);
    if (meta) {
      sessionMetaIndex.set(meta.id, meta);
      sessionId = meta.id;
    }

    if (sessionId) {
      fileIndex.set(sessionId, filePath);
    }
  }
}

async function loadHistoryCache(): Promise<Map<string, SessionHistory>> {
  const cache = new Map<string, SessionHistory>();

  try {
    const content = await readFile(codexHistoryPath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const parsed = safeJsonParse(line);
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const entry = parsed as {
        session_id?: unknown;
        ts?: unknown;
        text?: unknown;
      };

      if (typeof entry.session_id !== "string" || !entry.session_id.trim()) {
        continue;
      }

      const ts = parseTimestamp(entry.ts);
      if (!Number.isFinite(ts) || ts <= 0) {
        continue;
      }

      const current = cache.get(entry.session_id);
      if (current && current.timestamp > ts) {
        continue;
      }

      cache.set(entry.session_id, {
        timestamp: ts,
        text: typeof entry.text === "string" ? entry.text : "",
      });
    }
  } catch {
    // History file may not exist yet.
  }

  historyCache = cache;
  return cache;
}

async function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = pendingRequests.get(key);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = fn().finally(() => {
    pendingRequests.delete(key);
  });

  pendingRequests.set(key, promise);
  return promise;
}

async function findSessionFile(sessionId: string): Promise<string | null> {
  if (fileIndex.has(sessionId)) {
    return fileIndex.get(sessionId)!;
  }

  await buildFileIndex();
  if (fileIndex.has(sessionId)) {
    return fileIndex.get(sessionId)!;
  }

  return null;
}

function truncateToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_MAX_LENGTH) {
    return content;
  }

  const omitted = content.length - TOOL_RESULT_MAX_LENGTH;
  return `${content.slice(0, TOOL_RESULT_MAX_LENGTH)}\n... [truncated ${omitted} chars]`;
}

function toToolInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const parsed = safeJsonParse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { raw: value };
  }
  if (value === undefined) {
    return {};
  }
  return { value };
}

function toToolOutputValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateToolResult(value);
  }
  if (value === undefined || value === null) {
    return "";
  }

  return value;
}

function createTextMessage(
  role: "user" | "assistant",
  text: string,
  uuid: string,
  timestamp?: string,
): ConversationMessage {
  return {
    type: role,
    uuid,
    timestamp,
    message: {
      role,
      content: [
        {
          type: "text",
          text,
        },
      ],
    },
  };
}

function createReasoningMessage(
  type: "reasoning" | "agent_reasoning",
  text: string,
  uuid: string,
  timestamp?: string,
): ConversationMessage {
  return {
    type,
    uuid,
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type,
          text,
        },
      ],
    },
  };
}

function createToolMessage(
  toolUse: PendingToolUse,
  uuid: string,
  result?: { content: unknown; isError?: boolean },
): ConversationMessage {
  const content: ContentBlock[] = [
    {
      type: "tool_use",
      id: toolUse.callId,
      name: toolUse.name,
      input: toolUse.input,
    },
  ];

  if (result) {
    content.push({
      type: "tool_result",
      tool_use_id: toolUse.callId,
      name: toolUse.name,
      content: result.content,
      is_error: result.isError,
    });
  }

  return {
    type: "assistant",
    uuid,
    timestamp: toolUse.timestamp,
    message: {
      role: "assistant",
      content,
    },
  };
}

function createToolResultOnlyMessage(
  callId: string,
  content: unknown,
  uuid: string,
  timestamp?: string,
  isError?: boolean,
  name?: string,
): ConversationMessage {
  return {
    type: "assistant",
    uuid,
    timestamp,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_result",
          tool_use_id: callId,
          name,
          content,
          is_error: isError,
        },
      ],
    },
  };
}

function extractTextFromPayloadContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const block = item as { type?: unknown; text?: unknown };
    if (
      (block.type === "input_text" || block.type === "output_text") &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }

  return parts.join("\n\n").trim();
}

function extractTextFromReasoningParts(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractTextFromReasoningParts(item))
      .filter(Boolean);
    return parts.join("\n\n").trim();
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    summary?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text.trim();
  }

  if (record.summary !== undefined) {
    const summaryText = extractTextFromReasoningParts(record.summary);
    if (summaryText) {
      return summaryText;
    }
  }

  if (record.content !== undefined) {
    return extractTextFromReasoningParts(record.content);
  }

  return "";
}

function extractReasoningText(payload: Record<string, unknown>): string {
  const summaryText = extractTextFromReasoningParts(payload.summary);
  if (summaryText) {
    return summaryText;
  }

  return extractTextFromReasoningParts(payload.content);
}

function normalizeReasoningText(text: string): string {
  const trimmed = text.trim();
  const unwrapped = trimmed.replace(/^\*\*(.*?)\*\*$/s, "$1");
  return unwrapped.replace(/\s+/g, " ").trim().toLowerCase();
}

function getReasoningTextFromMessage(
  message: ConversationMessage,
): string | null {
  if (message.type !== "reasoning" && message.type !== "agent_reasoning") {
    return null;
  }

  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const block = content.find(
    (item) => item.type === "reasoning" || item.type === "agent_reasoning",
  );

  return typeof block?.text === "string" ? block.text : null;
}

function pushConversationMessage(
  messages: ConversationMessage[],
  message: ConversationMessage,
): void {
  if (message.type === "reasoning" || message.type === "agent_reasoning") {
    const text = getReasoningTextFromMessage(message);
    const lastMessage = messages[messages.length - 1];
    const lastText = lastMessage
      ? getReasoningTextFromMessage(lastMessage)
      : null;

    if (
      text &&
      lastText &&
      normalizeReasoningText(text) === normalizeReasoningText(lastText)
    ) {
      return;
    }
  }

  messages.push(message);
}

function parseToolUseFromPayload(
  payload: Record<string, unknown>,
  timestamp: string | undefined,
  offset: number,
): PendingToolUse {
  const payloadType = typeof payload.type === "string" ? payload.type : "";

  let input: Record<string, unknown> = {};
  if (payloadType === "function_call") {
    input = toToolInput(payload.arguments);
  } else if (payloadType === "custom_tool_call") {
    input = toToolInput(payload.input);
  } else if (payloadType === "web_search_call") {
    input = toToolInput(payload.action);
  }

  const name =
    payloadType === "web_search_call"
      ? "web_search"
      : typeof payload.name === "string"
        ? payload.name
        : "unknown_tool";

  const callId =
    typeof payload.call_id === "string" && payload.call_id
      ? payload.call_id
      : `${name}-${offset}`;

  return {
    callId,
    name,
    input,
    timestamp,
    lineOffset: offset,
  };
}

function parseToolResultFromPayload(payload: Record<string, unknown>): {
  callId: string;
  content: unknown;
  isError?: boolean;
} {
  const callId =
    typeof payload.call_id === "string" && payload.call_id
      ? payload.call_id
      : `unknown-call-${Date.now()}`;

  const isError =
    typeof payload.is_error === "boolean"
      ? payload.is_error
      : typeof payload.error === "boolean"
        ? payload.error
        : undefined;

  return {
    callId,
    content: toToolOutputValue(payload.output),
    isError,
  };
}

function parseCodexConversation(
  lines: LineWithOffset[],
  knownToolNames?: Map<string, string>,
): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const pendingToolCalls = new Map<string, PendingToolUse>();
  const toolNames = knownToolNames ?? new Map<string, string>();

  for (const { line, offset } of lines) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") {
      continue;
    }

    const record = parsed as {
      type?: unknown;
      timestamp?: unknown;
      payload?: unknown;
    };
    const timestamp =
      typeof record.timestamp === "string" ? record.timestamp : undefined;

    if (!record.payload || typeof record.payload !== "object") {
      continue;
    }

    const payload = record.payload as Record<string, unknown>;
    const payloadType = typeof payload.type === "string" ? payload.type : "";

    if (record.type === "event_msg") {
      if (payloadType !== "agent_reasoning") {
        continue;
      }

      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) {
        continue;
      }

      pushConversationMessage(
        messages,
        createReasoningMessage(
          "agent_reasoning",
          text,
          `${offset}:agent-reasoning:${messages.length}`,
          timestamp,
        ),
      );
      continue;
    }

    if (record.type !== "response_item") {
      continue;
    }

    if (payloadType === "message") {
      const role = payload.role;
      if (role !== "user" && role !== "assistant") {
        continue;
      }

      const text = extractTextFromPayloadContent(payload.content);
      if (!text) {
        continue;
      }

      pushConversationMessage(
        messages,
        createTextMessage(
          role,
          text,
          `${offset}:message:${messages.length}`,
          timestamp,
        ),
      );
      continue;
    }

    if (payloadType === "reasoning") {
      let text = extractReasoningText(payload);
      if (!text) {
        const hasEncryptedContent =
          typeof payload.encrypted_content === "string" &&
          payload.encrypted_content.trim().length > 0;
        if (!hasEncryptedContent) {
          continue;
        }
        text = "Encrypted reasoning captured in the session log";
      }

      pushConversationMessage(
        messages,
        createReasoningMessage(
          "reasoning",
          text,
          `${offset}:reasoning:${messages.length}`,
          timestamp,
        ),
      );
      continue;
    }

    if (
      payloadType === "function_call" ||
      payloadType === "custom_tool_call" ||
      payloadType === "web_search_call"
    ) {
      const toolUse = parseToolUseFromPayload(payload, timestamp, offset);
      pendingToolCalls.set(toolUse.callId, toolUse);
      toolNames.set(toolUse.callId, toolUse.name);

      // Web search may not emit a separate output item, so include status if available.
      if (payloadType === "web_search_call" && payload.status !== undefined) {
        pushConversationMessage(
          messages,
          createToolMessage(toolUse, `${offset}:tool:${messages.length}`, {
            content: toToolOutputValue(payload.status),
          }),
        );
        pendingToolCalls.delete(toolUse.callId);
      }
      continue;
    }

    if (
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call_output"
    ) {
      const result = parseToolResultFromPayload(payload);
      const pairedToolUse = pendingToolCalls.get(result.callId);
      const toolName = pairedToolUse?.name ?? toolNames.get(result.callId);

      if (pairedToolUse) {
        pushConversationMessage(
          messages,
          createToolMessage(
            pairedToolUse,
            `${offset}:tool-pair:${messages.length}`,
            {
              content: result.content,
              isError: result.isError,
            },
          ),
        );
        pendingToolCalls.delete(result.callId);
      } else {
        pushConversationMessage(
          messages,
          createToolResultOnlyMessage(
            result.callId,
            result.content,
            `${offset}:tool-result:${messages.length}`,
            timestamp,
            result.isError,
            toolName,
          ),
        );
      }
      continue;
    }
  }

  for (const toolUse of pendingToolCalls.values()) {
    pushConversationMessage(
      messages,
      createToolMessage(
        toolUse,
        `${toolUse.lineOffset}:tool-pending:${messages.length}`,
      ),
    );
  }

  return messages;
}

async function getFirstUserMessageSnippet(filePath: string): Promise<string> {
  let fileHandle;
  try {
    fileHandle = await open(filePath, "r");
    const stream = fileHandle.createReadStream({ encoding: "utf-8" });
    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      const parsed = safeJsonParse(line);
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const record = parsed as {
        type?: unknown;
        payload?: unknown;
      };

      if (
        record.type !== "response_item" ||
        !record.payload ||
        typeof record.payload !== "object"
      ) {
        continue;
      }

      const payload = record.payload as Record<string, unknown>;
      if (payload.type !== "message" || payload.role !== "user") {
        continue;
      }

      const text = extractTextFromPayloadContent(payload.content);
      if (!text) {
        continue;
      }

      return normalizeDisplayText(text);
    }
  } catch {
    // Ignore read errors and fallback to default display value below.
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }

  return "(no prompt text)";
}

export async function loadStorage(): Promise<void> {
  await Promise.all([buildFileIndex(), loadHistoryCache()]);
}

export async function getSessions(): Promise<Session[]> {
  return dedupe("getSessions", async () => {
    const history = historyCache ?? (await loadHistoryCache());

    const sessionIds = new Set<string>([
      ...fileIndex.keys(),
      ...history.keys(),
      ...sessionMetaIndex.keys(),
    ]);

    const sessions: Session[] = [];

    for (const sessionId of sessionIds) {
      let filePath = fileIndex.get(sessionId);
      if (!filePath) {
        filePath = await findSessionFile(sessionId);
      }

      let meta = sessionMetaIndex.get(sessionId);
      if (!meta && filePath) {
        meta = await readSessionMetaFromFile(filePath);
        if (meta) {
          sessionMetaIndex.set(sessionId, meta);
        }
      }

      const historyEntry = history.get(sessionId);

      let timestamp = 0;
      if (historyEntry) {
        timestamp = historyEntry.timestamp * 1000;
      } else if (meta?.timestamp) {
        timestamp = meta.timestamp;
      } else if (filePath) {
        try {
          const fileStat = await stat(filePath);
          timestamp = fileStat.mtimeMs;
        } catch {
          timestamp = 0;
        }
      }

      let display = historyEntry ? normalizeDisplayText(historyEntry.text) : "";
      if (!display || display === "(no prompt text)") {
        const cachedDisplay = sessionDisplayCache.get(sessionId);
        if (cachedDisplay) {
          display = cachedDisplay;
        } else if (filePath) {
          display = await getFirstUserMessageSnippet(filePath);
          sessionDisplayCache.set(sessionId, display);
        } else {
          display = "(no prompt text)";
        }
      }

      const project = meta?.cwd ?? "";

      sessions.push({
        id: sessionId,
        display,
        timestamp,
        project,
        projectName: getProjectName(project),
      });
    }

    return sessions.sort((a, b) => b.timestamp - a.timestamp);
  });
}

export async function getProjects(): Promise<string[]> {
  const sessions = await getSessions();
  const projects = new Set<string>();

  for (const session of sessions) {
    if (session.project) {
      projects.add(session.project);
    }
  }

  return [...projects].sort();
}

export async function getConversation(
  sessionId: string,
): Promise<ConversationMessage[]> {
  return dedupe(`getConversation:${sessionId}`, async () => {
    const filePath = await findSessionFile(sessionId);

    if (!filePath) {
      return [];
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      let offset = 0;
      const parsedLines: LineWithOffset[] = [];

      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
        if (line.trim()) {
          parsedLines.push({ line, offset });
        }
        offset += lineBytes;
      }

      const toolNames = new Map<string, string>();
      const messages = parseCodexConversation(parsedLines, toolNames);
      sessionToolNameIndex.set(sessionId, toolNames);
      return messages;
    } catch (err) {
      console.error("Error reading conversation:", err);
      return [];
    }
  });
}

export async function getSessionContext(
  sessionId: string,
): Promise<CodexSessionContextResponse> {
  return dedupe(`getSessionContext:${sessionId}`, async () => {
    const filePath = await findSessionFile(sessionId);
    if (!filePath) {
      return {
        sessionId,
        contextLeftPercent: null,
        usedTokens: null,
        modelContextWindow: null,
      };
    }

    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n");

      let latestUsedTokens: number | null = null;
      let latestModelContextWindow: number | null = null;

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line || !line.trim()) {
          continue;
        }

        const parsed = safeJsonParse(line);
        if (!parsed || typeof parsed !== "object") {
          continue;
        }

        const record = parsed as { type?: unknown; payload?: unknown };
        if (
          record.type !== "event_msg" ||
          !record.payload ||
          typeof record.payload !== "object"
        ) {
          continue;
        }

        const payload = record.payload as Record<string, unknown>;
        const payloadType = typeof payload.type === "string" ? payload.type : "";

        if (payloadType === "token_count") {
          const info = payload.info;
          if (!info || typeof info !== "object") {
            continue;
          }

          const infoRecord = info as Record<string, unknown>;

          if (latestUsedTokens === null) {
            const lastTokenUsage = infoRecord.last_token_usage;
            if (lastTokenUsage && typeof lastTokenUsage === "object") {
              latestUsedTokens = parseFiniteNumber(
                (lastTokenUsage as Record<string, unknown>).total_tokens,
              );
            }
          }

          if (latestUsedTokens === null) {
            const totalTokenUsage = infoRecord.total_token_usage;
            if (totalTokenUsage && typeof totalTokenUsage === "object") {
              latestUsedTokens = parseFiniteNumber(
                (totalTokenUsage as Record<string, unknown>).total_tokens,
              );
            }
          }

          if (latestModelContextWindow === null) {
            latestModelContextWindow = parseFiniteNumber(
              infoRecord.model_context_window,
            );
          }

          if (latestUsedTokens !== null && latestModelContextWindow !== null) {
            break;
          }
          continue;
        }

        if (payloadType === "task_started" && latestModelContextWindow === null) {
          latestModelContextWindow = parseFiniteNumber(payload.model_context_window);
          if (latestUsedTokens !== null && latestModelContextWindow !== null) {
            break;
          }
        }
      }

      const contextLeftPercent =
        latestModelContextWindow !== null && latestUsedTokens !== null
          ? computeContextLeftPercent(latestUsedTokens, latestModelContextWindow)
          : latestModelContextWindow !== null
            ? 100
            : null;

      return {
        sessionId,
        contextLeftPercent,
        usedTokens:
          contextLeftPercent === null && latestUsedTokens !== null
            ? latestUsedTokens
            : null,
        modelContextWindow: latestModelContextWindow,
      };
    } catch {
      return {
        sessionId,
        contextLeftPercent: null,
        usedTokens: null,
        modelContextWindow: null,
      };
    }
  });
}

export async function getConversationStream(
  sessionId: string,
  fromOffset: number = 0,
): Promise<StreamResult> {
  const filePath = await findSessionFile(sessionId);

  if (!filePath) {
    return { messages: [], nextOffset: 0 };
  }

  let fileHandle;
  try {
    if (fromOffset > 0 && !sessionToolNameIndex.has(sessionId)) {
      await getConversation(sessionId);
    }

    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;

    if (fromOffset >= fileSize) {
      return { messages: [], nextOffset: fromOffset };
    }

    fileHandle = await open(filePath, "r");
    const stream = fileHandle.createReadStream({
      start: fromOffset,
      encoding: "utf-8",
    });

    const rl = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    const parsedLines: LineWithOffset[] = [];
    let bytesConsumed = 0;

    for await (const line of rl) {
      const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
      const lineOffset = fromOffset + bytesConsumed;

      if (line.trim()) {
        const parsed = safeJsonParse(line);
        if (parsed === null) {
          break;
        }

        parsedLines.push({
          line,
          offset: lineOffset,
        });
      }

      bytesConsumed += lineBytes;
    }

    const actualOffset = fromOffset + bytesConsumed;
    const nextOffset = actualOffset > fileSize ? fileSize : actualOffset;
    const toolNames =
      fromOffset === 0
        ? new Map<string, string>()
        : (sessionToolNameIndex.get(sessionId) ?? new Map<string, string>());
    const messages = parseCodexConversation(parsedLines, toolNames);
    sessionToolNameIndex.set(sessionId, toolNames);

    return {
      messages,
      nextOffset,
    };
  } catch (err) {
    console.error("Error reading conversation stream:", err);
    return { messages: [], nextOffset: fromOffset };
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}
