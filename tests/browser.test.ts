import { describe, expect, it } from "vitest";
import {
  browserCandidates,
  findBrowser,
  launchArgs,
  NO_BROWSER,
  type BrowserSearch,
} from "../src/browser.js";

/** A machine with exactly these files, and these folders' entries. */
const machine = (
  platform: NodeJS.Platform,
  files: string[],
  options: {
    env?: Record<string, string>;
    folders?: Record<string, string[]>;
  } = {},
): BrowserSearch => ({
  platform,
  env: options.env ?? {},
  home: platform === "win32" ? "C:\\Users\\ann" : "/home/ann",
  exists: (path) => files.includes(path),
  list: (dir) => options.folders?.[dir] ?? [],
});

const MAC_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("finding a browser to take screenshots", () => {
  it("prefers CHROME_PATH, and says when it points nowhere", () => {
    expect(
      findBrowser(
        machine("darwin", [MAC_CHROME, "/opt/edge"], {
          env: { CHROME_PATH: "/opt/edge" },
        }),
      ),
    ).toBe("/opt/edge");
    expect(() =>
      findBrowser(machine("darwin", [], { env: { CHROME_PATH: "/opt/none" } })),
    ).toThrow(/CHROME_PATH is \/opt\/none, which doesn't exist/);
  });

  it("finds Chrome, then Chromium and Edge, in the usual places on macOS", () => {
    expect(findBrowser(machine("darwin", [MAC_CHROME]))).toBe(MAC_CHROME);
    const edge =
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    expect(findBrowser(machine("darwin", [edge]))).toBe(edge);
    const own = "/home/ann/Applications/Chromium.app/Contents/MacOS/Chromium";
    expect(findBrowser(machine("darwin", [own]))).toBe(own);
  });

  it("finds the newest Chrome for Testing that Playwright installed", () => {
    const cache = "/home/ann/Library/Caches/ms-playwright";
    const newest = `${cache}/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    const older = `${cache}/chromium-1100/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
    expect(
      findBrowser(
        machine("darwin", [older, newest], {
          folders: {
            [cache]: ["chromium-1100", "ffmpeg-1010", "chromium-1228"],
          },
        }),
      ),
    ).toBe(newest);
  });

  it("looks on the PATH on Linux, and in Program Files on Windows", () => {
    expect(
      findBrowser(
        machine("linux", ["/usr/bin/chromium"], {
          env: { PATH: "/usr/local/bin:/usr/bin" },
        }),
      ),
    ).toBe("/usr/bin/chromium");
    const edge =
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(
      findBrowser(
        machine("win32", [edge], {
          env: {
            PROGRAMFILES: "C:\\Program Files",
            "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
          },
        }),
      ),
    ).toBe(edge);
    expect(browserCandidates(machine("win32", [], { env: {} }))).toEqual([]);
  });

  it("finds none on a machine without one, and the message says what to do instead", () => {
    expect(
      findBrowser(machine("linux", [], { env: { PATH: "/usr/bin" } })),
    ).toBe(null);
    expect(NO_BROWSER).toMatch(/CHROME_PATH/);
    expect(NO_BROWSER).toMatch(/kim inbox artifact/);
  });
});

describe("the headless browser", () => {
  it("starts in a throwaway profile with DevTools on a port it picks, holding no secrets", () => {
    const args = launchArgs("/tmp/profile");
    expect(args).toEqual(
      expect.arrayContaining([
        "--headless=new",
        "--user-data-dir=/tmp/profile",
        "--remote-debugging-port=0",
      ]),
    );
    // Never a keychain or sync prompt on the user's desktop.
    expect(args).toEqual(
      expect.arrayContaining([
        "--use-mock-keychain",
        "--password-store=basic",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
      ]),
    );
    // The page arrives later, as a local file: no URL or token on the command line.
    expect(args.join(" ")).not.toMatch(/token|bearer|https?:/i);
  });
});
