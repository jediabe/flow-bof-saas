"use client";

/**
 * BatchChatPanelV2 — presentational inline chat card. Sits at
 * the top of /prompts (APEX Automator surface) as a large glass
 * panel; no drawer chrome, no toggle. Zero server calls —
 * everything (data + callbacks) comes in via props so this file
 * can be mounted from the real prompts hub or from the
 * /prompts/chat-preview harness with mock data.
 *
 * Design targets:
 *   1. Tool calls → one collapsed "agent working" pill per turn.
 *   2. Hierarchy — user bubble (accent tint) vs. bare assistant
 *      text vs. muted tool pill vs. hero image grid.
 *   3. Roomier vertical rhythm (16-24px between groups).
 *   4. Header is a muted eyebrow + well-spaced actions.
 *   5. Composer is ONE glass card (product tag → reference-image
 *      strip → textarea → send) instead of stacked bars.
 *   6. Soft fade+slide-up on new messages; breathing accent
 *      pulse on the "agent working" state.
 *
 * Placeholder mode: when `batchId` is null (no active batch), the
 * card renders with a muted invitation to import a Kalodata sheet
 * or paste TikTok URLs below, and the composer is disabled. The
 * chat is batch-scoped so it can't function without a batch.
 *
 * All colour comes from existing tokens (bg #0A0A0B, panel
 * #141416, hairline rgba(255,255,255,0.08), accent #2AB8F5 +
 * gradient stops) — no palette changes.
 */

import { useMemo, useRef, useState, useEffect } from "react";
import { friendlyToolLabel } from "./tool-labels";

/* ==================================================================
 * Props / shape
 * ================================================================ */

export interface V2Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** JSON string — same shape the persisted Message row carries. */
  toolCallsJson: string | null;
  /** JSON string — a paired tool_result rider block. */
  toolResultJson: string | null;
  /** JSON array of URLs the operator attached this turn. */
  attachedImagesJson: string | null;
  createdAt: string;
}

export interface V2Product {
  id: string;
  name: string;
  /** Union of referenceImageUrl + imageUrl + sourceImages, in
   *  display order. Pre-computed by the caller so the panel
   *  stays presentational. */
  availableImages: string[];
}

export interface V2Conversation {
  id: string;
  title: string;
  messageCount: number;
}

export interface BatchChatPanelV2Props {
  /** Null when no batch is active — the card renders in
   *  placeholder mode with a disabled composer. */
  batchName: string | null;

  /* Conversation state (empty arrays / null id in placeholder mode) */
  conversations: V2Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;

  /* Transcript */
  messages: V2Message[];
  /** Text of the currently streaming assistant response, if any. */
  streamingText: string;
  /** True while an SSE request is in-flight (i.e. the agent is
   *  thinking / tool-calling). */
  agentWorking: boolean;

  /* Composer.
   * The 3-state product refactor moved the picker + reference-
   * image strip out of the composer and into the product detail
   * drawer. The composer only surfaces the CURRENTLY-ATTACHED
   * product as a small pill above the input, plus the image
   * count. Clicking the pill body opens the drawer for that
   * product (via onOpenProductDetail). */
  products: V2Product[];
  /** Currently-attached product (from Conversation.currentProductId,
   *  hoisted to the parent). Null when nothing is attached. */
  attachedProductId: string | null;
  /** How many reference images the operator picked in the drawer
   *  for the NEXT chat turn. Rendered on the pill as a small tail. */
  attachedImageCount: number;
  /** Open the ProductDetailDrawer for the given product id.
   *  Wired to the pill's body click. */
  onOpenProductDetail: (productId: string) => void;
  text: string;
  onTextChange: (t: string) => void;
  onSubmit: () => void;
  sending: boolean;

  /* Error banner */
  error: string | null;
  onDismissError: () => void;
}

/* ==================================================================
 * Panel
 * ================================================================ */

export default function BatchChatPanelV2(props: BatchChatPanelV2Props) {
  return <PanelBody {...props} />;
}

function PanelBody(props: BatchChatPanelV2Props) {
  const attachedProduct = useMemo(
    () => props.products.find((p) => p.id === props.attachedProductId) ?? null,
    [props.products, props.attachedProductId],
  );
  const isPlaceholder = !props.batchName;

  // Auto-scroll the transcript to the bottom whenever new messages
  // arrive or the streaming text updates.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.messages.length, props.streamingText, props.agentWorking]);

  const grouped = useMemo(() => groupMessages(props.messages), [props.messages]);

  return (
    <section
      className="chat-appear rounded-3xl border border-border overflow-hidden flex flex-col"
      style={{
        // Glass surface — panel colour at ~72% opacity over the
        // radial-glow backdrop, with a light blur so anything
        // underneath (page background gradient) shows through
        // subtly. Fallback: solid panel for older browsers.
        background:
          "linear-gradient(180deg, rgba(20,20,22,0.78) 0%, rgba(20,20,22,0.62) 100%)",
        backdropFilter: "blur(20px) saturate(140%)",
        WebkitBackdropFilter: "blur(20px) saturate(140%)",
        boxShadow:
          "0 12px 40px -8px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02) inset",
      }}
      aria-label="APEX Automator chat"
    >
      <PanelHeader
        batchName={props.batchName}
        activeTitle={
          isPlaceholder
            ? "Waiting for a batch"
            : props.conversations.find((c) => c.id === props.activeConversationId)
                ?.title ?? "New chat"
        }
        onNew={props.onNewConversation}
        newDisabled={isPlaceholder}
      />

      {props.conversations.length > 1 && (
        <ConversationTabs
          conversations={props.conversations}
          activeId={props.activeConversationId}
          onSelect={props.onSelectConversation}
          onRename={props.onRenameConversation}
        />
      )}

      {/* Transcript — fixed max-height so the card stays a
          predictable size regardless of how long the thread grows. */}
      <div
        ref={scrollRef}
        className="overflow-y-auto px-5 py-5 space-y-5"
        style={{ maxHeight: 360, minHeight: 240 }}
      >
        {props.error && (
          <ErrorBanner
            message={props.error}
            onDismiss={props.onDismissError}
          />
        )}

        {isPlaceholder ? (
          <PlaceholderCopy />
        ) : (
          <>
            {grouped.length === 0 && !props.agentWorking && (
              <EmptyState hasProduct={!!attachedProduct} />
            )}
            {grouped.map((g, i) => (
              <MessageGroup key={g.key} group={g} isLast={i === grouped.length - 1} />
            ))}
            {props.agentWorking && (
              <WorkingIndicator streamingText={props.streamingText} />
            )}
          </>
        )}
      </div>

      <ComposerCard
        attachedProduct={attachedProduct}
        attachedImageCount={props.attachedImageCount}
        onOpenProductDetail={props.onOpenProductDetail}
        text={props.text}
        onTextChange={props.onTextChange}
        onSubmit={props.onSubmit}
        sending={props.sending}
        activeConversationId={props.activeConversationId}
        placeholderMode={isPlaceholder}
      />
    </section>
  );
}

/* ==================================================================
 * Placeholder copy — shown in the transcript area when no batch
 * is active yet. Points the operator at the import bars below.
 * ================================================================ */

function PlaceholderCopy() {
  return (
    <div className="chat-appear text-center py-8 px-4">
      <div className="eyebrow text-muted mb-3">Agent is waiting</div>
      <p className="text-[13.5px] text-muted leading-relaxed max-w-[380px] mx-auto">
        Begin by importing a Kalodata sheet or pasting TikTok URLs below.
        The agent lives inside a batch — once one exists, ask it to
        generate Style 1 videos, upload references, or check what&apos;s
        already been produced.
      </p>
    </div>
  );
}

/* ==================================================================
 * Header
 * ================================================================ */

function PanelHeader({
  batchName,
  activeTitle,
  onNew,
  newDisabled,
}: {
  batchName: string | null;
  activeTitle: string;
  onNew: () => void;
  newDisabled: boolean;
}) {
  return (
    <header className="px-5 pt-4 pb-3 flex items-start justify-between gap-6 border-b border-border">
      <div className="min-w-0">
        <div className="eyebrow text-muted mb-1">
          APEX Automator{batchName ? ` · ${batchName}` : ""}
        </div>
        <div
          className="text-[15px] text-text truncate"
          title={activeTitle}
        >
          {activeTitle}
        </div>
      </div>
      <div className="flex items-center gap-5 shrink-0 pt-1">
        <button
          type="button"
          onClick={onNew}
          disabled={newDisabled}
          className="text-[12px] text-muted hover:text-accent transition-colors disabled:opacity-40 disabled:hover:text-muted disabled:cursor-not-allowed"
          title={
            newDisabled
              ? "Import a batch first to start a conversation"
              : "Start a fresh conversation"
          }
        >
          + New chat
        </button>
      </div>
    </header>
  );
}

/* ==================================================================
 * Conversation tabs (only shown when >1 exist)
 * ================================================================ */

function ConversationTabs({
  conversations,
  activeId,
  onSelect,
  onRename,
}: {
  conversations: V2Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  return (
    <div className="px-5 py-2 border-b border-border overflow-x-auto whitespace-nowrap flex gap-2">
      {conversations.map((c) => (
        <button
          key={c.id}
          onClick={() => onSelect(c.id)}
          onDoubleClick={() => {
            const t = prompt("Rename conversation", c.title);
            if (t) onRename(c.id, t);
          }}
          className={
            "text-[11px] px-2.5 py-1 rounded-full border transition-colors " +
            (c.id === activeId
              ? "bg-accent/10 border-accent/50 text-text"
              : "bg-transparent border-border text-muted hover:text-text")
          }
          title={`${c.messageCount} messages · double-click to rename`}
        >
          {c.title}
        </button>
      ))}
    </div>
  );
}

/* ==================================================================
 * Message grouping
 *
 * Convert the flat message list into semantic groups so each
 * "turn" renders as one hierarchical unit:
 *   - user turn        → single bubble
 *   - assistant text   → bare text block (bubble-less)
 *   - assistant tools  → collapsed "agent working" pill (>=1 tool
 *                        call between two text blocks are merged)
 * ================================================================ */

type Group =
  | { key: string; kind: "user"; message: V2Message }
  | { key: string; kind: "assistant-text"; text: string; message: V2Message }
  | {
      key: string;
      kind: "assistant-tools";
      labels: string[];
      count: number;
      /** Media URLs surfaced by any tool_result between the tool_use
       *  events in this group. Rendered as thumbnails right below
       *  the "Ran N steps" pill so the operator sees the generated
       *  image the moment the tool returns, without waiting for the
       *  assistant to type it into a text bubble. */
      media: MediaHit[];
    };

function groupMessages(messages: V2Message[]): Group[] {
  const out: Group[] = [];
  // Pending accumulators — flushed the next time we hit an
  // assistant text block or the end of the list.
  let pendingLabels: string[] = [];
  let pendingMedia: MediaHit[] = [];
  let pendingIdx = 0;
  const flushTools = () => {
    if (pendingLabels.length === 0 && pendingMedia.length === 0) return;
    out.push({
      key: `tools-${pendingIdx}-${pendingLabels.length}-${pendingMedia.length}`,
      kind: "assistant-tools",
      labels: pendingLabels,
      count: pendingLabels.length,
      media: pendingMedia,
    });
    pendingLabels = [];
    pendingMedia = [];
    pendingIdx += 1;
  };

  for (const m of messages) {
    if (m.role === "user" && m.toolResultJson) {
      // Paired tool_result — pull media out of the structured
      // response. extractMediaFromToolResult trusts the MCP
      // normalizer's `kind` field, so completed Veo videos on
      // storage.googleapis.com (no .mp4 extension, signed URLs)
      // are correctly classified as video rather than misread
      // as image.
      const urls = extractMediaFromToolResult(m.toolResultJson);
      for (const u of urls) {
        if (!pendingMedia.some((m0) => m0.url === u.url)) {
          pendingMedia.push(u);
        }
      }
      continue;
    }
    if (m.role === "user") {
      flushTools();
      out.push({ key: m.id, kind: "user", message: m });
      continue;
    }
    // assistant
    const tools = parseToolCallLabels(m.toolCallsJson);
    if (tools.length > 0) {
      pendingLabels.push(...tools);
    }
    if (m.content.trim()) {
      flushTools();
      out.push({
        key: m.id,
        kind: "assistant-text",
        text: m.content,
        message: m,
      });
    }
  }
  flushTools();
  return out;
}

function parseToolCallLabels(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === "object" && typeof x.name === "string")
      .map((x) => friendlyToolLabel(String(x.name)));
  } catch {
    return [];
  }
}

/* ==================================================================
 * Message-group renderer
 * ================================================================ */

function MessageGroup({ group, isLast }: { group: Group; isLast: boolean }) {
  if (group.kind === "user") {
    return <UserBubble message={group.message} isLast={isLast} />;
  }
  if (group.kind === "assistant-text") {
    return <AssistantText message={group.message} />;
  }
  return (
    <AgentWorkingPill
      labels={group.labels}
      count={group.count}
      media={group.media}
    />
  );
}

/* ------- User bubble --------------------------------------------- */

function UserBubble({ message, isLast }: { message: V2Message; isLast: boolean }) {
  const attached = safeParseImages(message.attachedImagesJson);
  return (
    <div className={`chat-appear flex justify-end ${isLast ? "" : ""}`}>
      <div
        className="max-w-[80%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words"
        style={{
          background: "rgba(42,184,245,0.12)",
          border: "1px solid rgba(42,184,245,0.35)",
        }}
      >
        {message.content}
        {attached.length > 0 && (
          <div className="mt-2 flex gap-1.5 flex-wrap">
            {attached.map((u) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={u}
                src={u}
                alt="attachment"
                className="w-16 h-16 object-cover rounded-lg border border-border"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------- Assistant text (bare, no bubble) ------------------------ */

function AssistantText({ message }: { message: V2Message }) {
  const normalized = normalizeAssistantText(message.content);
  const mediaUrls = extractMediaUrls(normalized);
  return (
    <div className="chat-appear pr-6">
      <div className="text-[14px] leading-[1.65] text-text whitespace-pre-wrap break-words">
        <LinkifiedText text={normalized} />
      </div>
      {mediaUrls.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {mediaUrls.map((m) => (
            <a
              key={m.url}
              href={m.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-xl overflow-hidden border border-border bg-panel transition-transform duration-150 hover:-translate-y-0.5 hover:border-border-strong"
              title={m.url}
            >
              {m.kind === "video" ? (
                <video
                  src={m.url}
                  controls
                  playsInline
                  className="w-full h-auto max-h-72 object-contain bg-black"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={m.url}
                  alt="generated"
                  className="w-full h-auto max-h-72 object-contain bg-black"
                />
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------- Agent-working pill (collapsed tool-call block) ---------- */

function AgentWorkingPill({
  labels,
  count,
  media,
}: {
  labels: string[];
  count: number;
  media: MediaHit[];
}) {
  const [open, setOpen] = useState(false);
  const summary =
    labels.length === 0
      ? "generated media"
      : labels.length === 1
        ? labels[0]
        : `${labels[0]} · +${count - 1} more`;
  return (
    <div className="chat-appear space-y-3">
      {count > 0 && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="group inline-flex items-center gap-2 text-[11px] text-muted hover:text-text px-3 py-1.5 rounded-full border border-border bg-panel/60 transition-colors"
        >
          <span
            aria-hidden="true"
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: "#2AB8F5" }}
          />
          <span className="uppercase tracking-[0.14em]">Ran {count} step{count === 1 ? "" : "s"}</span>
          <span className="text-muted2">·</span>
          <span className="text-muted group-hover:text-text">{summary}</span>
          <span className="text-muted2 text-[9px]">{open ? "▴" : "▾"}</span>
        </button>
      )}
      {open && count > 0 && (
        <ol className="mt-2 ml-4 space-y-1 text-[11px] text-muted">
          {labels.map((l, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="text-muted2 tabular-nums">{i + 1}.</span>
              <span>{l}</span>
            </li>
          ))}
        </ol>
      )}
      {media.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {media.map((m) => (
            <a
              key={m.url}
              href={m.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-xl overflow-hidden border border-border bg-panel transition-transform duration-150 hover:-translate-y-0.5 hover:border-border-strong"
              title={m.url}
            >
              {m.kind === "video" ? (
                <video
                  src={m.url}
                  controls
                  playsInline
                  className="w-full h-auto max-h-72 object-contain bg-black"
                />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={m.url}
                  alt="generated"
                  className="w-full h-auto max-h-72 object-contain bg-black"
                />
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------- Live "working now" indicator ---------------------------- */

function WorkingIndicator({ streamingText }: { streamingText: string }) {
  if (streamingText) {
    // We already have a partial assistant reply — render it inline
    // as a bare assistant text block with the pulse dot in front so
    // the user knows more is coming.
    return (
      <div className="chat-appear pr-6">
        <div className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className="chat-breathe w-1.5 h-1.5 mt-2 rounded-full shrink-0"
            style={{ background: "#2AB8F5" }}
          />
          <div className="flex-1 text-[14px] leading-[1.65] text-text whitespace-pre-wrap break-words">
            <LinkifiedText text={streamingText} />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="chat-appear">
      <div
        className="inline-flex items-center gap-2 text-[11px] text-muted px-3 py-1.5 rounded-full border chat-breathe"
        style={{
          borderColor: "rgba(42,184,245,0.35)",
          background: "rgba(42,184,245,0.06)",
        }}
      >
        <span
          aria-hidden="true"
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: "#2AB8F5" }}
        />
        <span className="uppercase tracking-[0.14em]">Agent working…</span>
      </div>
    </div>
  );
}

/* ==================================================================
 * Composer — attached-product pill above a bare textarea + send.
 *
 * The product picker + reference-image strip used to live here.
 * Post-refactor the picker moved to the batch grid (chips) and
 * the image strip moved to the ProductDetailDrawer. Only the
 * ATTACHED product surfaces here, as a small pill above the
 * input. Clicking the pill body opens the drawer for that
 * product; clicking the × detaches.
 * ================================================================ */

function ComposerCard({
  attachedProduct,
  attachedImageCount,
  onOpenProductDetail,
  text,
  onTextChange,
  onSubmit,
  sending,
  activeConversationId,
  placeholderMode,
}: {
  attachedProduct: V2Product | null;
  attachedImageCount: number;
  onOpenProductDetail: (productId: string) => void;
  text: string;
  onTextChange: (t: string) => void;
  onSubmit: () => void;
  sending: boolean;
  activeConversationId: string | null;
  placeholderMode: boolean;
}) {
  const disabled = placeholderMode;
  return (
    <div className="p-4 pt-3 space-y-2">
      {attachedProduct && !disabled && (
        <AttachedProductPill
          product={attachedProduct}
          imageCount={attachedImageCount}
          onOpen={() => onOpenProductDetail(attachedProduct.id)}
        />
      )}
      <div
        className={
          "rounded-2xl border overflow-hidden transition-opacity " +
          (disabled
            ? "border-border/60 bg-panel/40 opacity-60"
            : "border-border bg-panel")
        }
      >
        <div className="p-3 flex items-end gap-2">
          <textarea
            rows={4}
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !sending && !disabled) {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder={
              placeholderMode
                ? "Import a batch below to unlock the agent…"
                : attachedProduct
                  ? `Ask about ${attachedProduct.name}…`
                  : "Ask the agent — click a product chip below to attach one for context…"
            }
            disabled={disabled || sending || !activeConversationId}
            className="flex-1 min-h-[96px] bg-transparent border-none text-[13.5px] leading-relaxed text-text placeholder:text-muted2 resize-y focus:outline-none focus:ring-0 px-1 disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={disabled || sending || !activeConversationId || !text.trim()}
            className="btn btn-primary shrink-0"
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ==================================================================
 * AttachedProductPill — state 3 of the 3-state product pattern.
 *
 * Small pill above the chat input: thumbnail + name + optional
 * "N images" tail + × detach. Clicking the body (not the ×) opens
 * the ProductDetailDrawer for the attached product. Detach is
 * fired via the parent's setConversationProduct(null) — done in
 * PromptsHubClient, not here — so we just call onDetach.
 *
 * The × button also stops propagation so a click on it doesn't
 * also trigger onOpen.
 * ================================================================ */

function AttachedProductPill({
  product,
  imageCount,
  onOpen,
}: {
  product: V2Product;
  imageCount: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open ${product.name} detail — click × to detach in the drawer`}
      className="chat-appear group w-full flex items-center gap-2.5 px-3 py-2 rounded-full border transition-all duration-150 hover:-translate-y-0.5 hover:border-accent/60"
      style={{
        background: "rgba(42,184,245,0.08)",
        borderColor: "rgba(42,184,245,0.35)",
      }}
    >
      <div className="w-7 h-7 rounded-full overflow-hidden bg-panel2 shrink-0">
        {product.availableImages[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.availableImages[0]}
            alt=""
            className="w-full h-full object-cover"
          />
        ) : null}
      </div>
      <span className="text-[11px] uppercase tracking-[0.14em] text-accent shrink-0">
        Attached
      </span>
      <span className="text-[12.5px] text-text truncate flex-1 min-w-0 text-left">
        {product.name}
      </span>
      {imageCount > 0 && (
        <span className="text-[10px] text-muted shrink-0">
          · {imageCount} image{imageCount === 1 ? "" : "s"}
        </span>
      )}
    </button>
  );
}


/* ==================================================================
 * Error banner
 * ================================================================ */

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      className="chat-appear flex items-start gap-2 text-[12px] px-3 py-2 rounded-xl"
      style={{
        color: "#E4405F",
        borderWidth: 1,
        borderStyle: "solid",
        borderColor: "rgba(228,64,95,0.35)",
        background: "rgba(228,64,95,0.05)",
      }}
    >
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[11px] opacity-70 hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

/* ==================================================================
 * Empty state
 * ================================================================ */

function EmptyState({ hasProduct }: { hasProduct: boolean }) {
  return (
    <div className="chat-appear text-center py-10">
      <div className="eyebrow text-muted mb-2">Start a turn</div>
      <p className="text-[13px] text-muted max-w-[320px] mx-auto leading-relaxed">
        {hasProduct
          ? "Ask the agent to generate Style 1 videos for the focused product. Attach reference images below if you want the model to pin the shot on a specific pack."
          : "Pick a product below, then ask the agent — e.g. \"generate Style 1 for this product\"."}
      </p>
    </div>
  );
}

/* ==================================================================
 * Shared helpers
 * ================================================================ */

/**
 * Trim runaway whitespace from an assistant text block before we
 * render it with whitespace-pre-wrap. Different models emit very
 * different newline habits — Claude is tidy, DeepSeek and some
 * others pad every response with 3-6 trailing newlines which
 * paint as a wall of empty space in the transcript.
 *
 * Normalisation:
 *   - Trim leading + trailing whitespace across the whole block.
 *   - Collapse any run of 3+ consecutive newlines to exactly 2
 *     (single paragraph break). Genuine paragraph breaks stay.
 *   - Trim trailing whitespace on every line so an accidental
 *     "  \n" doesn't leave visible padding to the right of the
 *     text.
 */
function normalizeAssistantText(text: string): string {
  if (!text) return "";
  const trimmedLines = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
  return trimmedLines.replace(/\n{3,}/g, "\n\n").trim();
}

function safeParseImages(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;

function LinkifiedText({ text }: { text: string }) {
  if (!text) return null;
  const parts = text.split(URL_REGEX);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          return (
            <a
              key={i}
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline break-all"
            >
              {part}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

interface MediaHit {
  url: string;
  kind: "image" | "video";
}

/**
 * Extract media from a persisted tool_result row.
 *
 * The MCP normalization layer already stamps every returned
 * media item with a `kind` field ("video" | "image") and a
 * canonical `url`. We should trust that, not guess from the URL
 * shape — Google Flow's completed video URLs are signed
 * storage.googleapis.com paths WITHOUT a .mp4 extension, so
 * hostname / extension heuristics classify them wrong and the
 * chat renders a broken <img> tag where the video should be.
 *
 * Shape we're walking:
 *   toolResultJson = { type: "tool_result", tool_use_id, content, is_error }
 * where `content` is either:
 *   - a string containing JSON-stringified structuredContent
 *     (agent-runner does this when structuredContent is set)
 *   - an array of Anthropic content blocks (rarer for us)
 *
 * We recurse through the parsed shape, collecting every object
 * that looks like a media item ({ kind, url } or { kind,
 * mediaGenerationId } etc.). Falls back to regex + hostname
 * extraction if the JSON doesn't parse — that keeps this robust
 * against future response-shape changes upstream.
 */
function extractMediaFromToolResult(toolResultJson: string): MediaHit[] {
  const out: MediaHit[] = [];
  const seen = new Set<string>();
  const push = (url: unknown, kind: unknown): void => {
    if (typeof url !== "string" || !url) return;
    if (seen.has(url)) return;
    // Only accept the canonical `kind` values the normalizer
    // emits; anything else falls through to the guesser below.
    if (kind !== "image" && kind !== "video") return;
    seen.add(url);
    out.push({ url, kind });
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolResultJson);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    // Anthropic's tool_result "content" is either a plain string
    // (which itself may be JSON) or an array of content blocks.
    // Recurse through everything.
    walkForMedia(parsed, push);

    const outer = parsed as { content?: unknown };
    if (typeof outer.content === "string") {
      try {
        walkForMedia(JSON.parse(outer.content), push);
      } catch {
        // fall through — regex fallback below handles it
      }
    }
  }

  // Fallback: nothing structural matched, so scan for URLs the
  // way we do for assistant text bubbles.
  if (out.length === 0) {
    for (const hit of extractMediaUrls(toolResultJson)) {
      if (!seen.has(hit.url)) {
        seen.add(hit.url);
        out.push(hit);
      }
    }
  }
  return out;
}

/** Depth-limited walker that finds every object with a `kind` +
 *  `url` pair. Guards against runaway recursion on cycles or
 *  huge payloads by capping depth — 20 is well past any real
 *  Google Flow response nesting. */
function walkForMedia(
  node: unknown,
  push: (url: unknown, kind: unknown) => void,
  depth = 0,
): void {
  if (depth > 20 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForMedia(item, push, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  // Media item shape from src/types.ts MediaItem — { kind, url,
  // thumbnailUrl?, mediaGenerationId?, ... }. Anything with a
  // string kind and a string url is a plausible hit.
  if (typeof obj.kind === "string" && typeof obj.url === "string") {
    push(obj.url, obj.kind);
    // Also push a thumbnail if present. Renders as an image
    // regardless of the parent kind — thumbnails are always
    // stills.
    if (typeof obj.thumbnailUrl === "string") {
      push(obj.thumbnailUrl, "image");
    }
  }
  for (const value of Object.values(obj)) {
    walkForMedia(value, push, depth + 1);
  }
}

/**
 * Guessing-based URL extractor for assistant TEXT bubbles (where
 * we don't have a `kind` field). Not used for tool_result rows —
 * they have structural info we should trust.
 *
 * Hostname heuristics are deliberately weak: storage.googleapis.com
 * hosts both stills and videos, so we don't use hostname alone.
 * Extension is the primary signal; hostname is a last resort for
 * clearly image-only hosts. If nothing matches, we skip — better
 * than mislabeling.
 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)(\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const IMAGE_ONLY_HOSTS = ["googleusercontent.com", "useapi.net"];
const VIDEO_ONLY_HOSTS = ["googlevideo.com"];

function extractMediaUrls(text: string): MediaHit[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: MediaHit[] = [];
  const matches = text.match(URL_REGEX) ?? [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?)\]]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    if (VIDEO_EXT.test(url) || VIDEO_ONLY_HOSTS.some((h) => url.includes(h))) {
      out.push({ url, kind: "video" });
    } else if (
      IMAGE_EXT.test(url) ||
      IMAGE_ONLY_HOSTS.some((h) => url.includes(h))
    ) {
      out.push({ url, kind: "image" });
    }
  }
  return out;
}
