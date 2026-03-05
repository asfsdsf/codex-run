import { watch, type FSWatcher } from "chokidar";
import { join } from "path";
import { open } from "fs/promises";
import { createInterface } from "readline";

type HistoryChangeCallback = () => void;
type SessionChangeCallback = (sessionId: string, filePath: string) => void;

let watcher: FSWatcher | null = null;
let codexDir = "";
let historyPath = "";
let sessionsDir = "";

const debounceTimers = new Map<string, NodeJS.Timeout>();
const debounceMs = 20;

const historyChangeListeners = new Set<HistoryChangeCallback>();
const sessionChangeListeners = new Set<SessionChangeCallback>();

export function initWatcher(dir: string): void {
  codexDir = dir;
  historyPath = join(codexDir, "history.jsonl");
  sessionsDir = join(codexDir, "sessions");
}

function extractSessionIdFromPath(filePath: string): string | null {
  const match = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match?.[1] ?? null;
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

async function extractSessionIdFromMeta(filePath: string): Promise<string | null> {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine) {
    return null;
  }

  try {
    const parsed = JSON.parse(firstLine) as {
      type?: string;
      payload?: { id?: string };
    };

    if (
      parsed.type === "session_meta" &&
      typeof parsed.payload?.id === "string" &&
      parsed.payload.id
    ) {
      return parsed.payload.id;
    }
  } catch {
    // Ignore malformed metadata lines.
  }

  return null;
}

async function emitChange(filePath: string): Promise<void> {
  if (filePath.endsWith("history.jsonl")) {
    for (const callback of historyChangeListeners) {
      callback();
    }
    return;
  }

  if (!filePath.endsWith(".jsonl") || !filePath.includes(`${sessionsDir}/`)) {
    return;
  }

  let sessionId = extractSessionIdFromPath(filePath);
  if (!sessionId) {
    sessionId = await extractSessionIdFromMeta(filePath);
  }

  if (!sessionId) {
    return;
  }

  for (const callback of sessionChangeListeners) {
    callback(sessionId, filePath);
  }
}

function handleChange(filePath: string): void {
  const existing = debounceTimers.get(filePath);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(filePath);
    void emitChange(filePath);
  }, debounceMs);

  debounceTimers.set(filePath, timer);
}

export function startWatcher(): void {
  if (watcher) {
    return;
  }

  const usePolling =
    process.env.CODEX_RUN_USE_POLLING === "1" ||
    process.env.CLAUDE_RUN_USE_POLLING === "1";

  watcher = watch([historyPath, sessionsDir], {
    persistent: true,
    ignoreInitial: true,
    usePolling,
    ...(usePolling && { interval: 100 }),
    depth: 6,
  });

  watcher.on("change", handleChange);
  watcher.on("add", handleChange);
  watcher.on("error", (error) => {
    console.error("Watcher error:", error);
  });
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

export function onHistoryChange(callback: HistoryChangeCallback): void {
  historyChangeListeners.add(callback);
}

export function offHistoryChange(callback: HistoryChangeCallback): void {
  historyChangeListeners.delete(callback);
}

export function onSessionChange(callback: SessionChangeCallback): void {
  sessionChangeListeners.add(callback);
}

export function offSessionChange(callback: SessionChangeCallback): void {
  sessionChangeListeners.delete(callback);
}
