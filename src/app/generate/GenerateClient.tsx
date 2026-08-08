"use client";

/**
 * /generate chat UI — scaffold (Commit 3).
 *
 * Two-pane layout: conversation list on the left, active thread
 * on the right. Selected conversation lives in the URL (?c=<id>)
 * so refresh preserves it and back/forward works.
 *
 * SCAFFOLD status: send persists a user message and echoes an
 * assistant placeholder ("agent loop lands in Commit 4"). No
 * MCP calls, no LLM, no streaming — the shape is here so
 * Commit 4 only needs to swap the placeholder for real
 * sendMessage plumbing.
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  createConversation,
  deleteConversation,
  getConversationDetail,
  renameConversation,
  sendUserMessage,
  type ConversationSummary,
  type ConversationDetail,
  type ChatMessage,
} from "./actions";

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

  // Whenever the URL's ?c changes (nav / back / initial route),
  // refetch that conversation's detail. Server-side initial fetch
  // covers the first paint; this handles subsequent selections.
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
      const d = await getConversationDetail(selectedId);
      setDetail(d);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function selectConversation(id: string) {
    router.replace(`/generate?c=${id}`);
  }

  async function reloadConversations() {
    // Actions revalidate /generate; router.refresh triggers a
    // server-component re-render. Also mirror into local state
    // for immediate UI feedback.
    router.refresh();
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] gap-4 h-[calc(100vh-8rem)] min-h-[500px]">
      <ConversationRail
        conversations={conversations}
        selectedId={selectedId}
        onSelect={selectConversation}
        onCreated={(id) => {
          selectConversation(id);
          reloadConversations();
        }}
        onDeleted={(id) => {
          setConversations((prev) => prev.filter((c) => c.id !== id));
          if (selectedId === id) router.replace("/generate");
          reloadConversations();
        }}
      />
      <ThreadPane
        detail={detail}
        selectedId={selectedId}
        refreshing={refreshing}
        flowEmail={flowEmail}
        onMessageSent={(newMsg) => {
          setDetail((prev) =>
            prev && prev.ok
              ? {
                  ...prev,
                  messages: [...(prev.messages ?? []), newMsg],
                }
              : prev,
          );
          reloadConversations();
        }}
        onTitleChanged={(id, newTitle) => {
          setConversations((prev) =>
            prev.map((c) => (c.id === id ? { ...c, title: newTitle } : c)),
          );
          if (detail && detail.id === id) {
            setDetail({ ...detail, title: newTitle });
          }
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------
 * Left rail — conversation list + new-chat button
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
 * Right pane — active thread
 * ---------------------------------------------------------------- */

function ThreadPane({
  detail,
  selectedId,
  refreshing,
  flowEmail,
  onMessageSent,
  onTitleChanged,
}: {
  detail: ConversationDetail | null;
  selectedId: string | null;
  refreshing: boolean;
  flowEmail: string | null;
  onMessageSent: (msg: ChatMessage) => void;
  onTitleChanged: (id: string, title: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sendPending, startSend] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const messages = detail?.messages ?? [];
  const hasFlowEmail = !!flowEmail;

  function send() {
    if (!selectedId || !draft.trim() || sendPending) return;
    setError(null);
    const text = draft;
    startSend(async () => {
      const r = await sendUserMessage({ conversationId: selectedId, text });
      if (!r.ok) {
        setError(r.message || "send failed");
        return;
      }
      setDraft("");
      onMessageSent({
        id: r.messageId!,
        role: "user",
        content: text,
        toolCallsJson: null,
        toolResultJson: null,
        createdAt: new Date().toISOString(),
      });
      // Refresh full detail to catch the auto-derived title if
      // this was the first message.
      const fresh = await getConversationDetail(selectedId);
      if (fresh.ok && fresh.title && detail?.id === selectedId) {
        onTitleChanged(fresh.id!, fresh.title);
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl + Enter to send. Plain Enter inserts newline —
    // agent prompts are often multi-line.
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
        <Link
          href="/generate"
          className="btn btn-sm mt-4 inline-block"
        >
          Back to list
        </Link>
      </div>
    );
  }

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
        {messages.length === 0 ? (
          <div className="text-[12px] text-muted2 italic text-center py-8">
            Send the first message to start the conversation.
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      <footer className="border-t border-border p-3 space-y-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={sendPending}
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
          ) : (
            <span className="text-[11px] text-muted2">
              Cmd/Ctrl+Enter to send. Agent loop lands in the next
              commit — for now, messages just persist.
            </span>
          )}
          <button
            type="button"
            onClick={send}
            disabled={sendPending || !draft.trim()}
            className="btn btn-primary text-xs"
          >
            {sendPending ? "Sending…" : "Send"}
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

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  // Scaffold: no assistant / tool rendering yet since we don't
  // create those rows. Bubble style is user-first.
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-accent/15 text-text"
            : isAssistant
              ? "bg-panel2 text-text border border-border"
              : "bg-panel2 text-muted border border-border font-mono text-[11px]"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}

// Suppress unused-import warning for useMemo. Left imported for
// Commit 4 which will use it heavily (tool-call parsing per turn).
void useMemo;
