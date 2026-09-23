import { describe, expect, it } from "vitest";
import { GoogleGenAI, Modality } from "@google/genai";
import { mintGeminiToken } from "../src/server/app.js";

const enabled =
  process.env.GEMINI_SMOKE === "1" && Boolean(process.env.GEMINI_API_KEY);
describe.skipIf(!enabled)("Gemini Live real smoke", () => {
  it("mints a constrained token and opens the configured Live model", async () => {
    const token = await mintGeminiToken(process.env.GEMINI_API_KEY!);
    expect(token.name).toBeTruthy();
    const ai = new GoogleGenAI({
      apiKey: token.name!,
      httpOptions: { apiVersion: "v1alpha" },
    });
    await new Promise<void>((resolve, reject) => {
      let live: Awaited<ReturnType<typeof ai.live.connect>> | undefined;
      const timer = setTimeout(
        () => reject(new Error("Gemini Live connection timed out")),
        15_000,
      );
      void ai.live
        .connect({
          model: "gemini-3.8-live",
          config: { responseModalities: [Modality.AUDIO] },
          callbacks: {
            onopen: () => {
              clearTimeout(timer);
              live?.close();
              resolve();
            },
            onmessage: () => undefined,
            onerror: (event) => {
              clearTimeout(timer);
              reject(event.error ?? new Error(event.message));
            },
          },
        })
        .then((session) => {
          live = session;
        })
        .catch(reject);
    });
  }, 20_000);
});
