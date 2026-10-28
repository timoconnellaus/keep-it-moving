/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveSocket, RETRY_MAX_MS } from "../src/web/liveSocket.js";

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event?: { code: number }) => void) | null = null;
  close = vi.fn();
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
}

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  hidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeSocket.instances.length = 0;
});

function open(status: number | null = 200) {
  const onStop = vi.fn();
  const probe = vi.fn(async () => status);
  const close = liveSocket({
    url: "ws://kim.test/ws/overview",
    probe,
    onMessage: () => undefined,
    onStop,
  });
  const latest = () => FakeSocket.instances.at(-1)!;
  return { onStop, probe, close, latest };
}

describe("live socket", () => {
  it("backs off exponentially, capped, and resets once connected", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { latest } = open();
    const gaps: number[] = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      const count = FakeSocket.instances.length;
      latest().onclose?.({ code: 1006 });
      let waited = 0;
      while (FakeSocket.instances.length === count) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      gaps.push(waited);
    }
    expect(gaps).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
    expect(Math.max(...gaps)).toBe(RETRY_MAX_MS);
    latest().onopen?.();
    latest().onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(11);
  });

  it("adds jitter so pages don't reconnect in step", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { latest } = open();
    latest().onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("waits while the tab is hidden and reconnects when it's shown", async () => {
    const { latest } = open();
    hidden = true;
    latest().onclose?.({ code: 1001 });
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS);
    expect(FakeSocket.instances).toHaveLength(1);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it.each([
    [4404, "deleted"],
    [1008, "unshared"],
  ])("stops on close code %i", async (code, reason) => {
    const { latest, onStop, probe } = open();
    latest().onclose?.({ code });
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS);
    expect(onStop).toHaveBeenCalledWith(reason);
    expect(probe).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it.each([
    [401, "signed-out"],
    [404, "deleted"],
    [403, "unshared"],
  ])("stops when the refused upgrade was a %i", async (status, reason) => {
    const { latest, onStop } = open(status);
    latest().onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(10 * RETRY_MAX_MS);
    expect(onStop).toHaveBeenCalledWith(reason);
    expect(FakeSocket.instances).toHaveLength(1);
    // Showing the tab again doesn't start it either.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("keeps retrying while the server can't be reached", async () => {
    const { latest, onStop } = open(null);
    latest().onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("closes and stops retrying when the page is done with it", async () => {
    const { latest, close } = open();
    const socket = latest();
    close();
    expect(socket.close).toHaveBeenCalled();
    socket.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
