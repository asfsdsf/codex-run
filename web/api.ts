import type {
  CodexModelOption,
  CreateCodexThreadRequest,
  CreateCodexThreadResponse,
  SendCodexMessageRequest,
} from "@codex-run/api";

interface ApiErrorPayload {
  error?: string;
}

interface CodexModelsResponse {
  models: CodexModelOption[];
}

interface SendCodexMessageResponse {
  ok: boolean;
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
