import { useEffect, useState, useRef, useCallback, memo } from "react";
import type {
  ConversationMessage,
  CodexUserInputRequest,
  CodexUserInputResponsePayload,
} from "@codex-run/api";
import MessageBlock from "./message-block";
import ScrollToBottomButton from "./scroll-to-bottom-button";
import {
  listCodexUserInputRequests,
  respondCodexUserInputRequest,
} from "../api";

const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const SCROLL_THRESHOLD_PX = 100;
const USER_INPUT_POLL_INTERVAL_MS = 1200;

interface SessionViewProps {
  sessionId: string;
  onPlanAction?: (
    sessionId: string,
    action: "implement" | "stay",
  ) => void;
}

interface ConversationStreamPayload {
  messages: ConversationMessage[];
  nextOffset: number;
}

const SessionView = memo(function SessionView(props: SessionViewProps) {
  const { sessionId, onPlanAction } = props;

  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [pendingUserInputRequests, setPendingUserInputRequests] = useState<
    CodexUserInputRequest[]
  >([]);
  const [selectedUserInputAnswers, setSelectedUserInputAnswers] = useState<
    Record<string, Record<string, string>>
  >({});
  const [submittingUserInputRequestIds, setSubmittingUserInputRequestIds] =
    useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const isScrollingProgrammaticallyRef = useRef(false);
  const retryCountRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mountedRef = useRef(true);
  const submittingRequestIdsRef = useRef<Set<string>>(new Set());

  const connect = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const eventSource = new EventSource(
      `/api/conversation/${sessionId}/stream?offset=${offsetRef.current}`
    );
    eventSourceRef.current = eventSource;

    eventSource.addEventListener("messages", (event) => {
      retryCountRef.current = 0;
      const payload: ConversationStreamPayload | ConversationMessage[] = JSON.parse(
        event.data
      );
      const newMessages = Array.isArray(payload)
        ? payload
        : payload.messages;

      if (!Array.isArray(payload) && Number.isFinite(payload.nextOffset)) {
        offsetRef.current = payload.nextOffset;
      }

      setLoading(false);
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.uuid).filter(Boolean));
        const unique = newMessages.filter((m) => !existingIds.has(m.uuid));
        if (unique.length === 0 && !Array.isArray(payload)) {
          return prev;
        }
        return [...prev, ...unique];
      });
    });

    eventSource.onerror = () => {
      eventSource.close();
      setLoading(false);

      if (!mountedRef.current) {
        return;
      }

      if (retryCountRef.current < MAX_RETRIES) {
        const delay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, retryCountRef.current), MAX_RETRY_DELAY_MS);
        retryCountRef.current++;
        retryTimeoutRef.current = setTimeout(() => connect(), delay);
      }
    };
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setMessages([]);
    setPendingUserInputRequests([]);
    setSelectedUserInputAnswers({});
    setSubmittingUserInputRequestIds([]);
    submittingRequestIdsRef.current.clear();
    offsetRef.current = 0;
    retryCountRef.current = 0;

    connect();

    return () => {
      mountedRef.current = false;
      if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
      }
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [connect]);

  const pollPendingUserInputRequests = useCallback(async () => {
    try {
      const requests = await listCodexUserInputRequests(sessionId);
      if (!mountedRef.current) {
        return;
      }

      setPendingUserInputRequests(requests);
      const activeIds = new Set(requests.map((request) => request.requestId));

      setSelectedUserInputAnswers((previous) => {
        const next: Record<string, Record<string, string>> = {};
        for (const [requestId, answers] of Object.entries(previous)) {
          if (activeIds.has(requestId)) {
            next[requestId] = answers;
          }
        }
        return next;
      });

      setSubmittingUserInputRequestIds((previous) =>
        previous.filter((requestId) => activeIds.has(requestId)),
      );
      submittingRequestIdsRef.current = new Set(
        [...submittingRequestIdsRef.current].filter((requestId) =>
          activeIds.has(requestId),
        ),
      );
    } catch {
      // Keep UI state as-is on transient polling failures.
    }
  }, [sessionId]);

  useEffect(() => {
    void pollPendingUserInputRequests();
    const interval = setInterval(() => {
      void pollPendingUserInputRequests();
    }, USER_INPUT_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [pollPendingUserInputRequests]);

  const submitUserInputResponse = useCallback(
    async (
      request: CodexUserInputRequest,
      response: CodexUserInputResponsePayload,
    ) => {
      const requestId = request.requestId;
      if (submittingRequestIdsRef.current.has(requestId)) {
        return;
      }
      submittingRequestIdsRef.current.add(requestId);
      setSubmittingUserInputRequestIds((previous) =>
        previous.includes(requestId) ? previous : [...previous, requestId],
      );

      try {
        await respondCodexUserInputRequest(sessionId, requestId, response);
      } catch {
        // Let polling keep the request visible if submission fails.
      } finally {
        submittingRequestIdsRef.current.delete(requestId);
        setSubmittingUserInputRequestIds((previous) =>
          previous.filter((id) => id !== requestId),
        );
        void pollPendingUserInputRequests();
      }
    },
    [pollPendingUserInputRequests, sessionId],
  );

  const handleSelectUserInputOption = useCallback(
    (
      request: CodexUserInputRequest,
      questionId: string,
      optionLabel: string,
    ) => {
      if (!request.requestId || !questionId || !optionLabel) {
        return;
      }

      if (submittingRequestIdsRef.current.has(request.requestId)) {
        return;
      }

      if (request.questions.length <= 1) {
        void submitUserInputResponse(request, {
          answers: {
            [questionId]: {
              answers: [optionLabel],
            },
          },
        });
        return;
      }

      setSelectedUserInputAnswers((previous) => {
        const currentAnswers = previous[request.requestId] ?? {};
        const nextAnswers = {
          ...currentAnswers,
          [questionId]: optionLabel,
        };

        const allAnswered = request.questions.every(
          (question) =>
            typeof nextAnswers[question.id] === "string" &&
            nextAnswers[question.id].trim().length > 0,
        );

        if (allAnswered) {
          const payload: CodexUserInputResponsePayload = {
            answers: {},
          };
          for (const question of request.questions) {
            const answer = nextAnswers[question.id];
            if (answer) {
              payload.answers[question.id] = { answers: [answer] };
            }
          }
          void submitUserInputResponse(request, payload);
        }

        return {
          ...previous,
          [request.requestId]: nextAnswers,
        };
      });
    },
    [submitUserInputResponse],
  );

  const scrollToBottom = useCallback(() => {
    if (!lastMessageRef.current) {
      return;
    }
    isScrollingProgrammaticallyRef.current = true;
    lastMessageRef.current.scrollIntoView({ behavior: "instant", block: "end" });
    requestAnimationFrame(() => {
      isScrollingProgrammaticallyRef.current = false;
    });
  }, []);

  useEffect(() => {
    if (autoScroll) {
      scrollToBottom();
    }
  }, [messages, autoScroll, scrollToBottom]);

  const handleScroll = () => {
    if (!containerRef.current || isScrollingProgrammaticallyRef.current) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD_PX;
    setAutoScroll(isAtBottom);
  };

  const summary = messages.find((m) => m.type === "summary");
  const visibleMessages = messages.filter(
    (m) =>
      m.type === "user" ||
      m.type === "assistant" ||
      m.type === "reasoning" ||
      m.type === "agent_reasoning"
  );
  const chatMessages = visibleMessages.filter(
    (m) => m.type === "user" || m.type === "assistant"
  );
  const handlePlanAction = useCallback(
    (action: "implement" | "stay") => {
      onPlanAction?.(sessionId, action);
    },
    [onPlanAction, sessionId],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        Loading...
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto bg-zinc-950"
      >
        <div className="mx-auto max-w-3xl px-4 py-4">
          {summary && (
            <div className="mb-6 rounded-xl border border-zinc-800/60 bg-zinc-900/50 p-4">
              <h2 className="text-sm font-medium text-zinc-200 leading-relaxed">
                {summary.summary}
              </h2>
              <p className="mt-2 text-[11px] text-zinc-500">
                {chatMessages.length} messages
              </p>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {visibleMessages.map((message, index) => (
              <div
                key={message.uuid || index}
                ref={
                  index === visibleMessages.length - 1
                    ? lastMessageRef
                    : undefined
                }
              >
                <MessageBlock
                  message={message}
                  onPlanAction={onPlanAction ? handlePlanAction : undefined}
                  pendingUserInputRequests={pendingUserInputRequests}
                  selectedUserInputAnswers={selectedUserInputAnswers}
                  submittingUserInputRequestIds={submittingUserInputRequestIds}
                  onSelectUserInputOption={handleSelectUserInputOption}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {!autoScroll && (
        <ScrollToBottomButton
          onClick={() => {
            setAutoScroll(true);
            scrollToBottom();
          }}
        />
      )}
    </div>
  );
});

export default SessionView;
