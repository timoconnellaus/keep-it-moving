import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const live = {
    sendClientContent: vi.fn(),
    sendRealtimeInput: vi.fn(),
    sendToolResponse: vi.fn(),
    close: vi.fn(),
  };
  return {
    live,
    callbacks: undefined as
      | {
          onmessage(message: unknown): void;
          onclose?(): void;
        }
      | undefined,
    connect: vi.fn(async (parameters: { callbacks: typeof fake.callbacks }) => {
      fake.callbacks = parameters.callbacks;
      return live;
    }),
  };
});

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    live = { connect: fake.connect };
  },
  Modality: { AUDIO: "AUDIO" },
  FunctionResponseScheduling: {
    SILENT: "SILENT",
    WHEN_IDLE: "WHEN_IDLE",
    INTERRUPT: "INTERRUPT",
  },
}));

import { GeminiVoice } from "../src/web/gemini.js";
import type { SessionView } from "../src/shared/schema.js";

const session: SessionView = {
  id: "s1",
  title: "Todo interview",
  token: "token",
  status: "active",
  url: "http://local/s/token",
  createdAt: "",
  updatedAt: "",
  focusedQuestionId: null,
  focusedQuestionIds: [],
  focusSource: null,
  questions: [],
  clarifications: [],
  notes: [],
  artifacts: [],
  stage: null,
  voice: { transcript: [], resumptionHandle: null },
};

const workletNodes: FakeWorkletNode[] = [];
const lastNode = () => workletNodes.at(-1);

class FakeWorkletNode {
  port = { onmessage: null as ((event: MessageEvent) => void) | null };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor() {
    workletNodes.push(this);
  }
}

class FakeAudioContext {
  currentTime = 0;
  sampleRate: number;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  close = vi.fn(async () => undefined);
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48_000;
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createBuffer(_channels: number, length: number) {
    return {
      duration: length / 24_000,
      getChannelData: () => new Float32Array(length),
    };
  }
  createBufferSource() {
    return { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
  }
}

const hooks = () => ({ onState: vi.fn(), onError: vi.fn(), refresh: vi.fn() });
const clientTexts = () =>
  fake.live.sendClientContent.mock.calls.map(
    ([params]: [
      {
        turns: Array<{ parts: Array<{ text: string }> }>;
        turnComplete: boolean;
      },
    ]) => ({
      text: params.turns[0]!.parts[0]!.text,
      turnComplete: params.turnComplete,
    }),
  );

beforeEach(() => {
  fake.connect.mockClear();
  fake.live.close.mockClear();
  fake.live.sendClientContent.mockClear();
  fake.live.sendRealtimeInput.mockClear();
  fake.live.sendToolResponse.mockClear();
  fake.connect.mockImplementation(
    async (parameters: { callbacks: typeof fake.callbacks }) => {
      fake.callbacks = parameters.callbacks;
      return fake.live;
    },
  );
  fake.callbacks = undefined;
  workletNodes.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  const tracks = [{ stop: vi.fn() }];
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => tracks })),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "ephemeral",
        model: "gemini-3.8-live",
        resumptionHandle: null,
      }),
    })),
  );
});

describe("Gemini continuity adapter", () => {
  it("lets Gemini choose how to initiate when the microphone starts", async () => {
    const voice = new GeminiVoice("token", structuredClone(session), {
      onState: vi.fn(),
      onError: vi.fn(),
      refresh: vi.fn(),
    });
    expect(await voice.start()).toBe(true);
    expect(fake.live.sendClientContent).toHaveBeenCalledWith(
      expect.objectContaining({ turnComplete: true }),
    );
    await voice.stop();
  });

  it("reconnects after a Live close while the microphone remains active", async () => {
    const voice = new GeminiVoice("token", structuredClone(session), {
      onState: vi.fn(),
      onError: vi.fn(),
      refresh: vi.fn(),
    });
    expect(await voice.start()).toBe(true);
    expect(fake.connect).toHaveBeenCalledTimes(1);
    fake.callbacks?.onclose?.();
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(2));
    await voice.stop();
  });

  it("streams 16 kHz PCM chunks and stops as soon as the Live socket closes", async () => {
    const voice = new GeminiVoice("token", structuredClone(session), hooks());
    expect(await voice.start()).toBe(true);
    expect(lastNode()?.port.onmessage).toBeTypeOf("function");
    lastNode()!.port.onmessage!({
      data: new Float32Array(640),
    } as MessageEvent);
    expect(fake.live.sendRealtimeInput).toHaveBeenCalledWith({
      audio: expect.objectContaining({ mimeType: "audio/pcm;rate=16000" }),
    });
    fake.live.sendRealtimeInput.mockClear();

    fake.callbacks?.onclose?.();
    lastNode()!.port.onmessage!({
      data: new Float32Array(640),
    } as MessageEvent);

    expect(fake.live.sendRealtimeInput).not.toHaveBeenCalled();
    await voice.stop();
  });

  it("announces questionnaire changes silently, only once Gemini finishes talking", async () => {
    const voice = new GeminiVoice("token", structuredClone(session), hooks());
    await voice.start();
    fake.callbacks?.onmessage({ serverContent: { turnComplete: true } });
    fake.live.sendClientContent.mockClear();
    fake.callbacks?.onmessage({
      serverContent: { outputTranscription: { text: "Let's start" } },
    });

    const updated = structuredClone(session);
    updated.questions = [
      {
        id: "q-new",
        type: "text",
        prompt: "What does success look like?",
        recommendation: null,
        default: null,
        options: [],
        min: null,
        max: null,
        step: null,
        position: 0,
        artifactId: null,
        optionArtifacts: {},
        answer: null,
      },
    ];
    voice.updateSession(updated);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fake.live.sendClientContent).not.toHaveBeenCalled();

    fake.callbacks?.onmessage({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(clientTexts()).toHaveLength(1));
    expect(clientTexts()[0]).toEqual({
      text: expect.stringContaining(
        'Added #1 id=q-new text: "What does success look like?"',
      ),
      turnComplete: false,
    });
    await voice.stop();
  });

  it("stores whole utterances and refreshes state only after tool calls", async () => {
    const refresh = vi.fn();
    const voice = new GeminiVoice("token", structuredClone(session), {
      ...hooks(),
      refresh,
    });
    await voice.start();
    for (const text of ["Keep ", "the defaults"])
      fake.callbacks?.onmessage({
        serverContent: { inputTranscription: { text } },
      });
    fake.callbacks?.onmessage({
      serverContent: { outputTranscription: { text: "Done." } },
    });
    fake.callbacks?.onmessage({ serverContent: { turnComplete: true } });
    await vi.waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([url]) => url === "/api/browser/token/voice")
          .map(([, init]) => JSON.parse(String(init?.body))),
      ).toEqual([
        { role: "user", text: "Keep the defaults" },
        { role: "model", text: "Done." },
      ]),
    );
    expect(refresh).not.toHaveBeenCalled();

    fake.callbacks?.onmessage({
      toolCall: {
        functionCalls: [
          { id: "c1", name: "focus_questions", args: { question_ids: [] } },
        ],
      },
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await voice.stop();
  });

  it("persists resumable handles and closes on GoAway so reconnect can begin", async () => {
    const voice = new GeminiVoice("token", structuredClone(session), {
      onState: vi.fn(),
      onError: vi.fn(),
      refresh: vi.fn(),
    });
    await voice.start();
    fake.callbacks?.onmessage({
      sessionResumptionUpdate: { resumable: true, newHandle: "resume-1" },
    });
    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/browser/token/voice",
        expect.objectContaining({
          body: JSON.stringify({ resumptionHandle: "resume-1" }),
        }),
      ),
    );
    fake.callbacks?.onmessage({ goAway: { timeLeft: "5s" } });
    expect(fake.live.close).toHaveBeenCalled();
    await voice.stop();
  });

  it("delivers a clarification answered while voice was stopped after resuming", async () => {
    const resumed = structuredClone(session);
    resumed.voice.resumptionHandle = "resume-1";
    resumed.clarifications = [
      {
        id: "request-1",
        questionId: "question-1",
        callId: "call-1",
        request: "What does this mean?",
        response: "Use the compact interpretation.",
        status: "answered",
      },
    ];
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: "ephemeral",
        model: "gemini-3.8-live",
        resumptionHandle: "resume-1",
      }),
    } as Response);
    const voice = new GeminiVoice("token", resumed, {
      onState: vi.fn(),
      onError: vi.fn(),
      refresh: vi.fn(),
    });
    expect(await voice.start()).toBe(true);
    expect(fake.live.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [
        expect.objectContaining({
          id: "call-1",
          name: "request_clarification",
          response: { output: "Use the compact interpretation." },
        }),
      ],
    });
    await voice.stop();
  });

  it("falls back to a fresh session when a saved resumption handle is rejected", async () => {
    const resumed = structuredClone(session);
    resumed.voice.resumptionHandle = "expired-handle";
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ephemeral-1",
          model: "gemini-3.8-live",
          resumptionHandle: "expired-handle",
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "ephemeral-2",
          model: "gemini-3.8-live",
          resumptionHandle: null,
        }),
      } as Response);
    fake.connect.mockRejectedValueOnce(new Error("invalid resumption handle"));
    const voice = new GeminiVoice("token", resumed, {
      onState: vi.fn(),
      onError: vi.fn(),
      refresh: vi.fn(),
    });
    expect(await voice.start()).toBe(true);
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      "/api/browser/token/voice",
      expect.objectContaining({
        body: JSON.stringify({ resumptionHandle: null }),
      }),
    );
    await voice.stop();
  });

  it("shows Gemini a picture of the diagram or mockup on screen", async () => {
    const staged = structuredClone(session);
    staged.artifacts = [
      {
        id: "m1",
        kind: "mockup",
        format: "html",
        title: "Layout A",
        content: "<main></main>",
        size: 13,
        description: "Sidebar navigation",
        revision: 1,
        updatedAt: "",
      },
      {
        id: "m2",
        kind: "mockup",
        format: "html",
        title: "Layout B",
        content: "<main></main>",
        size: 13,
        description: "Board",
        revision: 1,
        updatedAt: "",
      },
    ];
    const picture = { mimeType: "image/jpeg" as const, data: "abc" };
    const captureStage = vi.fn(async () => picture);
    const voice = new GeminiVoice("token", structuredClone(staged), {
      ...hooks(),
      captureStage,
    });
    await voice.start();
    const opening = fake.live.sendClientContent.mock.calls[0]![0];
    expect(opening.turns[0].parts[1]).toEqual({ inlineData: picture });

    fake.callbacks?.onmessage({ serverContent: { turnComplete: true } });
    fake.live.sendClientContent.mockClear();
    const switched = structuredClone(staged);
    switched.stage = { artifactId: "m2", source: "user" };
    voice.updateSession(switched);
    await vi.waitFor(() =>
      expect(fake.live.sendClientContent).toHaveBeenCalledTimes(1),
    );
    const update = fake.live.sendClientContent.mock.calls[0]![0];
    expect(update.turnComplete).toBe(false);
    expect(update.turns[0].parts[0].text).toContain(
      'On screen: mockup "Layout B" (id=m2), put there by the user.',
    );
    expect(update.turns[0].parts[1]).toEqual({ inlineData: picture });
    expect(captureStage).toHaveBeenCalledTimes(2);
    await voice.stop();
  });
});
