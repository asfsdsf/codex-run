import type {
  ConversationMessage,
  CodexCollaborationModeOption,
  CodexThreadStateResponse,
  CodexModelOption,
  CodexSessionContextResponse,
  FixDanglingSessionResponse,
  CreateCodexThreadRequest,
  CreateCodexThreadResponse,
  CodexUserInputRequest,
  CodexUserInputResponsePayload,
  SendCodexMessageRequest,
  SendCodexMessageResponse,
} from "@codex-run/api";

interface ApiErrorPayload {
  error?: string;
}

interface CodexModelsResponse {
  models: CodexModelOption[];
}

interface CodexCollaborationModesResponse {
  modes: CodexCollaborationModeOption[];
}

interface InterruptCodexThreadResponse {
  ok: boolean;
}

interface CodexUserInputRequestsResponse {
  requests: CodexUserInputRequest[];
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json()) as T | ApiErrorPayload;

  if (!response.ok) {
    const errorMessage =
      typeof (payload as ApiErrorPayload).error === "string"
        ? (payload as ApiErrorPayload).error
        : `Request failed with status ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

export async function listCodexModels(): Promise<CodexModelOption[]> {
  const payload = await requestJson<CodexModelsResponse>("/api/codex/models");
  return Array.isArray(payload.models) ? payload.models : [];
}

export async function listCodexCollaborationModes(): Promise<
  CodexCollaborationModeOption[]
> {
  const payload = await requestJson<CodexCollaborationModesResponse>(
    "/api/codex/collaboration-modes",
  );
  return Array.isArray(payload.modes) ? payload.modes : [];
}

export async function createCodexThread(
  input: CreateCodexThreadRequest,
): Promise<CreateCodexThreadResponse> {
  return requestJson<CreateCodexThreadResponse>("/api/codex/threads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function sendCodexMessage(
  threadId: string,
  input: SendCodexMessageRequest,
): Promise<SendCodexMessageResponse> {
  return requestJson<SendCodexMessageResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
  );
}

export async function getCodexThreadState(
  threadId: string,
  turnId?: string | null,
): Promise<CodexThreadStateResponse> {
  const params = new URLSearchParams();
  if (typeof turnId === "string" && turnId.trim()) {
    params.set("turnId", turnId.trim());
  }
  const query = params.toString();
  return requestJson<CodexThreadStateResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/state${query ? `?${query}` : ""}`,
  );
}

export async function interruptCodexThread(
  threadId: string,
): Promise<InterruptCodexThreadResponse> {
  return requestJson<InterruptCodexThreadResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/interrupt`,
    {
      method: "POST",
    },
  );
}

export async function listCodexUserInputRequests(
  threadId: string,
): Promise<CodexUserInputRequest[]> {
  const payload = await requestJson<CodexUserInputRequestsResponse>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/requests/user-input`,
  );
  return Array.isArray(payload.requests) ? payload.requests : [];
}

export async function respondCodexUserInputRequest(
  threadId: string,
  requestId: string,
  response: CodexUserInputResponsePayload,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/codex/threads/${encodeURIComponent(threadId)}/requests/user-input/${encodeURIComponent(requestId)}/respond`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(response),
    },
  );
}

export async function getSessionContext(
  sessionId: string,
): Promise<CodexSessionContextResponse> {
  return requestJson<CodexSessionContextResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/context`,
  );
}

export async function fixDanglingSession(
  sessionId: string,
): Promise<FixDanglingSessionResponse> {
  return requestJson<FixDanglingSessionResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/fix-dangling`,
    {
      method: "POST",
    },
  );
}

export async function getConversation(
  sessionId: string,
): Promise<ConversationMessage[]> {
  return requestJson<ConversationMessage[]>(
    `/api/conversation/${encodeURIComponent(sessionId)}`,
  );
}
