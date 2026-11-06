# End-to-end encryption

Decided with Tim on 6 November 2026. Goal: the service stores and relays interviews it can't read. Only the people in an interview and their agents can.

## Decisions

- **What it protects against:** database and storage leaks, Cloudflare-side storage access, and us browsing data. It doesn't protect against a hostile code deploy: the web app's JavaScript comes from our Worker. The claim we make is "our servers only ever hold ciphertext", not "not even us".
- **Lost keys mean lost data.** A synced passkey unlocks new browsers, and a recovery code shown once at setup is the fallback. We hold no escrow.
- **The Jev prompt-injection check is dropped.** Text that crosses between two people's agents is always fenced as untrusted data instead.
- **Screenshots render on the agent's machine.** Shipped in `b2b5c2e`, so the service no longer reads artifacts to render them.

## What's encrypted, and what isn't

Encrypted: interview titles, project names, question prompts, options, recommendations, defaults, control bindings, answers, drafts, chat, artifact titles, descriptions, content and source, and every event payload that carries any of these.

In the clear, so waiting state, limits, push and the home list's order still work: ids, tokens, question types, status, counts, who wrote what (owner, assignee, agent), timestamps, revision numbers, sizes, frame positions, assignee emails and the project's git remote key. (The remote is used to group interviews. We could hash it later.)

## Crypto

- WebCrypto everywhere: the browser and Node have the same API.
- **Interview key:** a random AES-256-GCM key per interview, made by whoever creates it.
- **Field envelope:** `k1.<base64url(iv ‖ ciphertext)>`. The AAD is `interviewId/table/column/rowId`, so the server can't move a ciphertext to another field or interview without decryption failing.
- **Account key pair:** ECDH P-256 per user. P-256 rather than X25519 because every browser we support has it. An interview key is wrapped to a public key with ECIES (ephemeral ECDH, HKDF-SHA-256, AES-GCM).
- **Unlocking the private key:** it's stored on the server encrypted under each unlock method:
  - a passkey, via the WebAuthn PRF extension (one blob per passkey);
  - the recovery code, 128 random bits shown as words (HKDF is enough at that entropy).
- **The CLI:** `kim login` already ends on a loopback `http://127.0.0.1` redirect. The signed-in browser posts the private key straight to the CLI there, and it never touches our server. The CLI keeps it in its credentials file (0600).
- **Agent keys (cloud):** `kim cloud setup` adds the private key as `KEEP_IT_MOVING_CONTENT_KEY`. That's the same scope a key has today: a leaked key exposes the workspace.

## Server changes

- Store key material in the hub: wrapped private-key blobs, the public key, and per-interview wrapped keys, one per member.
- A public-key directory in KV (`pubkey:<email>`), which owners look up when they assign.
- `sessions.encrypted`: new interviews are encrypted once their owner has set up. Older interviews stay plaintext and keep working: no destructive migrations.
- Make every content-reading path content-agnostic for encrypted interviews:
  - the artifact view route and `renderArtifact`, which move to the browser;
  - the accept-defaults comparison (`hub.ts:1407`), which the client computes;
  - size checks, which count the ciphertext;
  - `forBrowser`, which passes ciphertext through.
- A CLI build header (`x-kim-build`). Older `kim` builds get a 426 asking them to update on encrypted interviews, so they can't write plaintext into one.

## Browser changes

- **Setup:** offered on first sign-in after launch. Create the key pair, register a passkey with PRF, and show the recovery code once, asking the user to confirm they've saved it.
- **Unlock:** on a new browser, a passkey prompt, or the recovery code. The unlocked key is kept in IndexedDB as a non-extractable CryptoKey.
- **Reading:** a decrypt layer between the socket and React state. It decrypts each field once, cached by ciphertext.
- **Writing:** answers, drafts and chat are encrypted before they're sent.
- **HTML artifacts:** decrypted, given the control values, and loaded into an `<iframe srcdoc sandbox="allow-scripts">`. That also closes the security review's leftover artifact-phishing risk.

## Assignment

- The owner's client looks up `pubkey:<assignee>` and wraps the interview key to it.
- If the assignee hasn't set up yet, the grant is pending. Any of the owner's clients that holds the interview key (browser or CLI) completes it once the assignee's public key exists. Meanwhile the assignee sees "waiting for the sender to share access".
- `kim inbox` unwraps with the assignee's private key.

## Phases

1. **Crypto core:** `src/shared/crypto.ts` (envelopes, ECIES, recovery code), with tests that run in Node and jsdom.
2. **Keys:** browser setup and unlock (passkey PRF, recovery code), hub key storage, the public-key directory, the login handoff to the CLI, and the cloud content key.
3. **Encrypted interviews:** CLI encrypt on write and decrypt on read (`session`, `question`, `plan`, `artifact`, `chat`, `wait`, hooks), the browser decrypt layer and srcdoc frames, content-agnostic server paths, and the CLI build gate.
4. **Assignment:** grants, pending grants and the inbox.
5. **Ship:** the marketing page's encryption section and fine print (what the server still sees, lost keys mean lost data), README, a security-review addendum. Then deploy.

## Open risks

- **PRF support:** passkey PRF is in Chrome, Safari 18+ and Firefox 135+, but some password managers don't support it. Without PRF, the recovery code is the way in. Recheck support before building.
- **Two code paths for good:** plaintext and encrypted interviews both have to keep working.
- **No server-side search** or content-based admin support, ever. Support can't see content.
