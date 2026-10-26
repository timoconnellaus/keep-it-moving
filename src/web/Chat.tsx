import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessageView, SessionView } from "../shared/schema.js";

/** Whether the chat is open, and the question the next message is about. */
export function useChat() {
  const [open, setOpen] = useState(false);
  const [about, setAbout] = useState<string | null>(null);
  const ask = useCallback((questionId: string | null) => {
    setAbout(questionId);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return { open, about, setAbout, ask, close };
}
export type ChatState = ReturnType<typeof useChat>;

/**
 * One chat with the agent for the whole interview: clarifications about the
 * interview or a question, and directions. The agent answers when its `wait`
 * returns, so the thread says whether anyone is watching.
 */
export function Chat({
  token,
  session,
  chat,
  onSent,
}: {
  token: string;
  session: SessionView;
  chat: ChatState;
  onSent(): Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const replies = session.chat.filter(
    (message) => message.author === "agent",
  ).length;
  // Replies that arrived while the chat was closed get a dot on the button.
  const [seen, setSeen] = useState(replies);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const active = session.status === "active";

  useEffect(() => {
    if (chat.open) setSeen(replies);
  }, [chat.open, replies]);
  useEffect(() => {
    if (chat.open && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [chat.open, session.chat.length]);
  useEffect(() => {
    if (chat.open) input.current?.focus();
  }, [chat.open, chat.about]);

  const numbered = (questionId: string) => {
    const index = session.questions.findIndex(
      (question) => question.id === questionId,
    );
    return index < 0
      ? null
      : { number: index + 1, prompt: session.questions[index]!.prompt };
  };
  const attached = chat.about ? numbered(chat.about) : null;

  const send = async () => {
    const message = text.trim();
    if (!message || sending || !active) return;
    setSending(true);
    setError("");
    try {
      const response = await fetch(`/api/browser/${token}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message, questionId: chat.about }),
      });
      if (!response.ok)
        throw new Error(
          ((await response.json()) as { error?: string }).error ??
            "Could not send",
        );
      setText("");
      chat.setAbout(null);
      await onSent();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };

  if (!chat.open)
    return active || session.chat.length ? (
      <button
        type="button"
        className="chat-launcher"
        onClick={() => chat.ask(null)}
        title="Ask the agent a question, or give it a direction"
      >
        Ask the agent
        {replies > seen && (
          <span className="chat-unread" aria-label="New reply" />
        )}
      </button>
    ) : null;

  const last = session.chat.at(-1);
  const pending = last?.author === "user" ? last : null;
  return (
    <aside
      className="chat"
      aria-label="Chat with the agent"
      onKeyDown={(event) => {
        if (event.key === "Escape") chat.close();
      }}
    >
      <header className="chat-header">
        <div>
          <h2>Chat with the agent</h2>
          <span
            className={`chat-presence ${session.agentWatching ? "on" : ""}`}
          >
            {session.agentWatching ? "Agent is watching" : "Agent is away"}
          </span>
        </div>
        <button
          type="button"
          className="chat-close"
          onClick={chat.close}
          aria-label="Close chat"
        >
          ×
        </button>
      </header>
      <div className="chat-messages" ref={list}>
        {session.chat.length === 0 && (
          <p className="chat-empty">
            Ask about the interview or a question, or tell the agent to change
            direction. It replies here.
          </p>
        )}
        {session.chat.map((message) => (
          <Message
            key={message.id}
            message={message}
            about={message.questionId ? numbered(message.questionId) : null}
            quoted={
              message.replyTo &&
              message.replyTo !== previousUser(session.chat, message)?.id
                ? session.chat.find((other) => other.id === message.replyTo)
                : undefined
            }
          />
        ))}
        {pending && (
          <p className="chat-pending" role="status">
            {pending.delivered
              ? "The agent has it. Waiting for a reply…"
              : session.agentWatching
                ? "Waiting for the agent…"
                : "No agent is watching right now. It will see this when it next checks in."}
          </p>
        )}
      </div>
      {active ? (
        <form
          className="chat-compose"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {chat.about && (
            <span className="chat-chip">
              <span>
                {attached
                  ? `Q${attached.number} · ${attached.prompt}`
                  : "A removed question"}
              </span>
              <button
                type="button"
                onClick={() => chat.setAbout(null)}
                aria-label="Remove the attached question"
              >
                ×
              </button>
            </span>
          )}
          <div className="chat-input-row">
            <textarea
              ref={input}
              rows={2}
              value={text}
              placeholder={
                chat.about
                  ? "Ask about this question…"
                  : "Ask a question, or give the agent a direction…"
              }
              aria-label="Message to the agent"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button type="submit" disabled={sending || !text.trim()}>
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
          {error && (
            <p className="save-error" role="alert">
              {error}
            </p>
          )}
        </form>
      ) : (
        <p className="chat-closed">This interview is finished.</p>
      )}
    </aside>
  );
}

function Message({
  message,
  about,
  quoted,
}: {
  message: ChatMessageView;
  about: { number: number; prompt: string } | null;
  quoted: ChatMessageView | undefined;
}) {
  if (message.author === "user")
    return (
      <div className="chat-message user">
        {message.authorEmail && (
          <span className="chat-by">{message.authorEmail}</span>
        )}
        {message.questionId && (
          <span className="chat-chip">
            <span>
              {about
                ? `Q${about.number} · ${about.prompt}`
                : "A removed question"}
            </span>
          </span>
        )}
        <p>{message.text}</p>
      </div>
    );
  return (
    <div className="chat-message agent">
      {quoted && (
        <span className="chat-quote">
          ↩{" "}
          {quoted.text.length > 80
            ? `${quoted.text.slice(0, 79)}…`
            : quoted.text}
        </span>
      )}
      <div className="markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
      </div>
    </div>
  );
}

/** The user's message just before this one, which a reply answers by default. */
function previousUser(
  chat: ChatMessageView[],
  message: ChatMessageView,
): ChatMessageView | undefined {
  return chat
    .slice(0, chat.indexOf(message))
    .reverse()
    .find((other) => other.author === "user");
}
