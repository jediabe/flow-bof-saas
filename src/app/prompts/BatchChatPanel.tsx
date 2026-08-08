"use client";

/**
 * BatchChatPanel — right-side chat drawer that lives inside the
 * active-batch view on /prompts. Replaces the workspace-level
 * /generate page: each Batch owns its own transcript history so
 * the operator's mental model ("I'm working on this batch") maps
 * 1:1 to the conversations they see.
 *
 * UX:
 *   - Fixed drawer on the right, slides in when toggled from the
 *     batch header. ~440px wide on desktop, full-width on <sm.
 *   - Conversation list up top (compact), transcript below,
 *     composer at the bottom.
 *   - The composer's product picker sets which product is
 *     "focused" — that drives what images the multi-select image
 *     picker surfaces (referenceImageUrl + sourceImages).
 *   - Selected image URLs ride along on send as
 *     referenceImageUrls; the agent runner rebuilds them into a
 *     "[Reference images: ...]" preamble before hitting Anthropic.
 *
 * Streaming:
 *   POSTs to /api/generate/stream/[conversationId] and reads the
 *   SSE stream via fetch()+ReadableStream — EventSource can't do
 *   POST bodies. Optimistic user bubble goes in on submit;
 *   assistant + tool bubbles land as message_saved events arrive.
 *
 * Auth: the server actions and SSE endpoint enforce workspace
 * ownership via getCurrentWorkspace + a conversation → batch →
 * workspace join. This component trusts what it's handed and
 * treats server errors as red inline banners.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { BatchPromptsProduct } from "./actions";
import {
  createBatchConversation,
  deleteConversation,
  getConversationDetail,
  listBatchConversations,
  renameConversation,
  setConversationProduct,
  type ChatMessage,
  type ConversationSummary,
} from "./chat-actions";

interface BatchChatPanelProps {
  batchId: string;
  batchName: string;
  products: BatchPromptsProduct[];
  /** Toggle from the batch header. Panel is fully unmounted when
   *  closed so we don't hold a stale SSE reader in the background. */
  open: boolean;
  onClose: () => void;
}

export default function BatchChatPanel(props: BatchChatPanelProps) {
  if (!props.open) return null;
  return <BatchChatPanelInner {...props} />;
}

function BatchChatPanelInner({
  batchId,
  batchName,
  products,
  onClose,
}: BatchChatPanelProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentProductId, setCurrentProductId] = useState<string | null>(null);

  // Composer state
  const [text, setText] = useState("");
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Load conversation list on mount / batch change
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await listBatchConversations(batchId);
        if (cancelled) return;
        setConversations(rows);
        // Auto-open the most recent, or auto-create if none exist.
        if (rows.length > 0) {
          setConvId(rows[0].id);
        } else {
          const created = await createBatchConversation({ batchId });
          if (!cancelled && created.ok && created.id) {
            setConvId(created.id);
            const refreshed = await listBatchConversations(batchId);
            if (!cancelled) setConversations(refreshed);
          }
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [batchId]);

  // Load transcript when convId changes
  useEffect(() => {
    if (!convId) {
      setMessages([]);
      setCurrentProductId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const r = await getConversationDetail(convId);
      if (cancelled) return;
      if (!r.ok) {
        setError(r.message ?? "Couldn't load conversation");
        return;
      }
      setMessages(r.messages ?? []);
      setCurrentProductId(r.currentProductId ?? null);
      // Reset image picker when switching conversations — the
      // previous conversation's selection isn't meaningful here.
      setSelectedImages(new Set());
    })();
    return () => {
      cancelled = true;
    };
  }, [convId]);

  const currentProduct = useMemo(() => {
    if (!currentProductId) return null;
    return products.find((p) => p.id === currentProductId) ?? null;
  }, [currentProductId, products]);

  // Union of images available for attachment on the focused
  // product. referenceImageUrl first (that's the operator's
  // curated pick from mobile review), then Kalodata imageUrl,
  // then any TikHub-sourced gallery images. Deduped preserving
  // order.
  const availableImages = useMemo(() => {
    if (!currentProduct) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (u: string | null | undefined) => {
      if (!u) return;
      if (seen.has(u)) return;
      seen.add(u);
      out.push(u);
    };
    push(currentProduct.referenceImageUrl);
    push(currentProduct.imageUrl);
    for (const u of currentProduct.sourceImages) push(u);
    return out;
  }, [currentProduct]);

  async function pickProduct(id: string | null) {
    setCurrentProductId(id);
    setSelectedImages(new Set());
    if (convId) {
      const r = await setConversationProduct({ conversationId: convId, productId: id });
      if (!r.ok) setError(r.message ?? "Couldn't set product");
    }
  }

  function toggleImage(url: string) {
    setSelectedImages((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  async function newConversation() {
    const r = await createBatchConversation({ batchId });
    if (!r.ok || !r.id) {
      setError(r.message ?? "Couldn't create conversation");
      return;
    }
    setConvId(r.id);
    const rows = await listBatchConversations(batchId);
    setConversations(rows);
  }

  async function removeConversation(id: string) {
    if (!confirm("Delete this conversation?")) return;
    const r = await deleteConversation(id);
    if (!r.ok) {
      setError(r.message ?? "Delete failed");
      return;
    }
    const rows = await listBatchConversations(batchId);
    setConversations(rows);
    if (convId === id) {
      setConvId(rows[0]?.id ?? null);
    }
  }

  async function submitTurn() {
    if (!convId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (sending) return;
    setSending(true);
    setStreamText("");
    setError(null);

    // Optimistic user bubble.
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      content: trimmed,
      toolCallsJson: null,
      toolResultJson: null,
      attachedImagesJson:
        selectedImages.size > 0 ? JSON.stringify([...selectedImages]) : null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    const attachedForThisTurn = [...selectedImages];
    setText("");
    setSelectedImages(new Set());

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(`/api/generate/stream/${convId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: trimmed,
          referenceImageUrls: attachedForThisTurn,
        }),
        signal: ac.signal,
      });
      if (!res.body) throw new Error("no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by "\n\n"
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          handleSseFrame(frame);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(`Send failed: ${(err as Error).message}`);
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      // Refresh the transcript from the server so persisted rows
      // (with real DB ids) replace the optimistic one.
      const r = await getConversationDetail(convId);
      if (r.ok) {
        setMessages(r.messages ?? []);
        setStreamText("");
      }
      // Also refresh the conversation list so title auto-derivation
      // shows up.
      const rows = await listBatchConversations(batchId);
      setConversations(rows);
    }
  }

  function handleSseFrame(frame: string) {
    const lines = frame.split("\n");
    let data = "";
    for (const line of lines) {
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    try {
      const evt = JSON.parse(data) as {
        type: string;
        delta?: string;
        message?: string;
      };
      if (evt.type === "text_delta" && typeof evt.delta === "string") {
        setStreamText((prev) => prev + evt.delta);
      } else if (evt.type === "error" && evt.message) {
        setError(evt.message);
      }
      // message_saved / tool_call / tool_result get flushed via the
      // getConversationDetail refresh at the end of the stream —
      // simpler than reconciling per-event.
    } catch {
      // ignore malformed frame
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm"
        aria-hidden="true"
      />
      {/* Drawer */}
      <aside
        className="fixed top-0 right-0 z-40 h-screen w-full sm:w-[560px] bg-panel border-l border-border shadow-2xl flex flex-col"
        role="dialog"
        aria-label={`Chat for batch ${batchName}`}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
              APEX chat · {batchName}
            </div>
            <div className="text-sm text-text truncate">
              {loading ? "Loading…" : conversations.length > 0
                ? conversations.find((c) => c.id === convId)?.title ?? "New chat"
                : "New chat"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={newConversation}
              className="text-[11px] text-accent hover:underline"
            >
              + New
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-[11px] text-muted hover:text-text"
            >
              Close
            </button>
          </div>
        </header>

        {conversations.length > 1 && (
          <div className="px-4 py-2 border-b border-border overflow-x-auto whitespace-nowrap flex gap-2">
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => setConvId(c.id)}
                onDoubleClick={async () => {
                  const t = prompt("Rename conversation", c.title);
                  if (!t) return;
                  await renameConversation({ conversationId: c.id, title: t });
                  setConversations(await listBatchConversations(batchId));
                }}
                className={
                  "text-[11px] px-2 py-1 rounded-md border transition-colors " +
                  (c.id === convId
                    ? "bg-accent/10 border-accent text-text"
                    : "bg-transparent border-border text-muted hover:text-text")
                }
                title={`${c.messageCount} messages · double-click to rename`}
              >
                {c.title}
              </button>
            ))}
          </div>
        )}

        {/* Transcript */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {error && (
            <div className="text-[11px] text-accent-red border border-accent-red/40 rounded-md px-2 py-1">
              {error}
            </div>
          )}
          {messages.map((m) => (
            <ChatBubble key={m.id} message={m} />
          ))}
          {streamText && (
            <ChatBubble
              message={{
                id: "stream",
                role: "assistant",
                content: streamText,
                toolCallsJson: null,
                toolResultJson: null,
                attachedImagesJson: null,
                createdAt: new Date().toISOString(),
              }}
            />
          )}
          {sending && !streamText && (
            <div className="text-[11px] text-muted italic">Thinking…</div>
          )}
          {!loading && messages.length === 0 && !sending && (
            <div className="text-[11px] text-muted italic">
              Ask the agent to generate Style 1 videos for a product in this
              batch. Pick a product below to focus context.
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border p-4 space-y-3">
          <ProductPicker
            products={products}
            value={currentProductId}
            onChange={pickProduct}
          />

          {availableImages.length > 0 && (
            <ImagePicker
              images={availableImages}
              selected={selectedImages}
              onToggle={toggleImage}
              onClear={() => setSelectedImages(new Set())}
              conversationHasDelete={
                convId
                  ? () => removeConversation(convId)
                  : undefined
              }
            />
          )}

          <div className="flex gap-2 items-end">
            <textarea
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !sending) {
                  e.preventDefault();
                  void submitTurn();
                }
              }}
              placeholder={
                currentProduct
                  ? `Ask about ${currentProduct.productName}…`
                  : "Ask the agent…"
              }
              disabled={sending || !convId}
              className="flex-1 min-h-[112px] bg-panel2 border border-border rounded-md px-3 py-2 text-sm text-text resize-y focus:outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={submitTurn}
              disabled={sending || !convId || !text.trim()}
              className="btn"
            >
              {sending ? "…" : "Send"}
            </button>
          </div>
          {selectedImages.size > 0 && (
            <div className="text-[10px] text-muted">
              Attaching {selectedImages.size} image
              {selectedImages.size === 1 ? "" : "s"} to next turn
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/* --------------------------------------------------------------
 * Chat bubble
 * ------------------------------------------------------------ */

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  // Tool-result rows have no user-visible content — collapse to a
  // small "🔧 result" chip so the transcript stays readable.
  if (message.role === "user" && message.toolResultJson) {
    return (
      <div className="text-[10px] text-muted italic pl-2">
        · tool result received
      </div>
    );
  }
  const attached = safeParseImages(message.attachedImagesJson);
  const toolCalls = safeParseToolCalls(message.toolCallsJson);
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          "max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap " +
          (isUser
            ? "bg-accent/15 border border-accent/40 text-text"
            : "bg-panel2 border border-border text-text")
        }
      >
        {message.content}
        {attached.length > 0 && (
          <div className="mt-2 flex gap-1 flex-wrap">
            {attached.map((u) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={u}
                src={u}
                alt="attachment"
                className="w-12 h-12 object-cover rounded-md border border-border"
              />
            ))}
          </div>
        )}
        {toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {toolCalls.map((tc) => (
              <div
                key={tc.id}
                className="text-[10px] text-muted font-mono border border-border rounded px-1.5 py-0.5"
                title={JSON.stringify(tc.input, null, 2)}
              >
                🔧 {tc.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function safeParseImages(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function safeParseToolCalls(json: string | null): Array<{
  id: string;
  name: string;
  input: unknown;
}> {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => x && typeof x === "object" && typeof x.name === "string")
      .map((x) => ({
        id: String(x.id ?? Math.random()),
        name: String(x.name),
        input: x.input,
      }));
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------
 * Product picker
 * ------------------------------------------------------------ */

function ProductPicker({
  products,
  value,
  onChange,
}: {
  products: BatchPromptsProduct[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-[10px] uppercase tracking-[0.14em] text-muted shrink-0">
        Product
      </label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="flex-1 bg-panel2 border border-border rounded-md px-2 py-1 text-[12px] text-text focus:outline-none focus:border-accent"
      >
        <option value="">— none —</option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.productName}
          </option>
        ))}
      </select>
    </div>
  );
}

/* --------------------------------------------------------------
 * Image picker
 * ------------------------------------------------------------ */

function ImagePicker({
  images,
  selected,
  onToggle,
  onClear,
  conversationHasDelete,
}: {
  images: string[];
  selected: Set<string>;
  onToggle: (url: string) => void;
  onClear: () => void;
  conversationHasDelete?: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
          Reference images
        </div>
        <div className="flex gap-2">
          {selected.size > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="text-[10px] text-muted hover:text-text"
            >
              Clear
            </button>
          )}
          {conversationHasDelete && (
            <button
              type="button"
              onClick={conversationHasDelete}
              className="text-[10px] text-muted hover:text-accent-red"
              title="Delete this conversation"
            >
              Delete chat
            </button>
          )}
        </div>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {images.map((url) => {
          const isOn = selected.has(url);
          return (
            <button
              key={url}
              type="button"
              onClick={() => onToggle(url)}
              className={
                "shrink-0 w-24 h-24 rounded-lg border overflow-hidden relative transition-all " +
                (isOn
                  ? "border-accent ring-2 ring-accent/60"
                  : "border-border opacity-70 hover:opacity-100")
              }
              title={url}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt="ref"
                className="w-full h-full object-cover"
              />
              {isOn && (
                <span className="absolute top-1 right-1 bg-accent text-black text-[10px] rounded-full w-5 h-5 flex items-center justify-center font-bold">
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
