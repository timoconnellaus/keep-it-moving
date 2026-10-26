/** The Worker's own pages: sign-in and errors, in the app's colours, light or dark. */
const shell = (body: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Keep it moving</title>
<link rel="icon" href="/icons/icon.svg">
<style>
  :root {
    --ink: #15181a; --muted: #5f676d; --line: #e1e4e3;
    --paper: #fff; --page: #f4f5f3; --accent: #0f6b62;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #e8ecea; --muted: #a3abb0; --line: #2c3236;
      --paper: #1c2023; --page: #15181a; --accent: #5cc2b5;
    }
  }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 16px; box-sizing: border-box; background: var(--page);
    color: var(--ink);
    font: 16px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  main {
    width: min(380px, 100%); box-sizing: border-box; padding: 32px 28px;
    border: 1px solid var(--line); border-radius: 12px; background: var(--paper);
    text-align: center;
  }
  h1 { margin: 12px 0 4px; font-size: 20px; font-weight: 600; }
  p { margin: 0 0 24px; color: var(--muted); }
  a { color: var(--accent); }
  .google {
    display: inline-flex; align-items: center; gap: 10px; padding: 10px 18px;
    border: 1px solid var(--line); border-radius: 8px; background: var(--paper);
    color: var(--ink); font-weight: 500; text-decoration: none;
  }
  .google:hover { border-color: var(--muted); }
</style>
<main>
<img src="/icons/icon.svg" alt="" width="40" height="40">
${body}
</main>
</html>`;

export const page = (status: number, message: string) =>
  new Response(shell(`<h1>Keep it moving</h1><p>${message}</p>`), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** Signed out: one button, which comes back to `next` afterwards. */
export const signInPage = (next: string) =>
  new Response(
    shell(`<h1>Keep it moving</h1>
<p>Sign in to see your projects.</p>
<a class="google" href="/auth/google/start?next=${encodeURIComponent(next)}">
<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
Sign in with Google</a>`),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
