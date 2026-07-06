/**
 * AES-256-GCM encryption / decryption for TikTok session cookies at
 * rest.
 *
 * Why encrypt these and not the AI provider keys?
 *   - AI provider keys are dangerous if leaked (someone can run up
 *     a bill on your account), but the blast radius is bounded by
 *     the provider's per-key quota.
 *   - A TikTok session cookie IS the user's account. Anyone who has
 *     it can post, message, buy, change settings, and (with TikTok
 *     Shop's affiliate creator portal) drain commission earnings.
 *     The blast radius is the entire account.
 *
 * Storage format on disk:
 *
 *     v1:<base64(iv)>:<base64(ciphertext + authTag)>
 *
 * The "v1:" prefix is a forward-compatibility marker so we can
 * rotate algorithms later without re-encrypting (we'd add a "v2:"
 * branch in `decrypt` and migrate lazily on the next save).
 *
 * Key source:
 *   process.env.TIKTOK_COOKIE_ENC_KEY  (32 bytes, base64-encoded)
 *
 * Generate with:
 *   openssl rand -base64 32
 *
 * The key must be present at boot. We fail loud (throw) on decrypt
 * if the key is missing — silently returning empty strings would
 * cause the TikHub layer to send invalid requests and we'd hunt
 * the bug forever.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // GCM standard
const KEY_LEN = 32; // 256 bits
const VERSION = "v1";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = (process.env.TIKTOK_COOKIE_ENC_KEY || "").trim();
  if (!raw) {
    throw new Error(
      "TIKTOK_COOKIE_ENC_KEY is unset. The BOF Dashboard cookie " +
        "storage needs a 32-byte base64 key — generate one with " +
        "`openssl rand -base64 32` and add it to your .env. " +
        "Decryption of existing TikTokAccount.cookieRaw rows will " +
        "fail until this is set.",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `TIKTOK_COOKIE_ENC_KEY decodes to ${buf.length} bytes; expected ` +
        `${KEY_LEN}. Regenerate with \`openssl rand -base64 32\`.`,
    );
  }
  cachedKey = buf;
  return buf;
}

/**
 * Encrypt a plaintext string. Returns the storage-format value
 * to write into TikTokAccount.cookieRaw.
 *
 * The IV is freshly random per call so two encrypts of the same
 * plaintext produce different ciphertexts — that's the GCM
 * security contract, and it also means the column reveals nothing
 * about duplication across rows.
 */
export function encryptCookie(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Concat ciphertext || authTag so decrypt can split by known
  // tag length. base64-encoded as one blob for a compact column.
  const payload = Buffer.concat([encrypted, tag]).toString("base64");
  return `${VERSION}:${iv.toString("base64")}:${payload}`;
}

/**
 * Decrypt a value previously produced by encryptCookie. Throws on
 * any version / format / tag-mismatch failure. Callers must catch
 * — a failed decrypt usually means either (a) the key was rotated
 * without re-encrypting old rows, or (b) the row was tampered with.
 */
export function decryptCookie(stored: string): string {
  if (!stored) throw new Error("decryptCookie: empty input");
  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new Error(
      "decryptCookie: malformed input (expected v1:<iv>:<payload>)",
    );
  }
  const [version, ivB64, payloadB64] = parts;
  if (version !== VERSION) {
    throw new Error(`decryptCookie: unsupported version '${version}'`);
  }
  const iv = Buffer.from(ivB64, "base64");
  if (iv.length !== IV_LEN) {
    throw new Error(
      `decryptCookie: bad IV length ${iv.length}; expected ${IV_LEN}`,
    );
  }
  const payload = Buffer.from(payloadB64, "base64");
  // GCM auth tag is the trailing 16 bytes.
  if (payload.length < 16) {
    throw new Error("decryptCookie: payload too short to contain auth tag");
  }
  const ciphertext = payload.subarray(0, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);

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
 * True when the input looks like it was produced by encryptCookie
 * (cheap shape check — useful when migrating existing plaintext
 * rows OR when deciding whether a value still needs the decrypt
 * round-trip). Does NOT verify the tag.
 */
export function looksEncrypted(stored: string): boolean {
  return typeof stored === "string" && /^v\d+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(stored);
}
