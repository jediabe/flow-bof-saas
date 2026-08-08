"use client";

/**
 * /generate chat UI — Commit 4 (agent loop wired).
 *
 * Two-pane layout: conversation list on the left, active thread
 * on the right. Selected conversation lives in the URL (?c=<id>)
 * so refresh preserves it.
 *
 * Sending a message opens an SSE connection to
 * /api/generate/stream/<conversationId> — the server persists
 * the user message, runs the Anthropic tool-use loop against the
 * APEX MCP, and streams events back:
 *   text_delta      → append to a live "streaming" assistant bubble
 *   tool_call       → render an expandable "🔧 tool_name" pill
 *   tool_result     → attach preview + status to the matching pill
 *   message_saved   → note that a DB row exists (used for eventual
 *                     reconciliation on refresh)
 *   done            → refetch conversation, drop the streaming bubble
 *   error           → red banner + drop the streaming state
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  createConversation,
  deleteConversation,
  getConversationDetail,
  type ConversationSummary,
  type ConversationDetail,
  type ChatMessage,
} from "./actions";

/** In-progress state maintained locally while the SSE stream is
 *  running for the currently-selected conversation. Not persisted;
 *  when the stream ends we refetch the conversation from the DB
 *  which is the source of truth. */
interface StreamingState {
  /** Accumulating assistant text as text_delta events arrive. */
  text: string;
  /** In-flight tool calls this turn, keyed by toolUseId. Each
   *  gets a "result" appended when the paired tool_result arrives. */
  toolCalls: Array<{
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
    result?: { isError: boolean; preview: string };
  }>;
}

export default function GenerateClient({
  initialConversations,
  initialSelected,
  flowEmail,
}: {
  initialConversations: ConversationSummary[];
  initialSelected: ConversationDetail | null;
  flowEmail: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("c");

  const [conversations, setConversations] = useState(initialConversations);
  const [detail, setDetail] = useState<ConversationDetail | null>(initialSelected);
  const [refreshing, startRefresh] = useTransition();

  const reloadConversationDetail = useCallback(
    async (id: string) => {
      const d = await getConversationDetail(id);
      setDetail(d);
    },
    [],
  );

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    if (initialSelected?.id === selectedId) {
      setDetail(initialSelected);
      return;
    }
    startRefresh(async () => {
      await reloadConversationDetail(selectedId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function selectConversation(id: string) {
    router.replace(`/generate?c=${id}`);
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-4 h-[calc(100vh-8rem)] min-h-[500px]">
      <ConversationRail
        conversations={conversations}
        selectedId={selectedId}
        onSelect={selectConversation}
        onCreated={(id) => {
          selectConversation(id);
          router.refresh();
        }}
        onDeleted={(id) => {
          setConversations((prev) => prev.filter((c) => c.id !== id));
          if (selectedId === id) router.replace("/generate");
          router.refresh();
        }}
      />
      <ThreadPane
        detail={detail}
        selectedId={selectedId}
        refreshing={refreshing}
        flowEmail={flowEmail}
        onTurnComplete={async () => {
          if (selectedId) {
            await reloadConversationDetail(selectedId);
            router.refresh();
          }
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------
 * Left rail
 * ---------------------------------------------------------------- */

function ConversationRail({
  conversations,
  selectedId,
  onSelect,
  onCreated,
  onDeleted,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  function newChat() {
    startTransition(async () => {
      const r = await createConversation();
      if (r.ok && r.id) onCreated(r.id);
    });
  }
  return (
    <aside className="panel p-3 flex flex-col gap-3 min-h-0">
      <button
        type="button"
        onClick={newChat}
        disabled={pending}
        className="btn btn-primary text-sm w-full"
      >
        {pending ? "Creating…" : "+ New chat"}
      </button>
      <div className="flex-1 overflow-y-auto -mx-1 px-1">
        {conversations.length === 0 ? (
          <div className="text-[11px] text-muted2 italic px-2 py-4 text-center">
            No conversations yet.
          </div>
        ) : (
          <ul className="space-y-1">
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conv={c}
                selected={c.id === selectedId}
                onSelect={() => onSelect(c.id)}
                onDeleted={() => onDeleted(c.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ConversationRow({
  conv,
  selected,
  onSelect,
  onDeleted,
}: {
  conv: ConversationSummary;
  selected: boolean;
  onSelect: () => void;
  onDeleted: () => void;
}) {
  const [pending, startTransition] = useTransition();
  function del(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete "${conv.title}"?`)) return;
    startTransition(async () => {
      const r = await deleteConversation(conv.id);
      if (r.ok) onDeleted();
    });
  }
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={pending}
        className={`w-full text-left px-2 py-2 rounded-lg transition-colors group flex items-start justify-between gap-2 ${
          selected
            ? "bg-accent/15 text-text"
            : "hover:bg-panel2 text-muted hover:text-text"
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium truncate">
            {conv.title}
          </div>
          <div className="text-[10px] text-muted2 mt-0.5">
            {new Date(conv.updatedAt).toLocaleDateString()} · {conv.messageCount} msg
            {conv.messageCount === 1 ? "" : "s"}
          </div>
        </div>
        <span
          onClick={del}
          className="opacity-0 group-hover:opacity-100 text-[11px] text-muted hover:text-bad flex-shrink-0 leading-tight cursor-pointer"
          title="Delete"
        >
          ×
        </span>
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------
 * Right pane — thread + composer + streaming
 * ---------------------------------------------------------------- */

function ThreadPane({
  detail,
  selectedId,
  refreshing,
  flowEmail,
  onTurnComplete,
}: {
  detail: ConversationDetail | null;
  selectedId: string | null;
  refreshing: boolean;
  flowEmail: string | null;
  onTurnComplete: () => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasFlowEmail = !!flowEmail;
  const isBusy = streaming !== null;

  async function send() {
    if (!selectedId || !draft.trim() || isBusy) return;
    if (!hasFlowEmail) {
      setError(
        "Bind a Google Flow account in Settings before running the agent.",
      );
      return;
    }
    setError(null);
    const text = draft;
    setDraft("");
    setStreaming({ text: "", toolCalls: [] });
    // Optimistically render the user's message right away —
    // we know the server will persist it. The refetch after
    // done reconciles.

    let resp: Response;
    try {
      resp = await fetch(`/api/generate/stream/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      setStreaming(null);
      setError(
        `Failed to open stream: ${(err as Error).message?.slice(0, 200)}`,
      );
      return;
    }
    if (!resp.ok || !resp.body) {
      setStreaming(null);
      setError(
        `Stream request failed: ${resp.status} ${resp.statusText}`,
      );
      return;
    }

    // Consume the SSE stream by hand (EventSource doesn't
    // support POST bodies, so we use fetch + a reader).
    const reader = resp.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        // SSE frames are separated by \n\n.
        let sepIndex;
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const parsed = parseSseFrame(frame);
          if (parsed) handleAgentEvent(parsed);
        }
      }
    } catch (err) {
      setError(
        `Stream read error: ${(err as Error).message?.slice(0, 200)}`,
      );
    } finally {
      reader.releaseLock();
    }

    // Wrap up: refetch conversation from DB so the transcript is
    // canonical, then drop the local streaming state.
    await onTurnComplete();
    setStreaming(null);

    function handleAgentEvent(evt: {
      event: string;
      data: Record<string, unknown>;
    }) {
      switch (evt.event) {
        case "text_delta": {
          const delta = String(evt.data.delta ?? "");
          setStreaming((prev) =>
            prev ? { ...prev, text: prev.text + delta } : prev,
          );
          break;
        }
        case "tool_call": {
          const toolUseId = String(evt.data.toolUseId ?? "");
          const name = String(evt.data.name ?? "");
          const input =
            (evt.data.input as Record<string, unknown>) ?? {};
          setStreaming((prev) =>
            prev
              ? {
                  ...prev,
                  toolCalls: [
                    ...prev.toolCalls,
                    { toolUseId, name, input },
                  ],
                }
              : prev,
          );
          break;
        }
        case "tool_result": {
          const toolUseId = String(evt.data.toolUseId ?? "");
          const isError = Boolean(evt.data.isError);
          const preview = String(evt.data.preview ?? "");
          setStreaming((prev) =>
            prev
              ? {
                  ...prev,
                  toolCalls: prev.toolCalls.map((tc) =>
                    tc.toolUseId === toolUseId
                      ? { ...tc, result: { isError, preview } }
                      : tc,
                  ),
                }
              : prev,
          );
          break;
        }
        case "error": {
          setError(String(evt.data.message ?? "unknown error"));
          break;
        }
        // message_saved / done: no UI update needed — done ends
        // the loop, message_saved is for eventual reconciliation
        break;
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  }

  if (!selectedId) {
    return (
      <div className="panel p-8 flex flex-col items-center justify-center text-center">
        <div className="text-sm text-muted mb-4 max-w-md leading-relaxed">
          Pick a conversation on the left, or start a new one to talk
          to the video agent about a product.
        </div>
        {!hasFlowEmail && <ConnectFlowNudge />}
      </div>
    );
  }

  if (detail && !detail.ok) {
    return (
      <div className="panel p-8 text-center">
        <div className="text-sm text-bad">
          {detail.message || "Conversation not found"}
        </div>
        <Link href="/generate" className="btn btn-sm mt-4 inline-block">
          Back to list
        </Link>
      </div>
    );
  }

  const messages = detail?.messages ?? [];

  return (
    <section className="panel flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-border flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text truncate">
            {detail?.title ?? "…"}
          </div>
        </div>
        {refreshing && (
          <span className="text-[11px] text-muted2">Loading…</span>
        )}
      </header>

      {!hasFlowEmail && (
        <div className="mx-4 mt-3">
          <ConnectFlowNudge />
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && !streaming ? (
          <div className="text-[12px] text-muted2 italic text-center py-8">
            Send the first message to start the conversation.
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {streaming && <StreamingBubble state={streaming} />}
          </>
        )}
      </div>

      <footer className="border-t border-border p-3 space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isBusy}
          rows={3}
          placeholder={
            hasFlowEmail
              ? "Ask the agent to generate a Style 1 video for a product... (Cmd/Ctrl+Enter to send)"
              : "Connect a Google Flow account on /settings first."
          }
          className="field text-sm leading-relaxed resize-none"
        />
        <div className="flex items-center justify-between gap-2">
          {error ? (
            <span className="text-[11px] text-bad">{error}</span>
          ) : isBusy ? (
            <span className="text-[11px] text-accent">
              Agent working…
            </span>
          ) : (
            <span className="text-[11px] text-muted2">
              Cmd/Ctrl+Enter to send.
            </span>
          )}
          <button
            type="button"
            onClick={send}
            disabled={isBusy || !draft.trim() || !hasFlowEmail}
            className="btn btn-primary text-xs"
          >
            {isBusy ? "…" : "Send"}
          </button>
        </div>
      </footer>
    </section>
  );
}

function ConnectFlowNudge() {
  return (
    <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 p-3 text-[12px] text-orange-300 leading-relaxed">
      <span className="font-semibold">No Google Flow account bound.</span>{" "}
      Head to{" "}
      <Link href="/settings" className="text-accent hover:underline">
        Settings
      </Link>{" "}
      → Google Flow account, pick one from your useapi.net
      subscription. The agent needs it to fire any Flow tool.
    </div>
  );
}

/* ------------------------------------------------------------------
 * Message bubbles
 * ---------------------------------------------------------------- */

function MessageBubble({ message }: { message: ChatMessage }) {
  // A user-role row is EITHER a plain user message (content set,
  // toolResultJson null) OR a tool_result row (content empty,
  // toolResultJson populated). Render the latter as a compact
  // tool-result pill.
  if (message.role === "user" && message.toolResultJson) {
    return <PersistedToolResult json={message.toolResultJson} />;
  }
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const toolCalls = message.toolCallsJson
    ? safeParseArray(message.toolCallsJson)
    : [];

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed space-y-2 ${
          isUser
            ? "bg-accent/15 text-text whitespace-pre-wrap"
            : isAssistant
              ? "bg-panel2 text-text border border-border"
              : "bg-panel2 text-muted border border-border font-mono text-[11px]"
        }`}
      >
        {message.content && (
          <div className="whitespace-pre-wrap">{message.content}</div>
        )}
        {toolCalls.map((tc, i) => (
          <ToolCallPill
            key={(tc.id as string) ?? i}
            name={String(tc.name ?? "")}
            input={(tc.input as Record<string, unknown>) ?? {}}
          />
        ))}
      </div>
    </div>
  );
}

function StreamingBubble({ state }: { state: StreamingState }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed space-y-2 bg-panel2 text-text border border-border">
        {state.text && (
          <div className="whitespace-pre-wrap">{state.text}</div>
        )}
        {state.toolCalls.map((tc) => (
          <div key={tc.toolUseId} className="space-y-1">
            <ToolCallPill name={tc.name} input={tc.input} />
            {tc.result ? (
              <ToolResultRow
                isError={tc.result.isError}
                preview={tc.result.preview}
              />
            ) : (
              <div className="text-[10px] text-muted2 italic pl-2">
                waiting for result…
              </div>
            )}
          </div>
        ))}
        {!state.text && state.toolCalls.length === 0 && (
          <div className="text-[10px] text-muted2 italic">thinking…</div>
        )}
      </div>
    </div>
  );
}

function PersistedToolResult({ json }: { json: string }) {
  const parsed = safeParseObject(json);
  const isError = Boolean(parsed.is_error);
  const content =
    typeof parsed.content === "string" ? parsed.content : "";
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full">
        <ToolResultRow isError={isError} preview={content.slice(0, 300)} />
      </div>
    </div>
  );
}

function ToolCallPill({
  name,
  input,
}: {
  name: string;
  input: Record<string, unknown>;
}) {
  return (
    <details className="rounded-lg border border-border bg-bg/60 text-[11px]">
      <summary className="cursor-pointer px-2 py-1 text-accent hover:text-text">
        🔧 {name}
      </summary>
      <pre className="px-2 py-2 border-t border-border overflow-x-auto text-[10px] text-muted leading-relaxed whitespace-pre">
        {JSON.stringify(input, null, 2)}
      </pre>
    </details>
  );
}

function ToolResultRow({
  isError,
  preview,
}: {
  isError: boolean;
  preview: string;
}) {
  return (
    <div
      className={`rounded-lg border text-[10px] px-2 py-1 leading-relaxed ${
        isError
          ? "border-bad/40 bg-bad/10 text-bad"
          : "border-ok/40 bg-ok/[0.06] text-muted"
      }`}
    >
      <span className="font-semibold">
        {isError ? "tool error:" : "result:"}
      </span>{" "}
      <span className="whitespace-pre-wrap break-all">{preview}</span>
    </div>
  );
}

/* ------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------- */

function parseSseFrame(
  frame: string,
): { event: string; data: Record<string, unknown> } | null {
  const lines = frame.split("\n");
  let event = "";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!event || !data) return null;
  try {
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function safeParseArray(json: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
