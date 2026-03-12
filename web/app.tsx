import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  Session,
  CodexModelOption,
  CodexReasoningEffort,
} from "@codex-run/api";
import { PanelLeft, Copy, Check, GripVertical } from "lucide-react";
import { formatTime } from "./utils";
import SessionList from "./components/session-list";
import SessionView from "./components/session-view";
import { useEventSource } from "./hooks/use-event-source";
import {
  createCodexThread,
  getCodexThreadState,
  interruptCodexThread,
  listCodexModels,
  sendCodexMessage,
} from "./api";

interface SessionHeaderProps {
  session: Session;
  copied: boolean;
  onCopyResumeCommand: (sessionId: string, projectPath: string) => void;
}

const REASONING_EFFORTS: CodexReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const DEFAULT_OPTION_VALUE = "__default__";
const TURN_STATE_POLL_INTERVAL_MS = 1000;
const MESSAGE_BOX_MIN_HEIGHT = 42;
const MESSAGE_BOX_MAX_HEIGHT = 160;
const MESSAGE_BOX_DEFAULT_HEIGHT = 56;

interface PendingTurn {
  sessionId: string;
  turnId: string | null;
}

interface ResizeState {
  startY: number;
  startHeight: number;
}

function SessionHeader(props: SessionHeaderProps) {
  const { session, copied, onCopyResumeCommand } = props;

  return (
    <>
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="text-sm text-zinc-300 truncate max-w-xs">
          {session.display}
        </span>
        <span className="text-xs text-zinc-600 shrink-0">
          {session.projectName}
        </span>
        <span className="text-xs text-zinc-600 shrink-0">
          {formatTime(session.timestamp)}
        </span>
      </div>
      <button
        onClick={() => onCopyResumeCommand(session.id, session.project)}
        className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded transition-colors cursor-pointer shrink-0"
        title="Copy resume command to clipboard"
      >
        {copied ? (
          <>
            <Check className="w-3.5 h-3.5 text-green-500" />
            <span className="text-green-500">Copied!</span>
          </>
        ) : (
          <>
            <Copy className="w-3.5 h-3.5" />
            <span>Copy Resume Command</span>
          </>
        )}
      </button>
    </>
  );
}

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<CodexReasoningEffort | "">("");
  const [messageDraft, setMessageDraft] = useState("");
  const [newSessionCwd, setNewSessionCwd] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [messageBoxHeight, setMessageBoxHeight] = useState(
    MESSAGE_BOX_DEFAULT_HEIGHT,
  );
  const waitSuppressSessionsRef = useRef<Set<string>>(new Set());
  const resizeStateRef = useRef<ResizeState | null>(null);

  const handleResizeMessageBoxMove = useCallback((event: PointerEvent) => {
    const state = resizeStateRef.current;
    if (!state) {
      return;
    }

    event.preventDefault();
    const delta = state.startY - event.clientY;
    const nextHeight = Math.max(
      MESSAGE_BOX_MIN_HEIGHT,
      Math.min(MESSAGE_BOX_MAX_HEIGHT, state.startHeight + delta),
    );
    setMessageBoxHeight(nextHeight);
  }, []);

  const stopResizeMessageBox = useCallback(() => {
    resizeStateRef.current = null;
    window.removeEventListener("pointermove", handleResizeMessageBoxMove);
    window.removeEventListener("pointerup", stopResizeMessageBox);
    window.removeEventListener("pointercancel", stopResizeMessageBox);
  }, [handleResizeMessageBoxMove]);

  const handleResizeMessageBoxStart = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      resizeStateRef.current = {
        startY: event.clientY,
        startHeight: messageBoxHeight,
      };
      window.addEventListener("pointermove", handleResizeMessageBoxMove);
      window.addEventListener("pointerup", stopResizeMessageBox);
      window.addEventListener("pointercancel", stopResizeMessageBox);
    },
    [handleResizeMessageBoxMove, messageBoxHeight, stopResizeMessageBox],
  );

  useEffect(
    () => () => {
      stopResizeMessageBox();
    },
    [stopResizeMessageBox],
  );

  const handleCopyResumeCommand = useCallback(
    (sessionId: string, projectPath: string) => {
      const command = `cd ${projectPath} && codex resume ${sessionId}`;
      navigator.clipboard.writeText(command).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    },
    [],
  );

  const selectedSessionData = useMemo(() => {
    if (!selectedSession) {
      return null;
    }

    return sessions.find((s) => s.id === selectedSession) || null;
  }, [sessions, selectedSession]);

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json())
      .then(setProjects)
      .catch((error) => {
        console.error(error);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;

    listCodexModels()
      .then((data) => {
        if (cancelled) {
          return;
        }

        setModels(data);

        if (!selectedModelId) {
          const defaultModel =
            data.find((model) => model.isDefault && !model.hidden) ??
            data.find((model) => !model.hidden) ??
            null;

          if (defaultModel) {
            setSelectedModelId(defaultModel.id);
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setInteractionError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedProject) {
      setNewSessionCwd(selectedProject);
      return;
    }

    if (!newSessionCwd && projects.length === 1) {
      setNewSessionCwd(projects[0]);
    }
  }, [selectedProject, projects, newSessionCwd]);

  const handleSessionsFull = useCallback((event: MessageEvent) => {
    const data: Session[] = JSON.parse(event.data);
    setSessions(data);
    setLoading(false);
  }, []);

  const handleSessionsUpdate = useCallback((event: MessageEvent) => {
    const updates: Session[] = JSON.parse(event.data);
    setSessions((prev) => {
      const sessionMap = new Map(prev.map((s) => [s.id, s]));
      for (const update of updates) {
        sessionMap.set(update.id, update);
      }
      return Array.from(sessionMap.values()).sort(
        (a, b) => b.timestamp - a.timestamp,
      );
    });
  }, []);

  const handleSessionsError = useCallback(() => {
    setLoading(false);
  }, []);

  useEventSource("/api/sessions/stream", {
    events: [
      { eventName: "sessions", onMessage: handleSessionsFull },
      { eventName: "sessionsUpdate", onMessage: handleSessionsUpdate },
    ],
    onError: handleSessionsError,
  });

  const filteredSessions = useMemo(() => {
    if (!selectedProject) {
      return sessions;
    }
    return sessions.filter((s) => s.project === selectedProject);
  }, [sessions, selectedProject]);

  const filteredModels = useMemo(
    () => models.filter((model) => !model.hidden),
    [models],
  );

  const effortOptions = useMemo(() => {
    const selectedModel =
      filteredModels.find((model) => model.id === selectedModelId) ?? null;

    const effortSet = new Set<CodexReasoningEffort>();

    if (selectedModel && selectedModel.supportedReasoningEfforts.length > 0) {
      for (const effort of selectedModel.supportedReasoningEfforts) {
        effortSet.add(effort);
      }
    } else {
      for (const model of filteredModels) {
        for (const effort of model.supportedReasoningEfforts) {
          effortSet.add(effort);
        }
      }
    }

    if (selectedEffort) {
      effortSet.add(selectedEffort);
    }

    return REASONING_EFFORTS.filter((effort) => effortSet.has(effort));
  }, [filteredModels, selectedModelId, selectedEffort]);

  useEffect(() => {
    if (!selectedEffort) {
      return;
    }

    if (!effortOptions.includes(selectedEffort)) {
      setSelectedEffort("");
    }
  }, [effortOptions, selectedEffort]);

  const handleSelectSession = useCallback((sessionId: string) => {
    setSelectedSession(sessionId);
    setInteractionError(null);
  }, []);

  const handleCreateSession = useCallback(async () => {
    const cwd =
      newSessionCwd.trim() ||
      selectedProject ||
      selectedSessionData?.project ||
      "";

    if (!cwd) {
      setInteractionError("Set a project path before creating a new session.");
      return;
    }

    setCreatingSession(true);
    setInteractionError(null);

    try {
      const created = await createCodexThread({
        cwd,
        ...(selectedModelId ? { model: selectedModelId } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
      });

      setSelectedProject(cwd);
      setSelectedSession(created.threadId);
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingSession(false);
    }
  }, [
    newSessionCwd,
    selectedProject,
    selectedSessionData?.project,
    selectedModelId,
    selectedEffort,
  ]);

  const handleSendMessage = useCallback(async () => {
    if (
      !selectedSession ||
      sendingMessage ||
      pendingTurn?.sessionId === selectedSession
    ) {
      return;
    }

    const text = messageDraft.trim();
    if (!text) {
      return;
    }

    setSendingMessage(true);
    setInteractionError(null);
    waitSuppressSessionsRef.current.delete(selectedSession);

    try {
      const response = await sendCodexMessage(selectedSession, {
        text,
        ...(selectedSessionData?.project
          ? { cwd: selectedSessionData.project }
          : {}),
        ...(selectedModelId ? { model: selectedModelId } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
      });

      setMessageDraft("");
      setPendingTurn({
        sessionId: selectedSession,
        turnId: response.turnId,
      });
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingMessage(false);
    }
  }, [
    selectedSession,
    sendingMessage,
    messageDraft,
    pendingTurn?.sessionId,
    selectedSessionData?.project,
    selectedModelId,
    selectedEffort,
  ]);

  const handleStopConversation = useCallback(async () => {
    if (!selectedSession || pendingTurn?.sessionId !== selectedSession || stoppingTurn) {
      return;
    }

    const targetSessionId = selectedSession;
    waitSuppressSessionsRef.current.add(targetSessionId);
    // Always unlock UI immediately on manual stop, even if interrupt request is slow.
    setPendingTurn(null);
    setStoppingTurn(true);
    setInteractionError(null);

    void (async () => {
      try {
        await interruptCodexThread(targetSessionId);
      } catch (error) {
        setInteractionError(error instanceof Error ? error.message : String(error));
      } finally {
        setStoppingTurn(false);
      }
    })();
  }, [selectedSession, pendingTurn, stoppingTurn]);

  useEffect(() => {
    if (!pendingTurn) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const pollTurnState = async () => {
      if (cancelled || inFlight) {
        return;
      }

      inFlight = true;
      try {
        const state = await getCodexThreadState(
          pendingTurn.sessionId,
          pendingTurn.turnId,
        );
        if (cancelled) {
          return;
        }

        if (pendingTurn.turnId) {
          if (
            state.requestedTurnStatus === "completed" ||
            state.requestedTurnStatus === "failed" ||
            state.requestedTurnStatus === "interrupted"
          ) {
            setPendingTurn(null);
            return;
          }

          if (!state.isGenerating && state.requestedTurnStatus === null) {
            setPendingTurn(null);
          }
          return;
        }

        if (state.activeTurnId) {
          setPendingTurn((current) => {
            if (
              !current ||
              current.sessionId !== pendingTurn.sessionId ||
              current.turnId === state.activeTurnId
            ) {
              return current;
            }
            return {
              ...current,
              turnId: state.activeTurnId,
            };
          });
        }

        if (!state.isGenerating) {
          setPendingTurn(null);
        }
      } catch {
        // Keep waiting if state polling fails transiently.
      } finally {
        inFlight = false;
      }
    };

    void pollTurnState();
    const interval = setInterval(() => {
      void pollTurnState();
    }, TURN_STATE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pendingTurn]);

  useEffect(() => {
    if (!selectedSession || pendingTurn?.sessionId === selectedSession) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const pollSelectedThreadState = async () => {
      if (cancelled || inFlight) {
        return;
      }

      inFlight = true;
      try {
        if (waitSuppressSessionsRef.current.has(selectedSession)) {
          return;
        }

        const state = await getCodexThreadState(selectedSession);
        if (cancelled || !state.isGenerating) {
          return;
        }

        setPendingTurn((current) => {
          if (
            current &&
            current.sessionId === selectedSession &&
            current.turnId === state.activeTurnId
          ) {
            return current;
          }
          return {
            sessionId: selectedSession,
            turnId: state.activeTurnId ?? null,
          };
        });
      } catch {
        // Ignore transient polling errors.
      } finally {
        inFlight = false;
      }
    };

    void pollSelectedThreadState();
    const interval = setInterval(() => {
      void pollSelectedThreadState();
    }, TURN_STATE_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedSession, pendingTurn?.sessionId]);

  const isGeneratingForSelectedSession =
    !!selectedSession && pendingTurn?.sessionId === selectedSession;
  const isSendingLocked = isGeneratingForSelectedSession || sendingMessage;
  const newSessionPlaceholder =
    selectedProject || selectedSessionData?.project || "/path/to/project";

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100">
      {!sidebarCollapsed && (
        <aside className="w-80 border-r border-zinc-800/60 flex flex-col bg-zinc-950">
          <div className="border-b border-zinc-800/60 p-3 space-y-2">
            <label htmlFor={"select-project"} className="block w-full">
              <select
                id={"select-project"}
                value={selectedProject || ""}
                onChange={(e) => setSelectedProject(e.target.value || null)}
                className="w-full h-10 bg-zinc-900/70 text-zinc-300 text-sm rounded border border-zinc-800 px-3 focus:outline-none"
              >
                <option value="">All Projects</option>
                {projects.map((project) => {
                  const name = project.split("/").pop() || project;
                  return (
                    <option key={project} value={project}>
                      {name}
                    </option>
                  );
                })}
              </select>
            </label>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newSessionCwd}
                onChange={(event) => setNewSessionCwd(event.target.value)}
                placeholder={newSessionPlaceholder}
                className="flex-1 h-9 bg-zinc-900/70 text-zinc-200 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
              />
              <button
                onClick={() => {
                  void handleCreateSession();
                }}
                disabled={creatingSession}
                className="h-9 px-3 text-xs rounded bg-cyan-700/80 hover:bg-cyan-700 text-zinc-50 disabled:opacity-50 cursor-pointer"
                title="Start a new Codex session"
              >
                {creatingSession ? "Creating..." : "New Session"}
              </button>
            </div>
          </div>

          <SessionList
            sessions={filteredSessions}
            selectedSession={selectedSession}
            onSelectSession={handleSelectSession}
            loading={loading}
          />
        </aside>
      )}

      <main className="flex-1 overflow-hidden bg-zinc-950 flex flex-col">
        <div className="h-[50px] border-b border-zinc-800/60 flex items-center px-4 gap-4">
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="p-1.5 hover:bg-zinc-800 rounded transition-colors cursor-pointer"
            aria-label={
              sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
            }
          >
            <PanelLeft className="w-4 h-4 text-zinc-400" />
          </button>
          {selectedSessionData && (
            <SessionHeader
              session={selectedSessionData}
              copied={copied}
              onCopyResumeCommand={handleCopyResumeCommand}
            />
          )}
        </div>

        {interactionError && (
          <div className="px-4 py-2 text-xs text-red-300 bg-red-950/40 border-b border-red-900/50">
            {interactionError}
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {selectedSession ? (
            <div className="h-full flex flex-col">
              <div className="flex-1 overflow-hidden">
                <SessionView sessionId={selectedSession} />
              </div>

              <div className="border-t border-zinc-800/60 bg-zinc-950 p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={selectedModelId || DEFAULT_OPTION_VALUE}
                    onChange={(event) => {
                      const value = event.target.value;
                      setSelectedModelId(
                        value === DEFAULT_OPTION_VALUE ? "" : value,
                      );
                    }}
                    className="h-9 min-w-[160px] bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
                  >
                    <option value={DEFAULT_OPTION_VALUE}>Model: default</option>
                    {filteredModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>

                  <select
                    value={selectedEffort || DEFAULT_OPTION_VALUE}
                    onChange={(event) => {
                      const value = event.target.value;
                      setSelectedEffort(
                        value === DEFAULT_OPTION_VALUE
                          ? ""
                          : (value as CodexReasoningEffort),
                      );
                    }}
                    className="h-9 min-w-[140px] bg-zinc-900/70 text-zinc-300 text-xs rounded border border-zinc-800 px-2.5 focus:outline-none"
                  >
                    <option value={DEFAULT_OPTION_VALUE}>Effort: default</option>
                    {effortOptions.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-end gap-2">
                  <div className="relative flex-1">
                    {isGeneratingForSelectedSession && !messageDraft.trim() && (
                      <div className="pointer-events-none absolute inset-0 flex items-start gap-2 px-3 py-2 text-sm text-zinc-300">
                        <span className="thinking-dot mt-[0.35rem]" />
                        <span className="thinking-label">Working...</span>
                      </div>
                    )}
                    <textarea
                      value={messageDraft}
                      onChange={(event) => setMessageDraft(event.target.value)}
                      disabled={isSendingLocked}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing &&
                          !isGeneratingForSelectedSession
                        ) {
                          event.preventDefault();
                          void handleSendMessage();
                        }
                      }}
                      placeholder={
                        isGeneratingForSelectedSession ? "" : "Message Codex..."
                      }
                      rows={2}
                      style={{ height: `${messageBoxHeight}px` }}
                      className="w-full min-h-[42px] max-h-40 resize-none bg-zinc-900/70 text-sm text-zinc-200 rounded border border-zinc-800 px-3 py-2 pr-8 focus:outline-none"
                    />
                    <button
                      type="button"
                      onPointerDown={handleResizeMessageBoxStart}
                      disabled={isSendingLocked}
                      aria-label="Resize message box"
                      title="Drag up or down to resize"
                      className="absolute top-1 right-1 z-10 flex h-5 w-5 items-center justify-center rounded bg-zinc-900/90 border border-zinc-700/90 text-zinc-300 shadow-sm transition-colors cursor-ns-resize hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <GripVertical className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      if (isGeneratingForSelectedSession) {
                        void handleStopConversation();
                        return;
                      }
                      void handleSendMessage();
                    }}
                    disabled={
                      isGeneratingForSelectedSession
                        ? stoppingTurn
                        : sendingMessage || isSendingLocked || !messageDraft.trim()
                    }
                    className={`h-10 px-4 text-sm rounded text-zinc-50 disabled:opacity-50 cursor-pointer ${
                      isGeneratingForSelectedSession
                        ? "bg-red-700/90 hover:bg-red-700"
                        : "bg-cyan-700/80 hover:bg-cyan-700"
                    }`}
                  >
                    {isGeneratingForSelectedSession
                      ? stoppingTurn
                        ? "Stopping..."
                        : "Stop"
                      : sendingMessage
                        ? "Sending..."
                        : "Send"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-600">
              <div className="text-center">
                <div className="text-base mb-2 text-zinc-500">
                  Select a session
                </div>
                <div className="text-sm text-zinc-600">
                  Choose a session from the list to view the conversation
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
