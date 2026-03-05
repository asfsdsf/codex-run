> This doc should be modified during developing. Implemented features should be marked.

# Codex Migration Plan

Last updated: 2026-03-05  
Status: Planning only (no implementation in this step)

## Progress Legend

- `[ ]` Not implemented
- `[~]` In progress (manually switch from `[ ]`)
- `[x]` Implemented

## Goal

Migrate this project from Claude Code history backend (`~/.claude`) to Codex history backend (`~/.codex`) while preserving the same product flow:

- Session list
- Project filter
- Conversation view
- Live streaming updates
- Resume command copy

## Non-Goals

- No data rewrite/migration into Codex or Claude storage
- No change to Codex CLI itself
- No feature expansion beyond parity unless needed for Codex compatibility

## Current State (Claude-Coupled Areas)

### Backend

- `api/storage.ts`
- `api/watcher.ts`
- `api/server.ts`
- `api/index.ts`

Claude-specific assumptions today:

- Root dir defaults to `~/.claude`
- Session list source is `~/.claude/history.jsonl`
- Conversation source is `~/.claude/projects/<encoded-project>/<session-id>.jsonl`
- Watcher tracks `history.jsonl` + `projects/`
- Conversation parser assumes Claude line objects with `type: user|assistant|summary`

### Frontend

- `web/app.tsx`
- `web/components/message-block.tsx`
- `web/components/session-view.tsx`
- `web/components/session-list.tsx`

Claude-specific assumptions today:

- Type import alias uses `@claude-run/api`
- Resume command hardcoded to: `claude --resume <sessionId>`
- Message renderer expects Claude `tool_use/tool_result` content blocks

### Package/Branding

- `package.json` package/bin/keywords are Claude-specific
- `README.md` and CLI text are Claude-specific

## Observed Codex Data Model (From Existing Local Data)

Paths observed:

- `~/.codex/history.jsonl`
- `~/.codex/sessions/YYYY/MM/DD/*.jsonl`

Observed from current local data:

- Session files counted: `145`
- Files with first line `session_meta`: `145/145`
- History unique `session_id`: `136`
- Session files not present in history: `9` (must support file-only sessions)

Codex history line shape:

- Keys: `session_id`, `ts` (unix seconds), `text`

Codex session file record top-level `type` observed:

- `session_meta`
- `turn_context`
- `response_item`
- `event_msg`
- `compacted`

Codex `response_item.payload.type` observed:

- `message`
- `reasoning`
- `function_call`
- `function_call_output`
- `custom_tool_call`
- `custom_tool_call_output`
- `web_search_call`

Important compatibility implications:

- Codex does not use Claude `projects/<encoded>` layout
- Session metadata (`cwd`, timestamps) lives in `session_meta`
- Tool activity is represented as separate response items, not Claude-style inline `tool_use/tool_result` blocks
- History is incomplete for some sessions, so file scan fallback is required

## Target Architecture

Adopt a provider abstraction and keep API/UI contracts stable where possible.

### Provider Interface (planned)

- `loadStorage()`
- `getSessions()`
- `getProjects()`
- `getConversation(sessionId)`
- `getConversationStream(sessionId, fromOffset)`
- `watchHistoryAndSessions()` hooks

### Providers

- `ClaudeProvider` (compatibility mode, optional but recommended)
- `CodexProvider` (default)

### Canonical Internal Models

Keep existing `Session` and `ConversationMessage` API shape for frontend compatibility, but generate them from provider-specific parsers.

## Mapping Spec (Codex -> Current App Models)

### Session Mapping

- `Session.id` <- `history.session_id` (fallback: parsed from session filename or `session_meta.payload.id`)
- `Session.timestamp` <- latest `history.ts * 1000` for that session (fallback: `session_meta.payload.timestamp`)
- `Session.display` <- latest `history.text` for that session
- `Session.project` <- `session_meta.payload.cwd`
- `Session.projectName` <- basename(`cwd`)

Fallback rules:

- If session id exists in files but not history, synthesize session row from `session_meta`
- If `display` missing, use first user message text snippet or `"(no prompt text)"`

### Conversation Mapping

Source order: preserve file order.

- Include only user/assistant-visible data in main thread
- Skip internal control records (`turn_context`, `token_count`, most `event_msg`, `compacted`)
- Map `response_item.message` with role `user|assistant` into current message objects
- Convert tool records into pseudo Claude-style content blocks so existing renderer works:
  - `function_call` / `custom_tool_call` -> `tool_use`
  - `function_call_output` / `custom_tool_call_output` -> `tool_result`
  - Link by `call_id`
- `web_search_call` can map to generic tool block (name `web_search`) for visibility

### Streaming Offset Semantics

Current backend stream offset is byte-oriented; frontend reconnect path currently behaves like message-count offset. Migration should normalize this and use byte offset end-to-end to avoid duplicate/missed events after reconnect.

## Full Migration Plan

## Phase 0: Baseline and Safety

- `[ ]` Capture current behavior baseline (screenshots + manual flow notes)
- `[ ]` Add migration feature flag/config (`storageProvider: claude|codex`)
- `[ ]` Define fallback behavior when Codex paths do not exist

Exit criteria:

- App runs unchanged in Claude mode
- Toggle mechanism exists for iterative migration testing

## Phase 1: Storage Provider Refactor

- `[ ]` Extract current Claude logic behind provider interface
- `[ ]` Keep API route signatures unchanged (`/api/sessions`, `/api/projects`, etc.)
- `[ ]` Keep SSE event names unchanged (`sessions`, `sessionsUpdate`, `messages`)

Exit criteria:

- No frontend changes required to keep Claude mode working

## Phase 2: Codex Session Index + Session List

- `[x]` Build Codex file index from `~/.codex/sessions/**/**/**/*.jsonl`
- `[x]` Parse `session_meta` for `id`, `cwd`, session timestamp metadata
- `[x]` Parse `~/.codex/history.jsonl` and aggregate latest prompt per session
- `[x]` Merge history-backed + file-only sessions
- `[x]` Implement `getProjects()` from indexed `cwd`

Exit criteria:

- Session list loads from Codex with correct ordering
- Project filter works from `cwd`
- File-only sessions appear

## Phase 3: Codex Conversation Parser

- `[x]` Parse `response_item.message` for user/assistant text blocks
- `[x]` Build tool_use/result blocks from function/custom tool call pairs
- `[x]` Add safe parsing for unknown payload types (do not crash)
- `[x]` Add truncation/sanitization guardrails for very large tool outputs

Exit criteria:

- Conversation view renders user and assistant messages
- Tool actions/results are visible and linked correctly

## Phase 4: Watcher + Realtime Streaming

- `[x]` Watch `~/.codex/history.jsonl` and `~/.codex/sessions/` recursively
- `[x]` Detect new day directories and new files automatically
- `[x]` Map changed file -> session id reliably
- `[x]` Fix/align stream reconnect offset handling to byte offsets

Exit criteria:

- New sessions appear live
- Active session message stream updates live
- Reconnect does not duplicate/miss chunks

## Phase 5: UI/UX Codex Adaptation

- `[x]` Update resume button command to Codex format
- `[x]` Validate with real CLI help contract (`codex resume [SESSION_ID]`)
- `[x]` Update labels from Claude-specific wording where needed
- `[x]` Keep current visual style unless explicitly changing design

Exit criteria:

- Copy command resumes correct Codex session
- UI text no longer says Claude when running Codex mode

## Phase 6: Packaging and Naming

- `[x]` Rename package/bin metadata (`claude-run` -> codex-oriented name)
- `[x]` Update README usage, options, and screenshots/GIF references
- `[x]` Update alias imports (`@claude-run/api`) to neutral/provider-safe naming
- `[x]` Review keywords/repository metadata for publish readiness

Exit criteria:

- Build artifacts and CLI naming are consistent with Codex target

## Phase 7: Verification and Rollout

- `[x]` Run `pnpm build`
- `[ ]` Manual verify with existing Codex data:
- `[ ]` Session list loads
- `[ ]` Search/filter works
- `[ ]` Conversation renders correctly
- `[ ]` SSE live updates work
- `[ ]` Resume copy command works
- `[ ]` Optional regression check for Claude mode (if retained)

Exit criteria:

- Migration checklist fully green
- No blocker bugs in core flows

## Risks and Mitigations

- `[ ]` Risk: Codex record variants evolve (`payload.type` additions)
- Mitigation: schema-tolerant parser + default unknown renderer

- `[ ]` Risk: History does not include every session id
- Mitigation: merge strategy with file-first fallback

- `[ ]` Risk: Large tool outputs can hurt UI performance
- Mitigation: truncation + progressive rendering safeguards

- `[ ]` Risk: Real-time watchers miss nested/new date directories
- Mitigation: recursive watch + add event handling + periodic reindex fallback

## Rollback Plan

- `[ ]` Keep Claude provider intact until Codex migration is complete
- `[ ]` Runtime switch to Claude provider if Codex parser fails
- `[ ]` Preserve API contract so frontend rollback is immediate

## Implementation Order Recommendation

1. Provider abstraction
2. Codex sessions index
3. Conversation parser
4. Watcher + stream correctness
5. UI resume command + wording
6. Packaging/rename/docs

## Definition of Done

- `[ ]` Core flows work on real data in `~/.codex`
- `[ ]` All migration checklist items above are marked `[x]`
- `[ ]` `CODEX_MIGRATION.md` is updated during development with progress notes and implementation status
