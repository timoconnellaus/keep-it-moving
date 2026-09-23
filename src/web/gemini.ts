import {
  GoogleGenAI,
  Modality,
  type LiveServerMessage,
  type Session,
} from "@google/genai";
import type { SessionView } from "../shared/schema.js";
import {
  describeChanges,
  describeQuestionnaire,
  recordOwnAnswers,
  shownIsVisual,
  snapshotQuestionnaire,
  type QuestionnaireSnapshot,
} from "./geminiContext.js";
import {
  cancelToolCalls,
  deliverClarification,
  dispatchToolCall,
  plannedAnswers,
} from "./geminiProtocol.js";
import { GEMINI_INPUT_RATE, MicCapture } from "./micCapture.js";
import type { StageImage } from "./stageCapture.js";

/** Gemini Live returns 16-bit PCM at 24 kHz. */
const GEMINI_OUTPUT_RATE = 24_000;
/** How long to hold context updates after the user speaks, awaiting Gemini's reply. */
const REPLY_GRACE_MS = 4_000;
/** Upper bound on one model turn, in case turnComplete never arrives. */
const MODEL_TURN_MS = 15_000;

interface GeminiHooks {
  onState(state: "connecting" | "listening" | "off" | "error"): void;
  onError(message: string): void;
  refresh(): void;
  /** A picture of the diagram or mockup on screen, when there is one. */
  captureStage?(): Promise<StageImage | null>;
}

export class GeminiVoice {
  private live: Session | null = null;
  private liveGeneration = 0;
  private playback: AudioContext | null = null;
  private microphone: MediaStream | null = null;
  private capture: MicCapture | null = null;
  private nextPlayback = 0;
  private readonly playbackSources = new Set<AudioBufferSourceNode>();
  private session: SessionView;
  private reconnecting = false;
  private answeredClarifications: Set<string>;
  /** What Gemini has been told; updates describe the difference. */
  private known: QuestionnaireSnapshot | null = null;
  /**
   * Client content interrupts any generation in progress, so context updates
   * wait until this time: past the model's turn and any reply it owes the user.
   */
  private quietAfter = 0;
  private contextTimer: ReturnType<typeof setTimeout> | null = null;
  private contextDue = 0;
  private sendingContext = false;
  private userText = "";
  private modelText = "";
  /** Network calls triggered by server messages, run in arrival order. */
  private tasks: Promise<void> = Promise.resolve();

  constructor(
    private readonly token: string,
    session: SessionView,
    private readonly hooks: GeminiHooks,
  ) {
    this.session = session;
    this.answeredClarifications = new Set();
  }

  async start(): Promise<boolean> {
    this.hooks.onState("connecting");
    try {
      this.microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      this.playback = new AudioContext();
      await this.connect(true);
      this.capture = new MicCapture(this.microphone, (pcm) =>
        this.sendAudio(pcm),
      );
      await this.capture.start();
      this.hooks.onState("listening");
      return true;
    } catch (error) {
      this.hooks.onState("error");
      this.hooks.onError(
        error instanceof Error ? error.message : String(error),
      );
      await this.stop();
      return false;
    }
  }

  async stop(): Promise<void> {
    const capture = this.capture;
    this.capture = null;
    await capture?.stop();
    this.microphone?.getTracks().forEach((track) => track.stop());
    this.microphone = null;
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextTimer = null;
    this.flushTranscript();
    await this.tasks;
    const live = this.live;
    this.live = null;
    this.liveGeneration += 1;
    live?.close();
    this.stopPlayback();
    if (this.playback) await this.playback.close().catch(() => undefined);
    this.playback = null;
    this.hooks.onState("off");
  }

  updateSession(session: SessionView): void {
    this.session = session;
    if (this.live) this.scheduleContextUpdate();
    for (const clarification of session.clarifications) {
      if (
        clarification.status === "answered" &&
        clarification.response &&
        !this.answeredClarifications.has(clarification.callId)
      ) {
        this.answeredClarifications.add(clarification.callId);
        if (this.live) deliverClarification(clarification, this.live);
      }
    }
    if (session.status === "stopped") void this.stop();
  }

  private async connect(initiate: boolean): Promise<void> {
    let auth = await this.fetchToken();
    try {
      this.live = await this.openLive(auth);
    } catch (error) {
      if (!auth.resumptionHandle) throw error;
      await this.postVoice({ resumptionHandle: null });
      this.session = {
        ...this.session,
        voice: { ...this.session.voice, resumptionHandle: null },
      };
      auth = await this.fetchToken();
      this.live = await this.openLive(auth);
    }
    await this.sendQuestionnaireContext(!auth.resumptionHandle, initiate);
    if (auth.resumptionHandle) {
      for (const clarification of this.session.clarifications) {
        if (
          clarification.status === "answered" &&
          clarification.response &&
          !this.answeredClarifications.has(clarification.callId)
        ) {
          this.answeredClarifications.add(clarification.callId);
          deliverClarification(clarification, this.live);
        }
      }
    } else {
      for (const clarification of this.session.clarifications) {
        if (clarification.status === "answered")
          this.answeredClarifications.add(clarification.callId);
      }
    }
  }

  private async fetchToken(): Promise<{
    token: string;
    model: string;
    resumptionHandle: string | null;
  }> {
    const response = await fetch(`/api/browser/${this.token}/gemini-token`, {
      method: "POST",
    });
    if (!response.ok)
      throw new Error(
        ((await response.json()) as { error?: string }).error ??
          "Could not start voice",
      );
    return (await response.json()) as {
      token: string;
      model: string;
      resumptionHandle: string | null;
    };
  }

  private async openLive(auth: {
    token: string;
    model: string;
    resumptionHandle: string | null;
  }): Promise<Session> {
    const generation = ++this.liveGeneration;
    const ai = new GoogleGenAI({
      apiKey: auth.token,
      httpOptions: { apiVersion: "v1alpha" },
    });
    return ai.live.connect({
      model: auth.model,
      config: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        sessionResumption: auth.resumptionHandle
          ? { handle: auth.resumptionHandle }
          : {},
      },
      callbacks: {
        onmessage: (message) => {
          if (generation === this.liveGeneration) this.handleMessage(message);
        },
        onerror: (event) => {
          if (generation === this.liveGeneration)
            this.hooks.onError(event.message || "Voice connection error");
        },
        onclose: () => {
          if (generation !== this.liveGeneration) return;
          this.live = null;
          void this.reconnect();
        },
      },
    });
  }

  private async reconnect(): Promise<void> {
    if (!this.microphone || this.reconnecting) return;
    this.reconnecting = true;
    this.flushTranscript();
    this.quietAfter = 0;
    this.hooks.onState("connecting");
    try {
      await this.connect(false);
      this.hooks.onState("listening");
    } catch (error) {
      this.hooks.onError(
        error instanceof Error ? error.message : String(error),
      );
      this.hooks.onState("error");
    } finally {
      this.reconnecting = false;
    }
  }

  private async sendQuestionnaireContext(
    restoringFreshSession: boolean,
    initiate: boolean,
  ): Promise<void> {
    if (!this.live) return;
    const history = restoringFreshSession
      ? this.session.voice.transcript.slice(-20)
      : [];
    const clarifications = restoringFreshSession
      ? this.session.clarifications
          .filter((item) => item.status === "answered" && item.response)
          .slice(-20)
          .map((item) => ({
            questionId: item.questionId,
            request: item.request,
            response: item.response,
          }))
      : [];
    const session = this.session;
    const image = shownIsVisual(session) ? await this.captureStage() : null;
    if (!this.live) return;
    this.known = snapshotQuestionnaire(session);
    this.live.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [
            {
              text: `${describeQuestionnaire(session)}${history.length ? `\nRecent conversation:\n${JSON.stringify(history)}` : ""}${clarifications.length ? `\nPrior clarification context:\n${JSON.stringify(clarifications)}` : ""}${initiate ? "\nThe user just turned on voice." : ""}`,
            },
            ...imageParts(image),
          ],
        },
      ],
      turnComplete: initiate,
    });
    // Gemini owes a reply to a completed turn; don't cut it off with updates.
    if (initiate) this.quietAfter = Date.now() + REPLY_GRACE_MS;
  }

  /** Debounces updates; an earlier request replaces a later pending one. */
  private scheduleContextUpdate(delay = 250): void {
    const due = Date.now() + delay;
    if (this.contextTimer && this.contextDue <= due) return;
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextDue = due;
    this.contextTimer = setTimeout(() => {
      this.contextTimer = null;
      void this.sendContextUpdate();
    }, delay);
  }

  /**
   * Tells Gemini what changed without making it talk: turnComplete false adds
   * context without prompting a reply, and waiting for quiet avoids cutting
   * off speech. Notes sent with --speak prompt a reply once it is quiet. A
   * newly shown diagram or mockup goes along as a picture.
   */
  private async sendContextUpdate(): Promise<void> {
    if (!this.live || !this.known) return;
    const wait = this.quietAfter - Date.now();
    if (wait > 0) return this.scheduleContextUpdate(wait + 50);
    if (this.sendingContext) return this.scheduleContextUpdate(250);
    const session = this.session;
    const update = describeChanges(this.known, session);
    if (!update) return;
    this.sendingContext = true;
    try {
      this.known = snapshotQuestionnaire(session);
      const image = update.showImage ? await this.captureStage() : null;
      if (!this.live) return;
      this.live.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [{ text: update.text }, ...imageParts(image)],
          },
        ],
        turnComplete: update.speak,
      });
      if (update.speak) this.quietAfter = Date.now() + REPLY_GRACE_MS;
    } finally {
      this.sendingContext = false;
    }
  }

  private async captureStage(): Promise<StageImage | null> {
    try {
      return (await this.hooks.captureStage?.()) ?? null;
    } catch {
      return null;
    }
  }

  private sendAudio(pcm: Int16Array): void {
    if (!this.live || !pcm.length) return;
    this.live.sendRealtimeInput({
      audio: {
        data: bytesToBase64(
          new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        ),
        mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}`,
      },
    });
  }

  /**
   * Applies a server message synchronously, so state stays consistent when
   * messages arrive faster than network calls finish; those calls are queued
   * in order instead.
   */
  private handleMessage(message: LiveServerMessage): void {
    if (message.goAway) {
      const live = this.live;
      this.live = null;
      live?.close();
      return;
    }
    const handle = message.sessionResumptionUpdate;
    if (handle?.resumable && handle.newHandle) {
      const resumptionHandle = handle.newHandle;
      this.enqueue(() => this.postVoice({ resumptionHandle }));
    }
    const content = message.serverContent;
    const now = Date.now();
    const inputText = content?.inputTranscription?.text;
    if (inputText) {
      this.userText += inputText;
      this.quietAfter = Math.max(this.quietAfter, now + REPLY_GRACE_MS);
    }
    const outputText = content?.outputTranscription?.text;
    const audioParts = (content?.modelTurn?.parts ?? []).filter(
      (part) => part.inlineData?.data,
    );
    if (outputText || audioParts.length) {
      this.flushTranscript("user");
      this.quietAfter = Math.max(this.quietAfter, now + MODEL_TURN_MS);
    }
    if (outputText) this.modelText += outputText;
    if (content?.interrupted) {
      this.stopPlayback();
      this.flushTranscript("model");
      // The user barged in, so a reply is on its way.
      this.quietAfter = now + REPLY_GRACE_MS;
    }
    for (const part of audioParts) this.playAudio(part.inlineData!.data!);
    if (content?.turnComplete) {
      this.flushTranscript();
      this.quietAfter = now;
      this.scheduleContextUpdate();
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      const live = this.live;
      if (!live || !call.id || !call.name) continue;
      const toolCall = { id: call.id, name: call.name, args: call.args ?? {} };
      const session = this.session;
      if (this.known)
        recordOwnAnswers(this.known, plannedAnswers(toolCall, session));
      this.enqueue(async () => {
        await dispatchToolCall(this.token, toolCall, live, session);
        this.hooks.refresh();
      });
    }
    const cancelled = message.toolCallCancellation?.ids ?? [];
    if (cancelled.length)
      this.enqueue(async () => {
        await cancelToolCalls(this.token, cancelled);
        this.hooks.refresh();
      });
  }

  private enqueue(task: () => Promise<void>): void {
    this.tasks = this.tasks.then(task).catch((error: unknown) => {
      this.hooks.onError(
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  /** Stores whole utterances rather than transcription fragments. */
  private flushTranscript(only?: "user" | "model"): void {
    if (only !== "model" && this.userText.trim()) {
      const text = this.userText;
      this.userText = "";
      this.enqueue(() => this.postVoice({ role: "user", text }));
    }
    if (only !== "user" && this.modelText.trim()) {
      const text = this.modelText;
      this.modelText = "";
      this.enqueue(() => this.postVoice({ role: "model", text }));
    }
  }

  private stopPlayback(): void {
    for (const source of this.playbackSources) source.stop();
    this.playbackSources.clear();
    this.nextPlayback = this.playback?.currentTime ?? 0;
  }

  private playAudio(base64: string): void {
    const context = this.playback;
    if (!context) return;
    const bytes = base64ToBytes(base64);
    const samples = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.floor(bytes.byteLength / 2),
    );
    const buffer = context.createBuffer(1, samples.length, GEMINI_OUTPUT_RATE);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++)
      output[i] = (samples[i] ?? 0) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    this.playbackSources.add(source);
    source.onended = () => this.playbackSources.delete(source);
    const start = Math.max(context.currentTime, this.nextPlayback);
    source.start(start);
    this.nextPlayback = start + buffer.duration;
  }

  private async postVoice(body: Record<string, unknown>): Promise<void> {
    await fetch(`/api/browser/${this.token}/voice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

function imageParts(image: StageImage | null) {
  return image ? [{ inlineData: image }] : [];
}
function bytesToBase64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
