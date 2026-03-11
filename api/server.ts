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
  getConversation,
  getConversationStream,
  invalidateHistoryCache,
  addToFileIndex,
  type CodexThreadStateResponse,
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
import open from "open";
import {
  CodexAppServerRpcError,
  CodexAppServerTransportError,
  closeCodexAppServerClient,
  getCodexAppServerClient,
  isCodexReasoningEffort,
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
        _sessionId?: string,
        _filePath?: string,
      ) => {
        if (!isConnected) {
          return;
        }
        try {
          const sessions = await getSessions();
          const newOrUpdated = sessions.filter((s) => {
            const known = knownSessions.get(s.id);
            return known === undefined || known !== s.timestamp;
          });

          for (const s of sessions) {
            knownSessions.set(s.id, s.timestamp);
          }

          if (newOrUpdated.length > 0) {
            await stream.writeSSE({
              event: "sessionsUpdate",
              data: JSON.stringify(newOrUpdated),
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

      const result = await getCodexAppServerClient().sendMessage({
        threadId,
        text,
        ...(cwd ? { cwd } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
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
