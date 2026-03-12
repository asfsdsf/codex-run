import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import {
  initStorage,
  loadStorage,
  getCodexDir,
  getSessions,
  getProjects,
  getSessionContext,
  getConversation,
  getConversationStream,
  fixDanglingTurns,
  invalidateHistoryCache,
  addToFileIndex,
  type CodexThreadStateResponse,
  type CodexUserInputRequest,
  type CodexUserInputResponsePayload,
  type CreateCodexThreadRequest,
  type SendCodexMessageRequest,
  type SendCodexMessageResponse,
} from "./storage";
import {
  initWatcher,
  startWatcher,
  stopWatcher,
  onHistoryChange,
  offHistoryChange,
  onSessionChange,
  offSessionChange,
} from "./watcher";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { stat } from "fs/promises";
import open from "open";
import {
  CodexAppServerRpcError,
  CodexAppServerTransportError,
  closeCodexAppServerClient,
  getCodexAppServerClient,
  isCodexReasoningEffort,
  type CodexCollaborationModeInput,
  type CodexReasoningEffort,
} from "./codex-app-server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getWebDistPath(): string {
  const prodPath = join(__dirname, "web");
  if (existsSync(prodPath)) {
    return prodPath;
  }
  return join(__dirname, "..", "dist", "web");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

function parseOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function parseOptionalEffort(
  value: unknown,
): CodexReasoningEffort | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return isCodexReasoningEffort(value) ? value : undefined;
}

function parseOptionalCollaborationMode(
  value: unknown,
): CodexCollaborationModeInput | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const mode = typeof record.mode === "string" ? record.mode.trim() : "";
  if (!mode) {
    return undefined;
  }

  const settingsValue = record.settings;
  if (settingsValue === undefined || settingsValue === null) {
    return { mode };
  }

  if (
    typeof settingsValue !== "object" ||
    Array.isArray(settingsValue) ||
    !settingsValue
  ) {
    return undefined;
  }

  const settingsRecord = settingsValue as Record<string, unknown>;
  const model = parseOptionalString(settingsRecord.model);
  if (settingsRecord.model !== undefined && model === undefined) {
    return undefined;
  }

  const hasReasoningEffortCamel = Object.prototype.hasOwnProperty.call(
    settingsRecord,
    "reasoningEffort",
  );
  const hasReasoningEffortSnake = Object.prototype.hasOwnProperty.call(
    settingsRecord,
    "reasoning_effort",
  );
  const hasReasoningEffort =
    hasReasoningEffortCamel || hasReasoningEffortSnake;
  const reasoningEffortRaw = hasReasoningEffortCamel
    ? settingsRecord.reasoningEffort
    : hasReasoningEffortSnake
      ? settingsRecord.reasoning_effort
      : undefined;
  const reasoningEffort = parseOptionalEffort(reasoningEffortRaw);
  if (hasReasoningEffort && reasoningEffort === undefined) {
    return undefined;
  }

  const hasDeveloperInstructionsCamel = Object.prototype.hasOwnProperty.call(
    settingsRecord,
    "developerInstructions",
  );
  const hasDeveloperInstructionsSnake = Object.prototype.hasOwnProperty.call(
    settingsRecord,
    "developer_instructions",
  );
  const hasDeveloperInstructions =
    hasDeveloperInstructionsCamel || hasDeveloperInstructionsSnake;
  const developerInstructionsRaw = hasDeveloperInstructionsCamel
    ? settingsRecord.developerInstructions
    : hasDeveloperInstructionsSnake
      ? settingsRecord.developer_instructions
      : undefined;
  const developerInstructions = parseOptionalString(developerInstructionsRaw);
  if (hasDeveloperInstructions && developerInstructions === undefined) {
    return undefined;
  }

  return {
    mode,
    settings: {
      ...(settingsRecord.model !== undefined ? { model } : {}),
      ...(hasReasoningEffort ? { reasoningEffort } : {}),
      ...(hasDeveloperInstructions
        ? { developerInstructions }
        : {}),
    },
  };
}

function responseStatusForError(error: unknown): number {
  if (error instanceof CodexAppServerTransportError) {
    return 503;
  }
  if (error instanceof CodexAppServerRpcError) {
    return 500;
  }
  if (error instanceof SyntaxError) {
    return 400;
  }
  return 500;
}

function isThreadStateUnavailableError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRpcError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("thread not found") ||
    message.includes("thread not loaded") ||
    message.includes("unknown thread") ||
    message.includes("not materialized yet") ||
    message.includes("includeturns is unavailable before first user message") ||
    message.includes("no rollout found for thread id")
  );
}

export interface ServerOptions {
  port: number;
  codexDir?: string;
  dev?: boolean;
  open?: boolean;
}

export function createServer(options: ServerOptions) {
  const { port, codexDir, dev = false, open: shouldOpen = true } = options;

  initStorage(codexDir);
  initWatcher(getCodexDir());

  const app = new Hono();

  if (dev) {
    app.use(
      "*",
      cors({
        origin: ["http://localhost:12000"],
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type"],
      }),
    );
  }

  app.get("/api/sessions", async (c) => {
    const sessions = await getSessions();
    return c.json(sessions);
  });

  app.get("/api/projects", async (c) => {
    const projects = await getProjects();
    return c.json(projects);
  });

  app.get("/api/sessions/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      let isConnected = true;
      const knownSessions = new Map<string, number>();

      const cleanup = () => {
        isConnected = false;
        offHistoryChange(handleSessionsChange);
        offSessionChange(handleSessionsChange);
      };

      const handleSessionsChange = async (
        changedSessionId?: string,
        _filePath?: string,
      ) => {
        if (!isConnected) {
          return;
        }
        try {
          const sessions = await getSessions();
          const updateMap = new Map<string, (typeof sessions)[number]>();
          const newOrUpdated = sessions.filter((s) => {
            const known = knownSessions.get(s.id);
            return known === undefined || known !== s.timestamp;
          });
          for (const session of newOrUpdated) {
            updateMap.set(session.id, session);
          }

          if (changedSessionId) {
            const changedSession = sessions.find((s) => s.id === changedSessionId);
            if (changedSession) {
              updateMap.set(changedSession.id, changedSession);
            }
          }

          for (const s of sessions) {
            knownSessions.set(s.id, s.timestamp);
          }

          const updates = Array.from(updateMap.values());
          if (updates.length > 0) {
            await stream.writeSSE({
              event: "sessionsUpdate",
              data: JSON.stringify(updates),
            });
          }
        } catch {
          cleanup();
        }
      };

      onHistoryChange(handleSessionsChange);
      onSessionChange(handleSessionsChange);
      c.req.raw.signal.addEventListener("abort", cleanup);

      try {
        const sessions = await getSessions();
        for (const s of sessions) {
          knownSessions.set(s.id, s.timestamp);
        }

        await stream.writeSSE({
          event: "sessions",
          data: JSON.stringify(sessions),
        });

        while (isConnected) {
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ timestamp: Date.now() }),
          });
          await stream.sleep(30000);
        }
      } catch {
        // Connection closed
      } finally {
        cleanup();
      }
    });
  });

  app.get("/api/sessions/:id/context", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    try {
      const context = await getSessionContext(sessionId);
      return c.json(context);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/sessions/:id/fix-dangling", async (c) => {
    const sessionId = c.req.param("id")?.trim();
    if (!sessionId) {
      return c.json({ error: "session id is required" }, 400);
    }

    try {
      const result = await fixDanglingTurns(sessionId);
      return c.json(result);
    } catch (error) {
      const message = toErrorMessage(error);
      if (message.toLowerCase().includes("session file not found")) {
        return c.json({ error: message }, 404);
      }

      return c.json(
        {
          error: message,
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/conversation/:id", async (c) => {
    const sessionId = c.req.param("id");
    const messages = await getConversation(sessionId);
    return c.json(messages);
  });

  app.get("/api/conversation/:id/stream", async (c) => {
    const sessionId = c.req.param("id");
    const offsetParam = c.req.query("offset");
    const parsedOffset = offsetParam ? parseInt(offsetParam, 10) : 0;
    let offset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;

    return streamSSE(c, async (stream) => {
      let isConnected = true;

      const cleanup = () => {
        isConnected = false;
        offSessionChange(handleSessionChange);
      };

      const handleSessionChange = async (changedSessionId: string) => {
        if (changedSessionId !== sessionId || !isConnected) {
          return;
        }

        const { messages: newMessages, nextOffset: newOffset } =
          await getConversationStream(sessionId, offset);
        offset = newOffset;

        if (newMessages.length > 0) {
          try {
            await stream.writeSSE({
              event: "messages",
              data: JSON.stringify({
                messages: newMessages,
                nextOffset: newOffset,
              }),
            });
          } catch {
            cleanup();
          }
        }
      };

      onSessionChange(handleSessionChange);
      c.req.raw.signal.addEventListener("abort", cleanup);

      try {
        const { messages, nextOffset } = await getConversationStream(
          sessionId,
          offset,
        );
        offset = nextOffset;

        await stream.writeSSE({
          event: "messages",
          data: JSON.stringify({
            messages,
            nextOffset,
          }),
        });

        while (isConnected) {
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ timestamp: Date.now() }),
          });
          await stream.sleep(30000);
        }
      } catch {
        // Connection closed
      } finally {
        cleanup();
      }
    });
  });

  app.get("/api/codex/models", async (c) => {
    try {
      const models = await getCodexAppServerClient().listModels();
      return c.json({ models });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/collaboration-modes", async (c) => {
    try {
      const modes = await getCodexAppServerClient().listCollaborationModes();
      return c.json({ modes });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads", async (c) => {
    try {
      const body = (await c.req.json()) as Partial<CreateCodexThreadRequest>;
      const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
      if (!cwd) {
        return c.json(
          {
            error: "cwd is required",
          },
          400,
        );
      }

      try {
        const cwdStats = await stat(cwd);
        if (!cwdStats.isDirectory()) {
          return c.json(
            {
              error: `Project path is not a directory: ${cwd}`,
            },
            400,
          );
        }
      } catch (error) {
        const errorCode =
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : null;

        if (errorCode === "ENOENT") {
          return c.json(
            {
              error: `Project path does not exist: ${cwd}`,
            },
            400,
          );
        }

        throw error;
      }

      const model = parseOptionalString(body.model);
      if (body.model !== undefined && model === undefined) {
        return c.json({ error: "model must be a string or null" }, 400);
      }

      const effort = parseOptionalEffort(body.effort);
      if (body.effort !== undefined && effort === undefined) {
        return c.json({ error: "effort is invalid" }, 400);
      }

      const threadId = await getCodexAppServerClient().createThread({
        cwd,
        model,
        effort,
      });

      return c.json({ threadId });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads/:id/messages", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      const body = (await c.req.json()) as Partial<SendCodexMessageRequest>;
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) {
        return c.json({ error: "text is required" }, 400);
      }

      const cwd = parseOptionalString(body.cwd);
      if (body.cwd !== undefined && cwd === undefined) {
        return c.json({ error: "cwd must be a string" }, 400);
      }

      const model = parseOptionalString(body.model);
      if (body.model !== undefined && model === undefined) {
        return c.json({ error: "model must be a string or null" }, 400);
      }

      const effort = parseOptionalEffort(body.effort);
      if (body.effort !== undefined && effort === undefined) {
        return c.json({ error: "effort is invalid" }, 400);
      }

      const collaborationMode = parseOptionalCollaborationMode(
        body.collaborationMode,
      );
      if (
        body.collaborationMode !== undefined &&
        collaborationMode === undefined
      ) {
        return c.json(
          { error: "collaborationMode is invalid" },
          400,
        );
      }

      const result = await getCodexAppServerClient().sendMessage({
        threadId,
        text,
        ...(cwd ? { cwd } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(collaborationMode !== undefined ? { collaborationMode } : {}),
      });

      const response: SendCodexMessageResponse = {
        ok: true,
        turnId: result.turnId,
      };
      return c.json(response);
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/threads/:id/state", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    const requestedTurnIdRaw = c.req.query("turnId");
    const requestedTurnId =
      typeof requestedTurnIdRaw === "string" && requestedTurnIdRaw.trim()
        ? requestedTurnIdRaw.trim()
        : null;

    try {
      const state = await getCodexAppServerClient().getThreadState(
        threadId,
        requestedTurnId,
      );
      const response: CodexThreadStateResponse = {
        threadId: state.threadId,
        activeTurnId: state.activeTurnId,
        isGenerating: state.isGenerating,
        requestedTurnId: state.requestedTurnId,
        requestedTurnStatus: state.requestedTurnStatus,
      };
      return c.json(response);
    } catch (error) {
      if (isThreadStateUnavailableError(error)) {
        const response: CodexThreadStateResponse = {
          threadId,
          activeTurnId: null,
          isGenerating: false,
          requestedTurnId,
          requestedTurnStatus: null,
        };
        return c.json(response);
      }

      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads/:id/interrupt", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      await getCodexAppServerClient().interruptThread(threadId);
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.get("/api/codex/threads/:id/requests/user-input", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    try {
      const requests = getCodexAppServerClient().listPendingUserInputRequests(
        threadId,
      );
      return c.json({ requests: requests as CodexUserInputRequest[] });
    } catch (error) {
      return c.json(
        {
          error: toErrorMessage(error),
        },
        responseStatusForError(error),
      );
    }
  });

  app.post("/api/codex/threads/:id/requests/user-input/:requestId/respond", async (c) => {
    const threadId = c.req.param("id")?.trim();
    if (!threadId) {
      return c.json({ error: "thread id is required" }, 400);
    }

    const requestId = c.req.param("requestId")?.trim();
    if (!requestId) {
      return c.json({ error: "request id is required" }, 400);
    }

    try {
      const body = (await c.req.json()) as Partial<CodexUserInputResponsePayload>;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        !body.answers ||
        typeof body.answers !== "object" ||
        Array.isArray(body.answers)
      ) {
        return c.json({ error: "response.answers must be an object" }, 400);
      }

      const response: CodexUserInputResponsePayload = {
        answers: body.answers as CodexUserInputResponsePayload["answers"],
      };

      await getCodexAppServerClient().submitUserInput(
        threadId,
        requestId,
        response,
      );

      return c.json({ ok: true });
    } catch (error) {
      const message = toErrorMessage(error);
      const lowered = message.toLowerCase();
      if (lowered.includes("request not found")) {
        return c.json({ error: message }, 404);
      }
      if (lowered.includes("response.answers")) {
        return c.json({ error: message }, 400);
      }

      return c.json(
        {
          error: message,
        },
        responseStatusForError(error),
      );
    }
  });

  const webDistPath = getWebDistPath();

  app.use("/*", serveStatic({ root: webDistPath }));

  app.get("/*", async (c) => {
    const indexPath = join(webDistPath, "index.html");
    try {
      const html = readFileSync(indexPath, "utf-8");
      return c.html(html);
    } catch {
      return c.text("UI not found. Run 'pnpm build' first.", 404);
    }
  });

  onHistoryChange(() => {
    invalidateHistoryCache();
  });

  onSessionChange((sessionId: string, filePath: string) => {
    addToFileIndex(sessionId, filePath);
  });

  startWatcher();

  let httpServer: ServerType | null = null;

  return {
    app,
    port,
    start: async () => {
      await loadStorage();
      const openUrl = `http://localhost:${dev ? 12000 : port}/`;

      console.log(`\n  codex-run is running at ${openUrl}\n`);
      if (!dev && shouldOpen) {
        open(openUrl).catch(console.error);
      }

      httpServer = serve({
        fetch: app.fetch,
        port,
      });

      return httpServer;
    },
    stop: () => {
      stopWatcher();
      void closeCodexAppServerClient();
      if (httpServer) {
        httpServer.close();
      }
    },
  };
}
