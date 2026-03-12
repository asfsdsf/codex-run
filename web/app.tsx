import {
  memo,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  ConversationMessage,
  Session,
  CodexCollaborationModeOption,
  CodexModelOption,
  CodexReasoningEffort,
} from "@codex-run/api";
import {
  PanelLeft,
  Copy,
  Check,
  GripVertical,
  Circle,
  CircleDot,
} from "lucide-react";
import { formatTime } from "./utils";
import SessionList from "./components/session-list";
import SessionView from "./components/session-view";
import { useEventSource } from "./hooks/use-event-source";
import {
  createCodexThread,
  fixDanglingSession,
  getSessionContext,
  getCodexThreadState,
  interruptCodexThread,
  listCodexCollaborationModes,
  listCodexModels,
  sendCodexMessage,
  getConversation,
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
const FIX_DANGLING_WAIT_THRESHOLD_MS = 8_000;
const MESSAGE_BOX_MIN_HEIGHT = 42;
const MESSAGE_BOX_MAX_HEIGHT = 160;
const MESSAGE_BOX_DEFAULT_HEIGHT = 56;
const PLAN_IMPLEMENTATION_MESSAGE = "Implement the plan.";
const SESSION_MODE_STORAGE_KEY = "codex-run:session-plan-mode:v1";
const MESSAGE_HISTORY_STORAGE_KEY = "codex-run:message-history:v1";
const TOKEN_COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

type CollaborationModeKey = "default" | "plan";

interface PendingTurn {
  sessionId: string;
  turnId: string | null;
}

interface ResizeState {
  startY: number;
  startHeight: number;
}

interface HistoryNavigationState {
  index: number | null;
  draftBeforeNavigation: string;
}

interface MessageComposerProps {
  sessionId: string;
  history: string[];
  isGeneratingForSelectedSession: boolean;
  showFixDangling: boolean;
  fixingDangling: boolean;
  isSendingLocked: boolean;
  sendingMessage: boolean;
  stoppingTurn: boolean;
  messageBoxHeight: number;
  onResizeMessageBoxStart: (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onSendMessage: (text: string) => Promise<boolean>;
  onStopConversation: () => Promise<void>;
  onFixDangling: () => void;
}

function extractMessageText(message: ConversationMessage): string {
  const content = message.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const textParts = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0);
  return textParts.join("\n").trim();
}

function extractUserInputHistory(messages: ConversationMessage[]): string[] {
  const userMessages = messages.filter((message) => message.type === "user");
  if (userMessages.length === 0) {
    return [];
  }

  // AGENTS.md bootstrap content is the first session message when it is
  // immediately followed by another user message.
  const firstMessage = messages[0];
  const secondMessage = messages[1];
  const skipFirstUserMessage =
    firstMessage?.type === "user" && secondMessage?.type === "user";

  const source = skipFirstUserMessage
    ? userMessages.filter((message) => message !== firstMessage)
    : userMessages;

  return source.map(extractMessageText).filter((text) => text.length > 0);
}

function loadMessageHistoryMap(): Record<string, string[]> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(MESSAGE_HISTORY_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const result: Record<string, string[]> = {};
    for (const [sessionId, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) {
        continue;
      }

      const normalized = entries
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      result[sessionId] = normalized;
    }
    return result;
  } catch {
    return {};
  }
}

function persistMessageHistoryMap(value: Record<string, string[]>): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      MESSAGE_HISTORY_STORAGE_KEY,
      JSON.stringify(value),
    );
  } catch {
    // Ignore storage write errors (private mode, quota, etc.)
  }
}

function loadSessionModeMap(): Record<string, CollaborationModeKey> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.sessionStorage.getItem(SESSION_MODE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const result: Record<string, CollaborationModeKey> = {};
    for (const [sessionId, modeValue] of Object.entries(parsed)) {
      if (modeValue === "default" || modeValue === "plan") {
        result[sessionId] = modeValue;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function persistSessionModeMap(
  value: Record<string, CollaborationModeKey>,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      SESSION_MODE_STORAGE_KEY,
      JSON.stringify(value),
    );
  } catch {
    // Ignore storage write errors (private mode, quota, etc.)
  }
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

const MessageComposer = memo(function MessageComposer(
  props: MessageComposerProps,
) {
  const {
    sessionId,
    history,
    isGeneratingForSelectedSession,
    showFixDangling,
    fixingDangling,
    isSendingLocked,
    sendingMessage,
    stoppingTurn,
    messageBoxHeight,
    onResizeMessageBoxStart,
    onSendMessage,
    onStopConversation,
    onFixDangling,
  } = props;
  const [draft, setDraft] = useState("");
  const [historyNavigation, setHistoryNavigation] =
    useState<HistoryNavigationState>({
      index: null,
      draftBeforeNavigation: "",
    });

  useEffect(() => {
    setDraft("");
    setHistoryNavigation({
      index: null,
      draftBeforeNavigation: "",
    });
  }, [sessionId]);

  const navigateInputHistory = useCallback(
    (direction: "up" | "down") => {
      if (history.length === 0) {
        return;
      }

      if (direction === "up") {
        if (historyNavigation.index === null) {
          setHistoryNavigation({
            index: history.length - 1,
            draftBeforeNavigation: draft,
          });
          setDraft(history[history.length - 1]);
          return;
        }

        if (historyNavigation.index > 0) {
          const nextIndex = historyNavigation.index - 1;
          setHistoryNavigation((current) => ({
            ...current,
            index: nextIndex,
          }));
          setDraft(history[nextIndex]);
        }
        return;
      }

      if (historyNavigation.index === null) {
        return;
      }

      if (historyNavigation.index < history.length - 1) {
        const nextIndex = historyNavigation.index + 1;
        setHistoryNavigation((current) => ({
          ...current,
          index: nextIndex,
        }));
        setDraft(history[nextIndex]);
        return;
      }

      setHistoryNavigation({
        index: null,
        draftBeforeNavigation: "",
      });
      setDraft(historyNavigation.draftBeforeNavigation);
    },
    [draft, history, historyNavigation],
  );

  const handleSendMessage = useCallback(async () => {
    const sent = await onSendMessage(draft);
    if (!sent) {
      return;
    }

    setDraft("");
    setHistoryNavigation({
      index: null,
      draftBeforeNavigation: "",
    });
  }, [draft, onSendMessage]);

  return (
    <div className="flex items-end gap-2">
      <div className="relative flex-1">
        {isGeneratingForSelectedSession && (
          <div className="pointer-events-none absolute inset-0 flex items-start gap-2 px-3 py-2 text-sm text-zinc-300">
            <span className="thinking-dot mt-[0.35rem]" />
            <span className="thinking-label">Working...</span>
            {showFixDangling && (
                <button
                  type="button"
                  onClick={() => {
                    onFixDangling();
                  }}
                disabled={fixingDangling}
                className="pointer-events-auto rounded border border-amber-600/60 bg-amber-700/20 px-2 py-0.5 text-[11px] text-amber-200 transition-colors hover:bg-amber-700/30 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {fixingDangling ? "Fixing..." : "Fix dangling"}
              </button>
            )}
          </div>
        )}
        <textarea
          value={isGeneratingForSelectedSession ? "" : draft}
          onChange={(event) => {
            if (historyNavigation.index !== null) {
              setHistoryNavigation({
                index: null,
                draftBeforeNavigation: "",
              });
            }
            setDraft(event.target.value);
          }}
          disabled={isSendingLocked}
          onKeyDown={(event) => {
            const selectionStart = event.currentTarget.selectionStart;
            const selectionEnd = event.currentTarget.selectionEnd;
            const hasSelection = selectionStart !== selectionEnd;

            if (event.key === "ArrowUp" && !hasSelection) {
              const isOnFirstLine = !event.currentTarget.value
                .slice(0, selectionStart)
                .includes("\n");
              if (isOnFirstLine) {
                event.preventDefault();
                navigateInputHistory("up");
                return;
              }
            }

            if (event.key === "ArrowDown" && !hasSelection) {
              const isOnLastLine = !event.currentTarget.value
                .slice(selectionStart)
                .includes("\n");
              if (isOnLastLine) {
                event.preventDefault();
                navigateInputHistory("down");
                return;
              }
            }

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
          placeholder={isGeneratingForSelectedSession ? "" : "Message Codex..."}
          rows={2}
          style={{ height: `${messageBoxHeight}px` }}
          className="w-full min-h-[42px] max-h-40 resize-none bg-zinc-900/70 text-sm text-zinc-200 rounded border border-zinc-800 px-3 py-2 pr-8 focus:outline-none"
        />
        <button
          type="button"
          onPointerDown={onResizeMessageBoxStart}
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
            void onStopConversation();
            return;
          }
          void handleSendMessage();
        }}
        disabled={
          isGeneratingForSelectedSession
            ? stoppingTurn
            : sendingMessage || isSendingLocked || !draft.trim()
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
  );
});

function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [collaborationModes, setCollaborationModes] = useState<
    CodexCollaborationModeOption[]
  >([]);
  const [sessionModeById, setSessionModeById] = useState<
    Record<string, CollaborationModeKey>
  >(() => loadSessionModeMap());
  const [selectedModeKey, setSelectedModeKey] =
    useState<CollaborationModeKey>("default");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<
    CodexReasoningEffort | ""
  >("");
  const [messageHistoryBySession, setMessageHistoryBySession] = useState<
    Record<string, string[]>
  >(() => loadMessageHistoryMap());
  const [newSessionCwd, setNewSessionCwd] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [stoppingTurn, setStoppingTurn] = useState(false);
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [fixingDangling, setFixingDangling] = useState(false);
  const [showFixDanglingConfirm, setShowFixDanglingConfirm] = useState(false);
  const [waitSilenceStartedAt, setWaitSilenceStartedAt] = useState<
    number | null
  >(null);
  const [showFixDangling, setShowFixDangling] = useState(false);
  const [messageBoxHeight, setMessageBoxHeight] = useState(
    MESSAGE_BOX_DEFAULT_HEIGHT,
  );
  const [contextLeftPercent, setContextLeftPercent] = useState<number | null>(
    null,
  );
  const [contextUsedTokens, setContextUsedTokens] = useState<number | null>(
    null,
  );
  const [contextRefreshVersion, setContextRefreshVersion] = useState(0);
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

    Promise.all([listCodexModels(), listCodexCollaborationModes()])
      .then(([modelsData, collaborationModesData]) => {
        if (cancelled) {
          return;
        }

        setModels(modelsData);
        setCollaborationModes(collaborationModesData);

        if (!selectedModelId) {
          const defaultModel =
            modelsData.find((model) => model.isDefault && !model.hidden) ??
            modelsData.find((model) => !model.hidden) ??
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

  useEffect(() => {
    if (!selectedSession) {
      setContextLeftPercent(null);
      setContextUsedTokens(null);
      return;
    }

    let cancelled = false;

    getSessionContext(selectedSession)
      .then((context) => {
        if (cancelled) {
          return;
        }
        setContextLeftPercent(context.contextLeftPercent);
        setContextUsedTokens(context.usedTokens);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setContextLeftPercent(null);
        setContextUsedTokens(null);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSession, selectedSessionData?.timestamp, contextRefreshVersion]);

  const handleSessionsFull = useCallback((event: MessageEvent) => {
    const data: Session[] = JSON.parse(event.data);
    setSessions(data);
    setLoading(false);
  }, []);

  const handleSessionsUpdate = useCallback(
    (event: MessageEvent) => {
      const updates: Session[] = JSON.parse(event.data);
      const includesSelectedSession =
        !!selectedSession &&
        updates.some((update) => update.id === selectedSession);

      setSessions((prev) => {
        const sessionMap = new Map(prev.map((s) => [s.id, s]));
        for (const update of updates) {
          sessionMap.set(update.id, update);
        }
        return Array.from(sessionMap.values()).sort(
          (a, b) => b.timestamp - a.timestamp,
        );
      });

      if (includesSelectedSession) {
        setContextRefreshVersion((value) => value + 1);
      }
    },
    [selectedSession],
  );

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
  const hasPlanMode = useMemo(
    () =>
      collaborationModes.length === 0 ||
      collaborationModes.some((mode) => mode.mode === "plan"),
    [collaborationModes],
  );
  const isPlanModeEnabled = selectedModeKey === "plan";

  const getSessionMode = useCallback(
    (sessionId: string | null): CollaborationModeKey => {
      if (!sessionId) {
        return "default";
      }

      const saved = sessionModeById[sessionId];
      if (saved === "plan" && !hasPlanMode) {
        return "default";
      }

      return saved ?? "default";
    },
    [sessionModeById, hasPlanMode],
  );

  const setSessionMode = useCallback(
    (sessionId: string, mode: CollaborationModeKey) => {
      const normalizedMode = mode === "plan" && !hasPlanMode ? "default" : mode;

      setSessionModeById((current) => {
        if (current[sessionId] === normalizedMode) {
          return current;
        }
        return {
          ...current,
          [sessionId]: normalizedMode,
        };
      });

      if (selectedSession === sessionId) {
        setSelectedModeKey(normalizedMode);
      }
    },
    [hasPlanMode, selectedSession],
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

  useEffect(() => {
    if (!hasPlanMode) {
      if (selectedSession && selectedModeKey === "plan") {
        setSessionMode(selectedSession, "default");
      } else if (!selectedSession && selectedModeKey === "plan") {
        setSelectedModeKey("default");
      }
    }
  }, [hasPlanMode, selectedModeKey, selectedSession, setSessionMode]);

  useEffect(() => {
    persistSessionModeMap(sessionModeById);
  }, [sessionModeById]);

  useEffect(() => {
    persistMessageHistoryMap(messageHistoryBySession);
  }, [messageHistoryBySession]);

  useEffect(() => {
    setSelectedModeKey(getSessionMode(selectedSession));
  }, [getSessionMode, selectedSession]);

  useEffect(() => {
    if (!selectedSession) {
      return;
    }

    let cancelled = false;

    getConversation(selectedSession)
      .then((messages) => {
        if (cancelled) {
          return;
        }

        const userInputs = extractUserInputHistory(messages);

        setMessageHistoryBySession((current) => {
          const existing = current[selectedSession] ?? [];
          if (
            existing.length === userInputs.length &&
            existing.every((value, index) => value === userInputs[index])
          ) {
            return current;
          }

          return {
            ...current,
            [selectedSession]: userInputs,
          };
        });
      })
      .catch(() => {
        // Keep existing local history if conversation fetch fails.
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSession]);

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
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
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

  const sendMessageText = useCallback(
    async (
      text: string,
      options?: {
        modeOverride?: CollaborationModeKey;
      },
    ): Promise<boolean> => {
      if (
        !selectedSession ||
        sendingMessage ||
        pendingTurn?.sessionId === selectedSession
      ) {
        return false;
      }

      const normalizedText = text.trim();
      if (!normalizedText) {
        return false;
      }

      const requestedMode = options?.modeOverride ?? selectedModeKey;
      const modeToUse =
        requestedMode === "plan" && !hasPlanMode ? "default" : requestedMode;
      const sessionId = selectedSession;

      setSendingMessage(true);
      setInteractionError(null);
      waitSuppressSessionsRef.current.delete(selectedSession);

      try {
        const response = await sendCodexMessage(selectedSession, {
          text: normalizedText,
          ...(selectedSessionData?.project
            ? { cwd: selectedSessionData.project }
            : {}),
          ...(selectedModelId ? { model: selectedModelId } : {}),
          ...(selectedEffort ? { effort: selectedEffort } : {}),
          collaborationMode: {
            mode: modeToUse,
            settings: {
              model: selectedModelId || null,
              reasoningEffort: selectedEffort || null,
              developerInstructions: null,
            },
          },
        });

        setSessionMode(sessionId, modeToUse);
        setPendingTurn({
          sessionId,
          turnId: response.turnId,
        });
        return true;
      } catch (error) {
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
        return false;
      } finally {
        setSendingMessage(false);
      }
    },
    [
      selectedSession,
      sendingMessage,
      pendingTurn?.sessionId,
      selectedModeKey,
      hasPlanMode,
      selectedSessionData?.project,
      selectedModelId,
      selectedEffort,
      setSessionMode,
    ],
  );

  const handleSendMessage = useCallback(
    async (text: string): Promise<boolean> => {
      const sessionId = selectedSession;
      const normalizedText = text.trim();
      const sent = await sendMessageText(normalizedText);
      if (!sent || !sessionId) {
        return sent;
      }

      setMessageHistoryBySession((current) => {
        const sessionHistory = current[sessionId] ?? [];
        return {
          ...current,
          [sessionId]: [...sessionHistory, normalizedText],
        };
      });
      return true;
    },
    [selectedSession, sendMessageText],
  );

  const handlePlanProposalAction = useCallback(
    async (sessionId: string, action: "implement" | "stay") => {
      if (!selectedSession || sessionId !== selectedSession) {
        return;
      }

      if (action === "stay") {
        setSessionMode(sessionId, hasPlanMode ? "plan" : "default");
        return;
      }

      await sendMessageText(PLAN_IMPLEMENTATION_MESSAGE, {
        modeOverride: "default",
      });
    },
    [selectedSession, hasPlanMode, sendMessageText, setSessionMode],
  );

  const handleTogglePlanMode = useCallback(() => {
    if (!hasPlanMode) {
      return;
    }

    if (!selectedSession) {
      setSelectedModeKey((current) =>
        current === "plan" ? "default" : "plan",
      );
      return;
    }

    setSessionMode(
      selectedSession,
      selectedModeKey === "plan" ? "default" : "plan",
    );
  }, [hasPlanMode, selectedModeKey, selectedSession, setSessionMode]);

  const handleStopConversation = useCallback(async () => {
    if (
      !selectedSession ||
      pendingTurn?.sessionId !== selectedSession ||
      stoppingTurn
    ) {
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
        setInteractionError(
          error instanceof Error ? error.message : String(error),
        );
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

  useEffect(() => {
    if (!selectedSession || !isGeneratingForSelectedSession) {
      setWaitSilenceStartedAt(null);
      setShowFixDangling(false);
      setShowFixDanglingConfirm(false);
      setFixingDangling(false);
      return;
    }

    setWaitSilenceStartedAt(Date.now());
    setShowFixDangling(false);
  }, [selectedSession, isGeneratingForSelectedSession]);

  useEffect(() => {
    if (!isGeneratingForSelectedSession || waitSilenceStartedAt === null) {
      return;
    }

    const maybeShowButton = () => {
      if (Date.now() - waitSilenceStartedAt >= FIX_DANGLING_WAIT_THRESHOLD_MS) {
        setShowFixDangling(true);
      }
    };

    maybeShowButton();
    const interval = setInterval(maybeShowButton, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [isGeneratingForSelectedSession, waitSilenceStartedAt]);

  const handleConversationActivity = useCallback(
    (sessionId: string) => {
      if (
        !selectedSession ||
        sessionId !== selectedSession ||
        !isGeneratingForSelectedSession
      ) {
        return;
      }

      setWaitSilenceStartedAt(Date.now());
      setShowFixDangling(false);
    },
    [selectedSession, isGeneratingForSelectedSession],
  );

  const handleFixDangling = useCallback(() => {
    if (!selectedSession || fixingDangling) {
      return;
    }

    setShowFixDanglingConfirm(true);
  }, [selectedSession, fixingDangling]);

  const handleConfirmFixDangling = useCallback(async () => {
    if (!selectedSession || fixingDangling) {
      return;
    }

    setShowFixDanglingConfirm(false);
    setFixingDangling(true);
    setInteractionError(null);
    try {
      await fixDanglingSession(selectedSession);
      setWaitSilenceStartedAt(Date.now());
      setShowFixDangling(false);
      setPendingTurn((current) =>
        current?.sessionId === selectedSession ? null : current,
      );
      waitSuppressSessionsRef.current.delete(selectedSession);
    } catch (error) {
      setInteractionError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setFixingDangling(false);
    }
  }, [selectedSession, fixingDangling]);

  const newSessionPlaceholder =
    selectedProject || selectedSessionData?.project || "/path/to/project";
  const contextWindowText =
    typeof contextLeftPercent === "number"
      ? `${Math.max(0, Math.min(100, Math.round(contextLeftPercent)))}% context left`
      : typeof contextUsedTokens === "number"
        ? `${TOKEN_COUNT_FORMATTER.format(Math.max(0, Math.round(contextUsedTokens)))} used`
        : "100% context left";

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

        {showFixDanglingConfirm && selectedSession && (
          <div className="fixed right-4 bottom-4 z-50 w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-amber-700/60 bg-zinc-900/95 shadow-2xl backdrop-blur">
            <div className="px-4 py-3">
              <div className="text-sm font-semibold text-amber-200">
                Fix dangling turns?
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                Warning: this will modify the session file by appending
                synthetic ended-turn events.
              </p>
              <p className="mt-2 text-xs leading-relaxed text-zinc-300">
                Proceed only if no other Codex instance is interacting with this
                session.
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowFixDanglingConfirm(false);
                  }}
                  disabled={fixingDangling}
                  className="h-8 rounded border border-zinc-700 bg-zinc-800/80 px-3 text-xs text-zinc-200 transition-colors hover:bg-zinc-700/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleConfirmFixDangling();
                  }}
                  disabled={fixingDangling}
                  className="h-8 rounded border border-amber-600/70 bg-amber-700/25 px-3 text-xs text-amber-100 transition-colors hover:bg-amber-700/35 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {fixingDangling ? "Fixing..." : "Proceed"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {selectedSession ? (
            <div className="h-full flex flex-col">
              <div className="flex-1 overflow-hidden">
                <SessionView
                  sessionId={selectedSession}
                  onPlanAction={handlePlanProposalAction}
                  onConversationActivity={handleConversationActivity}
                />
              </div>

              <div className="border-t border-zinc-800/60 bg-zinc-950 p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleTogglePlanMode}
                    disabled={!hasPlanMode}
                    className={`h-9 px-3 text-xs rounded border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      isPlanModeEnabled
                        ? "border-blue-500/50 bg-blue-500/20 text-blue-200 hover:bg-blue-500/25"
                        : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:bg-zinc-800/80"
                    }`}
                    title={
                      hasPlanMode
                        ? "Toggle Plan mode"
                        : "Plan mode is unavailable for this session"
                    }
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {isPlanModeEnabled ? (
                        <CircleDot className="h-3.5 w-3.5" />
                      ) : (
                        <Circle className="h-3.5 w-3.5" />
                      )}
                      Plan
                    </span>
                  </button>

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
                    <option value={DEFAULT_OPTION_VALUE}>
                      Effort: default
                    </option>
                    {effortOptions.map((effort) => (
                      <option key={effort} value={effort}>
                        {effort}
                      </option>
                    ))}
                  </select>
                  <span className="ml-auto text-xs text-zinc-500">
                    {contextWindowText}
                  </span>
                </div>

                <MessageComposer
                  sessionId={selectedSession}
                  history={messageHistoryBySession[selectedSession] ?? []}
                  isGeneratingForSelectedSession={
                    isGeneratingForSelectedSession
                  }
                  showFixDangling={
                    isGeneratingForSelectedSession && showFixDangling
                  }
                  fixingDangling={fixingDangling}
                  isSendingLocked={isSendingLocked}
                  sendingMessage={sendingMessage}
                  stoppingTurn={stoppingTurn}
                  messageBoxHeight={messageBoxHeight}
                  onResizeMessageBoxStart={handleResizeMessageBoxStart}
                  onSendMessage={handleSendMessage}
                  onStopConversation={handleStopConversation}
                  onFixDangling={handleFixDangling}
                />
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
