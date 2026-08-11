"use client";

/**
 * BatchChatPanel — wired-up container that drives the pure
 * BatchChatPanelV2 with real conversation data + SSE streaming.
 *
 * Lives inline at the top of /prompts (APEX Automator). Always
 * mounted; when no batch is active (`batchId={null}`) the V2 card
 * renders in placeholder mode with a disabled composer and copy
 * inviting the operator to import a Kalodata sheet or paste TikTok
 * URLs below.
 *
 * State ownership after the 3-state product refactor:
 *   - Conversation data (list, active id, messages, streaming) is
 *     OWNED by this component — it's the piece that talks to the
 *     server.
 *   - Attached product + selected image URLs are OWNED by the
 *     PARENT (PromptsHubClient) so the batch grid + this panel
 *     stay in sync. This component reports its seed values back
 *     up (onSyncAttached / onSyncActiveConversation) once the
 *     conversation loads, and defers to whatever the parent
 *     hands back on subsequent renders.
 *
 * Auth: server actions + the SSE endpoint enforce ownership
 * through getCurrentWorkspace() + a conversation → batch →
 * workspace join.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { BatchPromptsProduct } from "./actions";
import BatchChatPanelV2, {
  type V2Message,
  type V2Product,
} from "./chat-ui/BatchChatPanelV2";
import {
  createBatchConversation,
  deleteConversation,
  getConversationDetail,
  listBatchConversations,
  renameConversation,
  type ChatMessage,
  type ConversationSummary,
} from "./chat-actions";

interface BatchChatPanelProps {
  /** Null when no batch is active — V2 renders in placeholder
   *  mode. Everything else on the page keeps working. */
  batchId: string | null;
  batchName: string | null;
  products: BatchPromptsProduct[];
  /** Attached product id — driven by the parent. When null the
   *  chat has no product focus (no pill above the input). */
  attachedProductId: string | null;
  /** Reference images the operator picked in the ProductDetailDrawer
   *  for the NEXT chat turn. Cleared by parent when the product
   *  changes; cleared by us after a successful send. */
  selectedImageUrls: Set<string>;
  /** Called when the operator clicks the attached-product pill so
   *  the parent can open the product's detail drawer. */
  onOpenProductDetail: (productId: string) => void;
  /** Called once when we load the conversation and know its
   *  persisted currentProductId — the parent uses this to seed
   *  its own attached-product state. */
  onSyncAttached: (productId: string | null) => void;
  /** Called when the loaded conversation's persisted selected
   *  images change (currently a no-op — selection is ephemeral
   *  per session). */
  onSyncSelectedImages: (next: Set<string>) => void;
  /** Called when the active conversation id changes so the
   *  parent can drive attach/detach actions against the correct
   *  conversation. */
  onSyncActiveConversation: (conversationId: string | null) => void;
  /** Called after a successful send so the parent can clear the
   *  drawer's image selection (they were consumed by that turn). */
  onClearSelectedImages: () => void;
}

export default function BatchChatPanel({
  batchId,
  batchName,
  products,
  attachedProductId,
  selectedImageUrls,
  onOpenProductDetail,
  onSyncAttached,
  onSyncSelectedImages: _onSyncSelectedImages,
  onSyncActiveConversation,
  onClearSelectedImages,
}: BatchChatPanelProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Composer state
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [streamText, setStreamText] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Load conversation list on mount / batch change.
  useEffect(() => {
    // Placeholder mode — clear all state and skip the network.
    if (!batchId) {
      setConversations([]);
      setConvId(null);
      setMessages([]);
      onSyncActiveConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await listBatchConversations(batchId);
        if (cancelled) return;
        setConversations(rows);
        if (rows.length > 0) {
          const firstId = rows[0]!.id;
          setConvId(firstId);
          onSyncActiveConversation(firstId);
        } else {
          const created = await createBatchConversation({ batchId });
          if (!cancelled && created.ok && created.id) {
            setConvId(created.id);
            onSyncActiveConversation(created.id);
            const refreshed = await listBatchConversations(batchId);
            if (!cancelled) setConversations(refreshed);
          }
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);

  // Load transcript when convId changes; seed the parent's
  // attached-product state from the loaded conversation.
  useEffect(() => {
    if (!convId) {
      setMessages([]);
      onSyncAttached(null);
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
      onSyncAttached(r.currentProductId ?? null);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  const v2Messages: V2Message[] = useMemo(
    () =>
      messages.map((m) => ({
        id: m.id,
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
        toolCallsJson: m.toolCallsJson,
        toolResultJson: m.toolResultJson,
        attachedImagesJson: m.attachedImagesJson,
        createdAt: m.createdAt,
      })),
    [messages],
  );

  // Products are still handed to V2 so it can look up the attached
  // product's name + thumbnail for the pill. availableImages is no
  // longer used inside V2 (image picker moved to the drawer) but
  // we compute it anyway so the shape stays stable.
  const v2Products: V2Product[] = useMemo(
    () =>
      products.map((p) => {
        const seen = new Set<string>();
        const out: string[] = [];
        const push = (u: string | null | undefined) => {
          if (!u || seen.has(u)) return;
          seen.add(u);
          out.push(u);
        };
        push(p.referenceImageUrl);
        push(p.imageUrl);
        for (const u of p.sourceImages) push(u);
        return { id: p.id, name: p.productName, availableImages: out };
      }),
    [products],
  );

  function selectConversation(id: string) {
    setConvId(id);
    onSyncActiveConversation(id);
  }

  async function newConversation() {
    if (!batchId) return;
    const r = await createBatchConversation({ batchId });
    if (!r.ok || !r.id) {
      setError(r.message ?? "Couldn't create conversation");
      return;
    }
    setConvId(r.id);
    onSyncActiveConversation(r.id);
    const rows = await listBatchConversations(batchId);
    setConversations(rows);
  }

  async function removeConversation(id: string) {
    if (!batchId) return;
    const r = await deleteConversation(id);
    if (!r.ok) {
      setError(r.message ?? "Delete failed");
      return;
    }
    const rows = await listBatchConversations(batchId);
    setConversations(rows);
    if (convId === id) {
      const next = rows[0]?.id ?? null;
      setConvId(next);
      onSyncActiveConversation(next);
    }
  }

  async function rename(id: string, title: string) {
    if (!batchId) return;
    const r = await renameConversation({ conversationId: id, title });
    if (!r.ok) {
      setError(r.message ?? "Rename failed");
      return;
    }
    setConversations(await listBatchConversations(batchId));
  }

  async function submitTurn() {
    if (!convId || !batchId) return;
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setStreamText("");
    setError(null);

    // Optimistic user bubble — reads the selectedImageUrls from
    // the parent so it matches what the operator saw in the drawer.
    const attachedForThisTurn = [...selectedImageUrls];
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      content: trimmed,
      toolCallsJson: null,
      toolResultJson: null,
      attachedImagesJson:
        attachedForThisTurn.length > 0
          ? JSON.stringify(attachedForThisTurn)
          : null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setText("");
    onClearSelectedImages();

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
      const r = await getConversationDetail(convId);
      if (r.ok) {
        setMessages(r.messages ?? []);
        setStreamText("");
      }
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
    } catch {
      // ignore malformed frame
    }
  }

  return (
    <BatchChatPanelV2
      batchName={batchName}
      conversations={conversations.map((c) => ({
        id: c.id,
        title: c.title,
        messageCount: c.messageCount,
      }))}
      activeConversationId={convId}
      onSelectConversation={selectConversation}
      onNewConversation={newConversation}
      onDeleteConversation={removeConversation}
      onRenameConversation={rename}
      messages={v2Messages}
      streamingText={streamText}
      agentWorking={sending}
      products={v2Products}
      attachedProductId={attachedProductId}
      attachedImageCount={selectedImageUrls.size}
      onOpenProductDetail={onOpenProductDetail}
      text={text}
      onTextChange={setText}
      onSubmit={submitTurn}
      sending={sending}
      error={error}
      onDismissError={() => setError(null)}
    />
  );
}
