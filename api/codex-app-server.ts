import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_LIMIT = 200;

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

export interface CreateCodexThreadInput {
  cwd: string;
  model?: string | null;
  effort?: CodexReasoningEffort | null;
}

export interface SendCodexMessageInput {
  threadId: string;
  text: string;
  cwd?: string;
  model?: string | null;
  effort?: CodexReasoningEffort | null;
}

export interface SendCodexMessageResult {
  turnId: string | null;
}

export type CodexTurnStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "interrupted";

export interface CodexThreadState {
  threadId: string;
  activeTurnId: string | null;
  isGenerating: boolean;
  requestedTurnId: string | null;
  requestedTurnStatus: CodexTurnStatus | null;
}

interface AppServerTurnRecord {
  id?: unknown;
  status?: unknown;
}

export class CodexAppServerRpcError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CodexAppServerRpcError";
    this.code = code;
    this.data = data;
  }
}

export class CodexAppServerTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodexAppServerTransportError";
  }
}

interface PendingRequest {
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface CodexAppServerClientOptions {
  executablePath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  userAgent?: string;
}

class CodexAppServerClient {
  private readonly executablePath: string;
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly requestTimeoutMs: number;
  private readonly userAgent: string;

  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: ReadlineInterface | null = null;
  private stderrReader: ReadlineInterface | null = null;
  private initialized = false;
  private initializeInFlight: Promise<void> | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();

  public constructor(options: CodexAppServerClientOptions = {}) {
    this.executablePath =
      options.executablePath?.trim() || resolveCodexExecutablePath();
    this.cwd = options.cwd;
    this.env = options.env;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? "codex-run/0.2.4";
  }

  public async listModels(limit = DEFAULT_MODEL_LIMIT): Promise<CodexModelOption[]> {
    const result = await this.request("model/list", { limit });
    if (!result || typeof result !== "object") {
      throw new CodexAppServerTransportError(
        "Invalid model/list response from codex app-server",
      );
    }

    const data = (result as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new CodexAppServerTransportError(
        "Missing model data in codex app-server response",
      );
    }

    const models: CodexModelOption[] = [];

    for (const entry of data) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const record = entry as Record<string, unknown>;
      const fallbackModelName = asString(record.model)?.trim();
      const id = asString(record.id)?.trim() || fallbackModelName;
      if (!id) {
        continue;
      }

      const supported = collectSupportedReasoningEfforts(
        record.supportedReasoningEfforts,
      );

      models.push({
        id,
        displayName: asString(record.displayName)?.trim() || id,
        description: asString(record.description)?.trim() || "",
        isDefault: record.isDefault === true,
        hidden: record.hidden === true,
        defaultReasoningEffort: toReasoningEffort(
          record.defaultReasoningEffort,
        ),
        supportedReasoningEfforts: supported,
      });
    }

    return models;
  }

  public async createThread(input: CreateCodexThreadInput): Promise<string> {
    const cwd = input.cwd.trim();
    if (!cwd) {
      throw new Error("cwd is required");
    }

    const params: Record<string, unknown> = {
      cwd,
      ephemeral: false,
    };

    if (typeof input.model === "string" && input.model.trim()) {
      params.model = input.model.trim();
    }

    // thread/start does not support direct effort override; use config as best effort.
    if (input.effort) {
      params.config = {
        model_reasoning_effort: input.effort,
      };
    }

    const result = await this.request("thread/start", params);
    if (!result || typeof result !== "object") {
      throw new CodexAppServerTransportError(
        "Invalid thread/start response from codex app-server",
      );
    }

    const thread = (result as { thread?: unknown }).thread;
    if (!thread || typeof thread !== "object") {
      throw new CodexAppServerTransportError(
        "Missing thread payload in thread/start response",
      );
    }

    const threadId = asString((thread as Record<string, unknown>).id)?.trim();
    if (!threadId) {
      throw new CodexAppServerTransportError(
        "Missing thread id in thread/start response",
      );
    }

    return threadId;
  }

  public async sendMessage(
    input: SendCodexMessageInput,
  ): Promise<SendCodexMessageResult> {
    const threadId = input.threadId.trim();
    if (!threadId) {
      throw new Error("threadId is required");
    }

    const text = input.text.trim();
    if (!text) {
      throw new Error("text is required");
    }

    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text }],
      attachments: [],
    };

    if (typeof input.cwd === "string" && input.cwd.trim()) {
      params.cwd = input.cwd.trim();
    }

    if (typeof input.model === "string" && input.model.trim()) {
      params.model = input.model.trim();
    }

    if (input.effort) {
      params.effort = input.effort;
    }

    try {
      const result = await this.request("turn/start", params);
      return {
        turnId: extractTurnIdFromTurnStartResult(result),
      };
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(threadId);
      const result = await this.request("turn/start", params);
      return {
        turnId: extractTurnIdFromTurnStartResult(result),
      };
    }
  }

  public async interruptThread(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    const threadState = await this.getThreadState(normalizedThreadId);
    const activeTurnId = threadState.activeTurnId;
    if (!activeTurnId) {
      return;
    }

    try {
      await this.request("turn/interrupt", {
        threadId: normalizedThreadId,
        turnId: activeTurnId,
      });
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(normalizedThreadId);
      const refreshedThreadState = await this.getThreadState(normalizedThreadId);
      if (!refreshedThreadState.activeTurnId) {
        return;
      }

      await this.request("turn/interrupt", {
        threadId: normalizedThreadId,
        turnId: refreshedThreadState.activeTurnId,
      });
    }
  }

  public async getThreadState(
    threadId: string,
    requestedTurnId?: string | null,
  ): Promise<CodexThreadState> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("threadId is required");
    }

    const normalizedRequestedTurnId =
      typeof requestedTurnId === "string" && requestedTurnId.trim()
        ? requestedTurnId.trim()
        : null;

    const result = await this.readThreadWithTurns(normalizedThreadId);

    const turns = extractTurnsFromThreadReadResult(result);
    let activeTurnId: string | null = null;
    let requestedTurnStatus: CodexTurnStatus | null = null;

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!turn || typeof turn !== "object") {
        continue;
      }

      const turnId = asString(turn.id)?.trim() ?? "";
      const turnStatus = toTurnStatus(turn.status);

      if (
        normalizedRequestedTurnId &&
        turnId === normalizedRequestedTurnId &&
        turnStatus
      ) {
        requestedTurnStatus = turnStatus;
      }

      if (!activeTurnId && turnStatus === "inProgress" && turnId) {
        activeTurnId = turnId;
      }
    }

    return {
      threadId: normalizedThreadId,
      activeTurnId,
      isGenerating: activeTurnId !== null,
      requestedTurnId: normalizedRequestedTurnId,
      requestedTurnStatus,
    };
  }

  private async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", {
      threadId,
      persistExtendedHistory: true,
    });
  }

  private async readThreadWithTurns(threadId: string): Promise<unknown> {
    const requestPayload = {
      threadId,
      includeTurns: true,
    };

    try {
      return await this.request("thread/read", requestPayload);
    } catch (error) {
      if (!shouldRetryAfterResume(error)) {
        throw error;
      }

      await this.resumeThread(threadId);
      return await this.request("thread/read", requestPayload);
    }
  }

  public async close(): Promise<void> {
    this.rejectAll(new CodexAppServerTransportError("app-server closed"));

    this.stdoutReader?.close();
    this.stdoutReader = null;

    this.stderrReader?.close();
    this.stderrReader = null;

    if (this.process) {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Ignore process kill errors during shutdown.
      }
    }

    this.process = null;
    this.initialized = false;
    this.initializeInFlight = null;
  }

  private ensureStarted(): void {
    if (this.process) {
      return;
    }

    const child = spawn(this.executablePath, ["app-server"], {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
        CODEX_USER_AGENT: this.userAgent,
        CODEX_CLIENT_ID: `codex-run-${randomUUID()}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.on("exit", (code, signal) => {
      this.handleProcessExit(
        `app-server exited (code=${String(code)}, signal=${String(signal)})`,
      );
    });

    child.on("error", (error) => {
      this.handleProcessExit(`app-server process error: ${error.message}`);
    });

    this.stdoutReader = createInterface({ input: child.stdout });
    this.stdoutReader.on("line", (line) => {
      this.handleStdoutLine(line);
    });

    this.stderrReader = createInterface({ input: child.stderr });
    this.stderrReader.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        return;
      }
      console.error(`[codex app-server] ${text}`);
    });

    this.process = child;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializeInFlight) {
      return this.initializeInFlight;
    }

    this.initializeInFlight = (async () => {
      const result = await this.requestRaw(
        "initialize",
        {
          clientInfo: {
            name: "codex-run",
            version: "0.2.4",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
        this.requestTimeoutMs,
      );

      if (!result || typeof result !== "object") {
        throw new CodexAppServerTransportError(
          "Invalid initialize response from codex app-server",
        );
      }

      this.initialized = true;
    })().finally(() => {
      this.initializeInFlight = null;
    });

    return this.initializeInFlight;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    this.ensureStarted();

    if (method !== "initialize") {
      await this.ensureInitialized();
    }

    return this.requestRaw(method, params, this.requestTimeoutMs);
  }

  private async requestRaw(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const processHandle = this.process;
    if (!processHandle) {
      throw new CodexAppServerTransportError("app-server failed to start");
    }

    const id = ++this.requestId;

    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexAppServerTransportError(
            `app-server request timed out: ${method}`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      processHandle.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) {
          return;
        }

        const pendingRequest = this.pending.get(id);
        if (!pendingRequest) {
          return;
        }

        clearTimeout(pendingRequest.timer);
        this.pending.delete(id);
        pendingRequest.reject(
          new CodexAppServerTransportError(
            `Failed to write app-server request: ${error.message}`,
          ),
        );
      });
    });
  }

  private handleStdoutLine(line: string): void {
    const text = line.trim();
    if (!text) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const message = parsed as Record<string, unknown>;
    const idValue = message.id;
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");

    if ((hasResult || hasError) && typeof idValue === "number") {
      this.resolvePendingRequest(idValue, message);
      return;
    }

    if (
      typeof idValue === "number" &&
      typeof message.method === "string" &&
      Object.prototype.hasOwnProperty.call(message, "params")
    ) {
      void this.respondMethodNotFound(idValue, message.method);
    }
  }

  private resolvePendingRequest(
    requestId: number,
    message: Record<string, unknown>,
  ): void {
    const pendingRequest = this.pending.get(requestId);
    if (!pendingRequest) {
      return;
    }

    this.pending.delete(requestId);
    clearTimeout(pendingRequest.timer);

    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      const errorValue = message.error;
      if (errorValue && typeof errorValue === "object") {
        const errorObj = errorValue as Record<string, unknown>;
        const code =
          typeof errorObj.code === "number" ? errorObj.code : -32000;
        const errorMessage =
          asString(errorObj.message)?.trim() || "Unknown app-server error";

        pendingRequest.reject(
          new CodexAppServerRpcError(code, errorMessage, errorObj.data),
        );
        return;
      }

      pendingRequest.reject(
        new CodexAppServerRpcError(
          -32000,
          "Unknown app-server error (malformed error payload)",
        ),
      );
      return;
    }

    pendingRequest.resolve(message.result);
  }

  private async respondMethodNotFound(
    requestId: number,
    method: string,
  ): Promise<void> {
    const processHandle = this.process;
    if (!processHandle) {
      return;
    }

    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32601,
        message: `Method not handled by codex-run client: ${method}`,
      },
    };

    await new Promise<void>((resolve) => {
      processHandle.stdin.write(`${JSON.stringify(payload)}\n`, () => {
        resolve();
      });
    });
  }

  private handleProcessExit(reason: string): void {
    this.stdoutReader?.close();
    this.stdoutReader = null;

    this.stderrReader?.close();
    this.stderrReader = null;

    this.process = null;
    this.initialized = false;
    this.initializeInFlight = null;

    this.rejectAll(new CodexAppServerTransportError(reason));
  }

  private rejectAll(error: Error): void {
    for (const pendingRequest of this.pending.values()) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(error);
    }
    this.pending.clear();
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toReasoningEffort(value: unknown): CodexReasoningEffort | null {
  if (
    value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  ) {
    return value;
  }
  return null;
}

function collectSupportedReasoningEfforts(value: unknown): CodexReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const efforts = new Set<CodexReasoningEffort>();

  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const effort = toReasoningEffort(
      (entry as Record<string, unknown>).reasoningEffort,
    );

    if (effort) {
      efforts.add(effort);
    }
  }

  return [...efforts];
}

function extractTurnsFromThreadReadResult(result: unknown): AppServerTurnRecord[] {
  if (!result || typeof result !== "object") {
    return [];
  }

  const threadValue = (result as { thread?: unknown }).thread;
  if (!threadValue || typeof threadValue !== "object") {
    return [];
  }

  const turnsValue = (threadValue as { turns?: unknown }).turns;
  if (!Array.isArray(turnsValue) || turnsValue.length === 0) {
    return [];
  }

  return turnsValue as AppServerTurnRecord[];
}

function extractTurnIdFromTurnStartResult(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const turnValue = (result as { turn?: unknown }).turn;
  if (!turnValue || typeof turnValue !== "object") {
    return null;
  }

  const turnId = asString((turnValue as { id?: unknown }).id)?.trim();
  return turnId || null;
}

function toTurnStatus(value: unknown): CodexTurnStatus | null {
  if (
    value === "inProgress" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
  ) {
    return value;
  }
  return null;
}

function shouldRetryAfterResume(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("thread not found") ||
    message.includes("thread not loaded") ||
    message.includes("not loaded")
  );
}

function resolveCodexExecutablePath(): string {
  const envPath = process.env["CODEX_CLI_PATH"]?.trim();
  if (envPath) {
    return envPath;
  }

  const desktopPath = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(desktopPath)) {
    return desktopPath;
  }

  return "codex";
}

let client: CodexAppServerClient | null = null;

export function getCodexAppServerClient(): {
  listModels: (limit?: number) => Promise<CodexModelOption[]>;
  createThread: (input: CreateCodexThreadInput) => Promise<string>;
  sendMessage: (input: SendCodexMessageInput) => Promise<SendCodexMessageResult>;
  getThreadState: (
    threadId: string,
    requestedTurnId?: string | null,
  ) => Promise<CodexThreadState>;
  interruptThread: (threadId: string) => Promise<void>;
} {
  if (!client) {
    client = new CodexAppServerClient();
  }

  return {
    listModels: (limit?: number) => client!.listModels(limit),
    createThread: (input: CreateCodexThreadInput) => client!.createThread(input),
    sendMessage: (input: SendCodexMessageInput) => client!.sendMessage(input),
    getThreadState: (threadId: string, requestedTurnId?: string | null) =>
      client!.getThreadState(threadId, requestedTurnId),
    interruptThread: (threadId: string) => client!.interruptThread(threadId),
  };
}

export async function closeCodexAppServerClient(): Promise<void> {
  if (!client) {
    return;
  }

  const current = client;
  client = null;
  await current.close();
}

export function isCodexReasoningEffort(
  value: unknown,
): value is CodexReasoningEffort {
  return toReasoningEffort(value) !== null;
}
