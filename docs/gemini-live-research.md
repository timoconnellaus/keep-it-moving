# Research: Gemini 3.8 Live API for a local questionnaire voice agent

_Official Google sources checked against pages updated September 15, 2026. “Documented” means stated in a linked Google doc, API reference, or Google SDK source; “Recommendation” is an implementation conclusion._

## Summary

“Gemini Live 3.8” is an official name, not a mistaken shorthand. The default model is the **stable** `gemini-3.8-live`; Google also lists the stable `gemini-3.8-live-extended-thinking`, while `gemini-3.1-flash-live-preview` is now the legacy preview model. For this product, use a local companion service to keep the API key and durable questionnaire state, mint constrained ephemeral tokens, and let the browser connect directly to Gemini over WSS for low-latency audio.

The desired workflow is mostly feasible: Gemini can receive current-question context, call tools to submit answers and request clarification, and resume a recent session. It cannot run offline, guarantee that a “hidden” tool result is never later disclosed, or preserve durable continuity natively beyond a resumable server snapshot whose handle expires after two hours; those require application-owned state and policy.

## Findings

1. **Official model identity and status (documented).** `gemini-3.8-live` is Google’s stable, recommended low-latency Live model. It has a 131,072-token input limit and 65,536-token output limit, supports function calling and interleaved reasoning, but not structured output, context caching, code execution, file search, Maps, or URL context. `gemini-3.8-live-extended-thinking` is also marked stable, but is aimed at multi-step background reasoning and permits only asynchronous tools. `gemini-3.1-flash-live-preview` remains a legacy preview and Google recommends migrating. [3.8 model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live) · [Extended Thinking model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live-extended-thinking) · [Capabilities comparison](https://ai.google.dev/gemini-api/docs/live-api/capabilities)

2. **Browser connection architecture and auth (documented).** Live is a stateful WebSocket API. Google supports backend-to-Gemini and direct browser-to-Gemini designs; direct client-to-server avoids an audio/video proxy hop. In production, a browser must use a short-lived **ephemeral token**, not the long-lived API key. Google’s flow is backend authentication → backend creates token → browser receives token → browser opens the Live WSS connection. Ephemeral tokens work only with Live and `v1beta`; they can be constrained to the model and setup fields, including `gemini-3.8-live`, audio response modality, and session resumption. [Overview](https://ai.google.dev/gemini-api/docs/live-api) · [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) · [WebSocket reference](https://ai.google.dev/api/live) · [API-key security](https://ai.google.dev/gemini-api/docs/api-key)

3. **Recommended local architecture.** Run (a) a browser UI for microphone capture/playback and direct Gemini WSS, plus (b) a loopback-only companion service that owns `GEMINI_API_KEY`, mints constrained ephemeral tokens, stores questionnaire answers/session metadata, and bridges to the core agent. Bind the companion to loopback, restrict allowed origins, add CSRF/request authentication appropriate to the desktop/local app, and never place the key in a frontend environment variable or bundle. If “local-only” means no hosted application backend, this satisfies that constraint; if it means offline or no data sent to Google, **Gemini Live cannot satisfy it**.

4. **Current-question context and minimal system prompt (documented + recommendation).** Gemini 3.8 supports `send_client_content` for the whole session with explicit `user`/`model` roles. This is suitable for seeding/restoring concise questionnaire context; `turn_complete: true` starts a response and unconditionally interrupts active generation, while `false` accumulates context. Setup configuration cannot change on an open connection, so do not encode changing question state only in the system instruction. Keep the system instruction small (role, conversational behavior, tool invocation rules, non-disclosure intent), keep canonical question/answer state locally, and send a compact state update/current question as client content. Google recommends precise tool descriptions and invocation conditions even when the overall system prompt is short. [Capabilities: incremental updates](https://ai.google.dev/gemini-api/docs/live-api/capabilities#incremental-updates) · [API setup/client content](https://ai.google.dev/api/live) · [Best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices)

5. **Function-call transport and correlation (documented).** Live does not automatically execute custom tools. The server emits `toolCall.functionCalls[]`; the client executes each allowed function and sends `toolResponse.functionResponses[]`. Each response is correlated by copying the exact function-call `id` (and matching name). Multiple calls may arrive together. If an interrupted server turn causes `toolCallCancellation.ids[]`, the client should cancel pending work where possible and compensate any already-applied side effects. [Tool guide](https://ai.google.dev/gemini-api/docs/live-api/tools) · [Bidi tool-call reference](https://ai.google.dev/api/live#bidigeneratecontenttoolcall) · [JS SDK Live implementation](https://github.com/googleapis/js-genai/blob/v2.17.1/src/live.ts)

6. **Async semantics in 3.8 (documented).** For `gemini-3.8-live`, `NON_BLOCKING` is the default; explicit `BLOCKING` remains available. For a non-blocking call, response scheduling can be `SILENT` (add to model context without triggering generation), `WHEN_IDLE` (generate after current work), or `INTERRUPT` (interrupt and generate now); the SDK enum defaults to `WHEN_IDLE`. Extended Thinking requires `NON_BLOCKING`, rejects blocking tools, and does not support response scheduling; its client must track `interactionStatus=IN_PROGRESS|IDLE`, not equate `turnComplete` with idle. [3.8 migration notes](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live#migrating-from-gemini-31-flash-live) · [Tool guide](https://ai.google.dev/gemini-api/docs/live-api/tools#asynchronous-function-calling) · [JS SDK enum](https://github.com/googleapis/js-genai/blob/v2.18.0/src/types.ts) · [Thinking guide](https://ai.google.dev/gemini-api/docs/live-api/thinking)

7. **Recommended questionnaire tools.** Use explicit, narrow declarations and validate every argument in the companion service:

   - `submit_questionnaire_answers({ questionnaire_id, revision, answers: [{ question_id, answer }] })`: make this `BLOCKING` if the next spoken step must depend on a committed write. Enforce known IDs, revision checks, schema/size limits, and idempotency keyed by function-call `id`; return only `{accepted, revision, errors}`.
   - `request_core_clarification({ question_id, ambiguity, relevant_context })`: make this `NON_BLOCKING`; the client asks the core agent and returns a correlated result with scheduling `SILENT` when the result should enter context without causing immediate speech. Keep payloads minimal and treat core-agent text as untrusted data, not executable instructions.

   Do not rely on the model to call either tool deterministically: the local state machine must detect missing/duplicate/out-of-order submissions and retry or ask for confirmation.

8. **“Hidden” clarification is only UI-hidden, not model-secret (documented boundary + recommendation).** A custom tool call is delivered as a dedicated protocol event, so the app can omit it and its result from the visible transcript. `SILENT` avoids triggering an immediate model utterance. However, its documented behavior is to **add the result to conversation context**; Gemini can use or later mention it. There is no documented private side-channel, secrecy flag, or guarantee that content will never be surfaced. If strict secrecy is required, the companion/core agent must redact the result to the minimum model-safe guidance (for example, “ask question Q17 using wording variant B”) and enforce output filtering outside Gemini. Extended Thinking is a poor fit for this requirement because response scheduling is unsupported and it may speak progress fillers.

9. **Audio I/O (documented).** Send raw little-endian signed 16-bit PCM, preferably mono 16 kHz, with MIME type `audio/pcm;rate=16000`; the service can resample other rates. Output is raw 16-bit PCM at 24 kHz. Google recommends 20–40 ms chunks (and no large client buffer). Input and output transcription are optional setup features and are separately billed. Automatic VAD is on by default; send `audioStreamEnd` when the microphone pauses for more than about one second. On `interrupted: true`, immediately clear queued playback. The 3.8 model page says the supported **response modality is audio**, so use `outputAudioTranscription` when text is needed. [Capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities) · [Best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices) · [3.8 model migration notes](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live#migrating-from-gemini-31-flash-live)

10. **Resumption preserves a server snapshot, not durable application state (documented).** Enable `sessionResumption` and retain every latest `SessionResumptionUpdate.newHandle` for which `resumable=true`. Reconnect by placing that handle in the next setup. Google describes this as resuming the session with context intact, but the API contract only promises the state represented by the handle. At some points—explicitly while generating or executing function calls—`resumable=false`; reconnecting from an older handle can lose data. Context compression also discards oldest conversation content (while retaining system instructions), and no Live context caching is supported by the model. Therefore, handles do **not** replace the local answer store, pending-tool journal, unsent-message buffer, transcript/summary, audio playback state, or core-agent state. [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management) · [SessionResumptionUpdate contract](https://ai.google.dev/api/live#sessionresumptionupdate) · [Compression contract](https://ai.google.dev/api/live#contextwindowcompressionconfig)

11. **Stop/start continuity (recommendation).** On stop, persist the latest resumable handle, questionnaire revision/answers, current question, compact transcript/summary, and pending tool-call journal. On start within the handle window, try resumption with a freshly minted ephemeral token; if it fails—or after the two-hour window—start a new session and seed only the compact summary plus current questionnaire state via `send_client_content`. This provides durable UX continuity, but it is application-level recovery, not native indefinite Gemini memory.

12. **Expiry and operational limits (documented).** A WebSocket connection lasts about 10 minutes; listen for `GoAway.timeLeft` and reconnect. Without compression, audio-only sessions are limited to about 15 minutes and audio+video sessions to about 2 minutes; sliding-window compression can extend the session, at the cost of old context. Resumption handles remain valid for **2 hours after session termination**. Ephemeral-token defaults are one use, 60 seconds to start a new session, and 30 minutes to send messages; both token expiry fields may be set no more than 20 hours ahead, and resumption does not consume another token use. Rate limits are project-level, tier/model dependent, not guaranteed, and must be read from AI Studio rather than hard-coded. [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management) · [Ephemeral-token reference](https://ai.google.dev/api/live#ephemeral-auth-tokens) · [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)

13. **Security constraints (documented + recommendation).** Constrain ephemeral tokens to `gemini-3.8-live`, `AUDIO`, session resumption, and any setup fields that should not be client-controlled; set short expiries. Keep the API key and tool handlers outside the browser, allowlist function names, validate and cap all arguments/results, make answer writes idempotent, honor cancellations, and never execute model-generated code/URLs. Treat resumption handles and questionnaire records as sensitive local data. Gemini still receives audio, prompts, tool results returned to it, and seeded history; minimize PII and obtain appropriate user consent. [Ephemeral-token constraints](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) · [API-key guidance](https://ai.google.dev/gemini-api/docs/api-key) · [Live API reference](https://ai.google.dev/api/live)

## Review findings

- **high — future repo: browser authentication architecture** — A browser-only build that embeds `GEMINI_API_KEY` violates Google’s security guidance. Add a loopback token-minting service or use a server-to-server connection.
- **high — future repo: persistence/session layer** — Native resumption is limited to a two-hour handle and may be non-resumable during generation/tool execution. Durable stop/start requires a local canonical answer store and summary-based fallback.
- **high — future repo: hidden clarification contract** — `SILENT` suppresses triggered generation but puts the result in Gemini’s context; it is not a secrecy boundary. Redact externally and do not promise strict nondisclosure.
- **medium — upstream documentation inconsistency** — The 3.8 model page says scheduling supports `INTERRUPTED`, while the tool guide and current JS SDK enum specify `INTERRUPT`. Use the typed SDK value `FunctionResponseScheduling.INTERRUPT` rather than the apparent model-page typo.
- **medium — upstream documentation inconsistency** — The model property table lists text and audio output types, while the same page’s migration section says audio is the supported response modality and to use transcription for text. Implement native audio output plus optional transcription, and integration-test before relying on text response modality.
- **medium — future repo: tool reliability** — Function calling is model-selected and multiple/cancelled calls are valid protocol behavior. Validate state transitions, deduplicate by call ID, and never treat a spoken claim as proof an answer was committed.

## Suggested repository baseline

```text
apps/web/                    # microphone, playback, visible transcript/question UI
services/local-companion/   # API key, token minting, tool dispatcher, core-agent bridge
packages/protocol/          # typed question/tool schemas and event contracts
state/                      # ignored/encrypted local answer/session store
```

Prefer `@google/genai` and its typed Live messages/enums over hand-built WebSocket JSON. Keep a single receive loop alive, process every part in each server event, journal tool calls before side effects, and test reconnect at `GoAway`, abrupt disconnect, active tool execution, expired token, expired handle, and compressed context.

## Sources

- **Kept:** [Gemini 3.8 Live model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live) — canonical ID, stable status, limits, migration behavior.
- **Kept:** [Gemini 3.8 Live Extended Thinking](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live-extended-thinking) — alternate stable model and async-only constraints.
- **Kept:** [Live API capabilities](https://ai.google.dev/gemini-api/docs/live-api/capabilities) — current modalities, content updates, VAD, transcription, model comparison.
- **Kept:** [Tool use with Live API](https://ai.google.dev/gemini-api/docs/live-api/tools) — tool flow and async scheduling.
- **Kept:** [Session management](https://ai.google.dev/gemini-api/docs/live-api/session-management) — duration, compression, handles, GoAway.
- **Kept:** [Ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) — browser auth architecture and constraints.
- **Kept:** [Live WebSocket API reference](https://ai.google.dev/api/live) — normative messages, correlation, cancellation, expiry, and resumability caveats.
- **Kept:** [Google JS SDK types](https://github.com/googleapis/js-genai/blob/v2.18.0/src/types.ts) and [Live implementation](https://github.com/googleapis/js-genai/blob/v2.17.1/src/live.ts) — current enum and wire validation evidence.
- **Kept:** [Live best practices](https://ai.google.dev/gemini-api/docs/live-api/best-practices) — audio chunking, prompting, costs, and lifecycle guidance.
- **Dropped:** Google developer forum posts and third-party tutorials — excluded because the task requires primary docs/SDK sources and forum reports are not normative.
- **Dropped:** older 2.0/2.5 samples except where current docs explicitly compare migration — stale for the 3.8 design.

## Gaps and residual risks

- Google does not document an exhaustive field-by-field inventory of the server state represented by a resumption handle; only the resumable snapshot contract and known non-resumable periods are safe assumptions.
- Current 3.8-specific RPM/TPM/concurrency numbers are account/tier dependent and exposed in AI Studio, not fixed in the public guide; production sizing needs a billed-project quota check and load test.
- Tool selection and nondisclosure are probabilistic model behaviors. Application validation/redaction is mandatory where correctness or secrecy matters.
- “Local-only” remains ambiguous: the recommended app infrastructure can be local, but inference and any returned tool context leave the device for Google; a remote “external core agent” also breaks a strict on-device interpretation.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The brief records severity-tagged review findings for future repo areas and explicit residual risks, and was written to the authoritative artifact path."
    }
  ],
  "changedFiles": [
    "/Users/tim/.pi/agent/sessions/--Users-tim-repos-pi-setup--/subagent-artifacts/outputs/07d420a7-ce11-4b28-964d-0c6944d735e8/gemini-live-research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Primary-source web research via official Google Gemini API docs, API reference, and googleapis SDK source",
      "result": "passed",
      "summary": "Verified current model IDs/status, browser authentication, async tools, resumption, audio, limits, and security constraints."
    }
  ],
  "validationOutput": [
    "Artifact contains direct official URLs, documented-fact versus recommendation labels, severity-tagged review findings, and residual risks.",
    "No non-primary source is relied on for a finding."
  ],
  "residualRisks": [
    "Google does not specify an exhaustive resumption-snapshot inventory.",
    "3.8 quota values are project/tier dependent and require checking AI Studio.",
    "SILENT scheduling is not a secrecy guarantee and tool invocation remains probabilistic."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added a standalone primary-source research brief for a local Gemini 3.8 Live questionnaire voice-agent architecture.",
  "reviewFindings": [
    "high: future repo browser auth - never embed the long-lived Gemini API key; mint constrained ephemeral tokens from a loopback companion service.",
    "high: future repo persistence - native session handles expire after two hours and can lag active work; persist canonical questionnaire state locally.",
    "high: future repo hidden clarification - SILENT adds results to model context and cannot guarantee secrecy.",
    "medium: upstream docs - scheduling token and response-modality wording contain inconsistencies; use SDK enums and integration tests."
  ],
  "manualNotes": "Research was limited to official Google documentation, API reference, release/model pages, and googleapis SDK source as requested."
}
```
