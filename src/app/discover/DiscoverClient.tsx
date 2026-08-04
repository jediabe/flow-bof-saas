"use client";

/**
 * /discover client — three-tab product discovery feed powered by
 * TikHub. Operator picks a source (Hot / Top Ads / By Category),
 * narrows down with client-side filters (price / commission / sold
 * count), multi-selects the ones worth pursuing, and bulk-imports
 * them as a new Batch → drops straight into mobile review.
 *
 * Design notes:
 *   - Client-side filtering because TikHub doesn't accept price /
 *     commission / sold-count as query params. Fetch once per tab,
 *     narrow in memory.
 *   - No persistence of discovered products. Fresh fetch on tab
 *     click. Kalodata-style growth-rate math is Path B and lives
 *     behind snapshots we don't have yet.
 *   - Preset UK category IDs baked in for the By Category tab —
 *     TikHub doesn't expose a category enumeration endpoint so
 *     these are hand-copied from the shop pages we've verified.
 *     Operator can also type a raw id if they know one.
 */

import { useCallback, useMemo, useState, useTransition } from "react";
import {
  fetchDiscoverHotSelling,
  fetchDiscoverTopAds,
  fetchDiscoverByCategory,
  importDiscoveredProducts,
  type DiscoverProduct,
} from "./actions";

type Tab = "hot" | "topAds" | "category";
type Region = "GB" | "US";

/** Preset category IDs the operator can pick from. TikHub takes
 *  raw numeric IDs; these are the top-level Shop categories
 *  copied from the live category dropdown. */
const UK_CATEGORIES: Array<{ id: string; label: string }> = [
  { id: "601152",   label: "Beauty & Personal Care" },
  { id: "600001",   label: "Womenswear & Underwear" },
  { id: "601583",   label: "Home Supplies" },
  { id: "602758",   label: "Kitchenware" },
  { id: "600002",   label: "Menswear" },
  { id: "839829",   label: "Phones & Electronics" },
  { id: "970104",   label: "Health" },
  { id: "952266",   label: "Sports & Outdoor" },
  { id: "600006",   label: "Pet Supplies" },
];

export default function DiscoverClient() {
  const [tab, setTab] = useState<Tab>("hot");
  const [region, setRegion] = useState<Region>("GB");
  const [categoryId, setCategoryId] = useState<string>(
    UK_CATEGORIES[0]?.id ?? "",
  );

  const [rawProducts, setRawProducts] = useState<DiscoverProduct[]>([]);
  const [fetching, startFetch] = useTransition();
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);

  // Filters (client-side).
  const [priceMin, setPriceMin] = useState<string>("");
  const [priceMax, setPriceMax] = useState<string>("");
  const [commissionMin, setCommissionMin] = useState<string>("");
  const [soldMin, setSoldMin] = useState<string>("");

  // Selection state.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Import UI.
  const [importing, startImport] = useTransition();
  const [importResult, setImportResult] = useState<{
    ok: boolean;
    message?: string;
    reviewUrl?: string;
    qrDataUrl?: string;
    batchId?: string;
    productsCreated: number;
    imagesFailed: number;
  } | null>(null);

  const fetchTab = useCallback(() => {
    setFetchError(null);
    setSelected(new Set());
    startFetch(async () => {
      let resp;
      if (tab === "hot") {
        resp = await fetchDiscoverHotSelling({ region });
      } else if (tab === "topAds") {
        resp = await fetchDiscoverTopAds({ region });
      } else {
        resp = await fetchDiscoverByCategory({ categoryId, region });
      }
      setHasFetched(true);
      if (resp.ok) {
        setRawProducts(resp.products);
      } else {
        setRawProducts([]);
        setFetchError(resp.message ?? "TikHub returned no products.");
      }
    });
  }, [tab, region, categoryId]);

  // Client-side filter pass.
  const filtered = useMemo(() => {
    const pMin = parseFloat(priceMin) || 0;
    const pMax = parseFloat(priceMax) || Infinity;
    const cMin = parseFloat(commissionMin) || 0;
    const sMin = parseInt(soldMin || "0", 10) || 0;
    return rawProducts.filter(
      (p) =>
        p.price >= pMin &&
        p.price <= pMax &&
        p.commissionRate >= cMin &&
        p.soldCount >= sMin,
    );
  }, [rawProducts, priceMin, priceMax, commissionMin, soldMin]);

  const toggleSelected = (productId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const selectAllVisible = () => {
    setSelected(new Set(filtered.map((p) => p.productId)));
  };
  const clearSelection = () => setSelected(new Set());

  const doImport = () => {
    if (selected.size === 0) return;
    const toImport = filtered
      .filter((p) => selected.has(p.productId))
      .map((p) => ({
        productId: p.productId,
        title: p.title,
        imageUrlRemote: p.imageUrlRemote,
        category: p.category,
        price: p.price,
      }));
    startImport(async () => {
      const r = await importDiscoveredProducts({
        products: toImport,
        market: region === "US" ? "us" : "uk",
      });
      setImportResult(r);
      if (r.ok) setSelected(new Set());
    });
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="h-page">Discover</h1>
          <p className="text-sm text-muted mt-1">
            TikHub-powered discovery. Pick promising products and
            bulk-import them as a Style 1 batch.
          </p>
        </div>
      </header>

      {/* Tab bar + region selector */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-3">
        <div className="flex rounded-xl border border-border overflow-hidden">
          <TabBtn active={tab === "hot"} onClick={() => setTab("hot")}>
            Hot selling
          </TabBtn>
          <TabBtn active={tab === "topAds"} onClick={() => setTab("topAds")}>
            Top ads
          </TabBtn>
          <TabBtn active={tab === "category"} onClick={() => setTab("category")}>
            By category
          </TabBtn>
        </div>

        <label className="text-xs text-muted flex items-center gap-2">
          Region
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value as Region)}
            className="field text-xs py-1"
          >
            <option value="GB">GB · UK</option>
            <option value="US">US</option>
          </select>
        </label>

        {tab === "category" && (
          <label className="text-xs text-muted flex items-center gap-2">
            Category
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="field text-xs py-1"
            >
              {UK_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="button"
          onClick={fetchTab}
          disabled={fetching}
          className="btn btn-primary text-xs ml-auto"
        >
          {fetching
            ? "Fetching…"
            : hasFetched
              ? "Refresh"
              : "Fetch products"}
        </button>
      </div>

      {/* Filters row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FilterInput
          label="Price min ($)"
          value={priceMin}
          onChange={setPriceMin}
          placeholder="0"
        />
        <FilterInput
          label="Price max ($)"
          value={priceMax}
          onChange={setPriceMax}
          placeholder="∞"
        />
        <FilterInput
          label="Commission % min"
          value={commissionMin}
          onChange={setCommissionMin}
          placeholder="0"
        />
        <FilterInput
          label="Sold count min"
          value={soldMin}
          onChange={setSoldMin}
          placeholder="0"
        />
      </div>

      {/* Selection bar */}
      {rawProducts.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs bg-panel2 border border-border rounded-xl p-3">
          <span className="text-muted">
            Showing <strong className="text-text">{filtered.length}</strong> of{" "}
            {rawProducts.length} products
          </span>
          <span className="text-muted">·</span>
          <span className="text-muted">
            <strong className="text-text">{selected.size}</strong> selected
          </span>
          <button
            type="button"
            onClick={selectAllVisible}
            className="text-accent hover:underline"
          >
            Select all visible
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="text-muted hover:text-text"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={doImport}
            disabled={importing || selected.size === 0}
            className="btn btn-primary text-xs ml-auto"
          >
            {importing
              ? "Importing…"
              : `Import ${selected.size} → Style 1 batch`}
          </button>
        </div>
      )}

      {/* Fetch error */}
      {fetchError && (
        <div className="rounded-xl border border-bad/40 bg-bad/10 p-3 text-xs text-bad">
          {fetchError}
        </div>
      )}

      {/* Import result */}
      {importResult && (
        <div
          className={`rounded-xl border p-4 space-y-2 ${
            importResult.ok
              ? "border-ok/40 bg-ok/10 text-ok"
              : "border-bad/40 bg-bad/10 text-bad"
          }`}
        >
          <div className="font-semibold text-sm">
            {importResult.ok ? "Import complete" : "Import failed"}
          </div>
          <div className="text-xs text-text">
            {importResult.message ??
              (importResult.ok
                ? `${importResult.productsCreated} products imported.`
                : "Something went wrong.")}
            {importResult.imagesFailed > 0 && (
              <>
                {" "}
                <span className="text-muted">
                  ({importResult.imagesFailed} images failed to download)
                </span>
              </>
            )}
          </div>
          {importResult.ok && importResult.reviewUrl && (
            <div className="flex flex-col sm:flex-row items-start gap-4 pt-2">
              {importResult.qrDataUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={importResult.qrDataUrl}
                  alt="Mobile review QR"
                  className="w-32 h-32 rounded-lg border border-border bg-white"
                />
              )}
              <div className="text-xs space-y-2">
                <p className="text-text">
                  Scan the QR on your phone to review this batch and
                  enter live discount %s. After approval, Style 1 kits
                  auto-generate.
                </p>
                <a
                  href={importResult.reviewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline break-all"
                >
                  {importResult.reviewUrl}
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Product grid */}
      {!hasFetched && (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted">
          Pick a tab + region and hit Fetch products.
        </div>
      )}
      {hasFetched && filtered.length === 0 && !fetching && (
        <div className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted">
          {rawProducts.length === 0
            ? "TikHub returned no products for this feed."
            : "All products filtered out — loosen the filters above."}
        </div>
      )}
      {filtered.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {filtered.map((p) => (
            <DiscoverCard
              key={p.productId}
              product={p}
              selected={selected.has(p.productId)}
              onToggle={() => toggleSelected(p.productId)}
              region={region}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------
 * Sub-components
 * ---------------------------------------------------------------- */

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-4 py-2 ${
        active
          ? "bg-accent/15 text-accent"
          : "text-muted hover:text-text hover:bg-panel2"
      }`}
    >
      {children}
    </button>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type="number"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="field text-xs mt-1"
      />
    </div>
  );
}

function DiscoverCard({
  product,
  selected,
  onToggle,
  region,
}: {
  product: DiscoverProduct;
  selected: boolean;
  onToggle: () => void;
  region: Region;
}) {
  const currency = region === "GB" ? "£" : "$";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`text-left rounded-xl border overflow-hidden bg-panel transition-colors ${
        selected
          ? "border-ok ring-2 ring-ok/40"
          : "border-border hover:border-border-strong"
      }`}
    >
      <div className="aspect-square bg-panel2 relative">
        {product.imageUrlRemote ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrlRemote}
            alt={product.title}
            className="w-full h-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted2 text-xs">
            no image
          </div>
        )}
        <div
          className={`absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
            selected ? "bg-ok text-white" : "bg-black/40 text-white"
          }`}
        >
          {selected ? "✓" : ""}
        </div>
      </div>
      <div className="p-3 space-y-1.5">
        <div className="text-xs text-text font-medium line-clamp-2 min-h-[2.4em]">
          {product.title || "(untitled)"}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted flex-wrap">
          <span className="font-mono text-text">
            {currency}
            {product.price.toFixed(2)}
          </span>
          {product.commissionRate > 0 && (
            <>
              <span>·</span>
              <span className="text-accent">
                {product.commissionRate.toFixed(0)}% comm
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted flex-wrap">
          <span>{compactNum(product.soldCount)} sold</span>
          <span>·</span>
          <span title="Estimated lifetime revenue = price × sold count (rough)">
            ~{currency}
            {compactNum(product.estRevenue)}
          </span>
        </div>
        {product.category && (
          <div className="text-[10px] text-muted2 truncate">
            {product.category}
          </div>
        )}
      </div>
    </button>
  );
}

/** 1.2k / 3.4M style compaction. */
function compactNum(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}
