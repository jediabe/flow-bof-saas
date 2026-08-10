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
 * Auth: server actions + the SSE endpoint enforce ownership
 * through getCurrentWorkspace() + a conversation → batch →
 * workspace join. This container trusts the returned data and
 * surfaces server errors inline in the V2 card's red banner.
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
  setConversationProduct,
  type ChatMessage,
  type ConversationSummary,
} from "./chat-actions";

interface BatchChatPanelProps {
  /** Null when no batch is active — V2 renders in placeholder
   *  mode. Everything else on the page keeps working. */
  batchId: string | null;
  batchName: string | null;
  products: BatchPromptsProduct[];
}

export default function BatchChatPanel({
  batchId,
  batchName,
  products,
}: BatchChatPanelProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [convId, setConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [currentProductId, setCurrentProductId] = useState<string | null>(null);

  // Composer state
  const [text, setText] = useState("");
  const [selectedImages, setSelectedImages] = useState<Set<string>>(new Set());
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
      setCurrentProductId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await listBatchConversations(batchId);
        if (cancelled) return;
        setConversations(rows);
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
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [batchId]);

  // Load transcript when convId changes.
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
      setSelectedImages(new Set());
    })();
    return () => {
      cancelled = true;
    };
  }, [convId]);

  // Map ChatMessage → V2Message (identity shape today; kept as a
  // memo so we don't recompute per keystroke).
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

  // Map batch products → V2Product with pre-computed available
  // images (referenceImageUrl + imageUrl + sourceImages, deduped).
  const v2Products: V2Product[] = useMemo(
    () =>
      products.map((p) => {
        const seen = new Set<string>();
        const out: string[] = [];
        const push = (u: string | null | undefined) => {
          if (!u) return;
          if (seen.has(u)) return;
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
    if (!batchId) return;
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
    if (!batchId) return;
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
      // Refresh from server so persisted rows replace the optimistic one.
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
      onSelectConversation={setConvId}
      onNewConversation={newConversation}
      onDeleteConversation={removeConversation}
      onRenameConversation={rename}
      messages={v2Messages}
      streamingText={streamText}
      agentWorking={sending}
      products={v2Products}
      currentProductId={currentProductId}
      onPickProduct={pickProduct}
      selectedImages={selectedImages}
      onToggleImage={toggleImage}
      onClearImages={() => setSelectedImages(new Set())}
      text={text}
      onTextChange={setText}
      onSubmit={submitTurn}
      sending={sending}
      error={error}
      onDismissError={() => setError(null)}
    />
  );
}
