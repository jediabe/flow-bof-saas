/**
 * AES-256-GCM encryption for LLM credentials at rest — the
 * per-user api key AND OAuth access + refresh token trio.
 *
 * Deliberately separate from tikhub-crypto.ts even though the
 * algorithm is identical, because:
 *   - Different KEY source (LLM_CRED_ENC_KEY vs
 *     TIKTOK_COOKIE_ENC_KEY). Rotating one shouldn't rotate the
 *     other; losing one shouldn't compromise the other.
 *   - Different ENVELOPE format. The spec asked for
 *     `v1.<iv>.<tag>.<ciphertext>` (dot separators, auth tag as
 *     its own segment). tikhub-crypto uses colons and packs the
 *     tag into the ciphertext blob. Not worth breaking that
 *     format for consistency.
 *
 * Storage envelope:
 *
 *     v1.<base64 iv>.<base64 tag>.<base64 ciphertext>
 *
 * All three data segments are base64url-safe (no `=` padding
 * removed; standard base64 works). The `v1.` prefix is a
 * forward-compatibility marker so a future algorithm rotation
 * can add a `v2.` branch in decrypt() and migrate lazily.
 *
 * Key source: process.env.LLM_CRED_ENC_KEY (32 bytes,
 * base64-encoded). Generate with `openssl rand -base64 32`.
 *
 * Failure modes are noisy on purpose. A silent decrypt failure
 * would surface as "the model 401'd" and cost hours to trace;
 * a thrown error is caught by the credential resolver and
 * surfaced as "credential unreadable — reconnect".
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // GCM standard
const KEY_LEN = 32; // 256 bits
const TAG_LEN = 16;
const VERSION = "v1";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = (process.env.LLM_CRED_ENC_KEY || "").trim();
  if (!raw) {
    throw new Error(
      "LLM_CRED_ENC_KEY is unset. The LLM credentials store needs " +
        "a 32-byte base64 key — generate one with " +
        "`openssl rand -base64 32` and add it to your .env. " +
        "Decryption of existing LlmCredential rows will fail until " +
        "this is set.",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `LLM_CRED_ENC_KEY decodes to ${buf.length} bytes; expected ` +
        `${KEY_LEN}. Regenerate with \`openssl rand -base64 32\`.`,
    );
  }
  cachedKey = buf;
  return buf;
}

/**
 * Encrypt a plaintext credential (api key or OAuth token).
 * Returns the storage-format value to persist in the LlmCredential
 * row's *_enc column.
 *
 * Fresh random IV per call so two encrypts of the same plaintext
 * produce different ciphertexts — GCM's security contract.
 */
export function encryptLlmSecret(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptLlmSecret: plaintext is empty");
  }
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a value produced by encryptLlmSecret. Throws on any
 * version / format / tag-mismatch failure. Callers must catch —
 * a failed decrypt usually means either (a) the key was rotated
 * without re-encrypting old rows, or (b) the row was tampered
 * with, or (c) the encryption key is wrong.
 */
export function decryptLlmSecret(stored: string): string {
  if (!stored) throw new Error("decryptLlmSecret: empty input");
  const parts = stored.split(".");
  if (parts.length !== 4) {
    throw new Error(
      "decryptLlmSecret: malformed input (expected v1.<iv>.<tag>.<ciphertext>)",
    );
  }
  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new Error(`decryptLlmSecret: unsupported version '${version}'`);
  }
  const iv = Buffer.from(ivB64 ?? "", "base64");
  if (iv.length !== IV_LEN) {
    throw new Error(
      `decryptLlmSecret: bad IV length ${iv.length}; expected ${IV_LEN}`,
    );
  }
  const tag = Buffer.from(tagB64 ?? "", "base64");
  if (tag.length !== TAG_LEN) {
    throw new Error(
      `decryptLlmSecret: bad tag length ${tag.length}; expected ${TAG_LEN}`,
    );
  }
  const ciphertext = Buffer.from(ctB64 ?? "", "base64");
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  return plaintext;
}

/**
 * True when the input looks like it was produced by
 * encryptLlmSecret. Cheap shape check; does NOT verify the tag.
 * Useful for lazy-migration flows that need to tell an
 * encrypted-at-rest value apart from a legacy plaintext one.
 */
export function looksEncrypted(stored: string): boolean {
  return (
    typeof stored === "string" &&
    /^v\d+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(stored)
  );
}

/**
 * Base64-preview of the last 4 chars of a secret, prefixed with
 * ****. Used for masked-key responses on the GET
 * /api/llm-credentials route so operators can confirm "yes that's
 * my key" without ever shipping the full string. Never call this
 * on a plaintext key that hasn't been rotated through decrypt —
 * always decrypt first, then preview.
 */
export function maskKey(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    return "****";
  }
  const tail = plaintext.slice(-4);
  return `****${tail}`;
}
