import crypto from "node:crypto";

/**
 * Decrypt WhatsApp's own media-encryption scheme (HKDF-SHA256 ->
 * AES-256-CBC + a trailing 10-byte HMAC-SHA256 MAC) — the same
 * algorithm Baileys/whatsmeow use to decrypt media downloaded from
 * `mmg.whatsapp.net/.../*.enc`.
 *
 * UAZAPI (v1, Baileys-based) re-hosts an already-decrypted copy of
 * image/video/document media at its own URL, but passes the raw
 * WhatsApp CDN pointer straight through for `ptt`/audio messages —
 * confirmed via a captured webhook payload (2026-07-21) where the
 * audio message's `content` was `{ URL, mediaKey, mimetype, ... }`
 * pointing at an unconverted `.enc` blob, while image/document
 * messages arrive as a plain playable URL string. This module fixes
 * that gap by decrypting the blob ourselves once, at ingestion time.
 */

const MEDIA_INFO_BY_KIND = {
  image: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  audio: "WhatsApp Audio Keys",
  document: "WhatsApp Document Keys",
} as const;

export type WhatsappMediaKind = keyof typeof MEDIA_INFO_BY_KIND;

const MAC_LENGTH = 10;

/**
 * `encrypted` is the full raw response body downloaded from the
 * `.enc` URL — ciphertext followed by a trailing 10-byte MAC.
 * Throws on a MAC mismatch (corrupted download or wrong key) rather
 * than returning corrupted bytes.
 */
export function decryptWhatsappMedia(
  encrypted: Buffer,
  mediaKeyBase64: string,
  kind: WhatsappMediaKind,
): Buffer {
  if (encrypted.length <= MAC_LENGTH) {
    throw new Error(`Encrypted media too short (${encrypted.length} bytes)`);
  }

  const mediaKey = Buffer.from(mediaKeyBase64, "base64");
  // No salt (empty), 112-byte expansion: iv(16) + cipherKey(32) + macKey(32) + refKey(32, unused).
  const expanded = Buffer.from(
    crypto.hkdfSync("sha256", mediaKey, Buffer.alloc(0), MEDIA_INFO_BY_KIND[kind], 112),
  );
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);

  const ciphertext = encrypted.subarray(0, encrypted.length - MAC_LENGTH);
  const fileMac = encrypted.subarray(encrypted.length - MAC_LENGTH);

  const computedMac = crypto
    .createHmac("sha256", macKey)
    .update(Buffer.concat([iv, ciphertext]))
    .digest()
    .subarray(0, MAC_LENGTH);
  if (!crypto.timingSafeEqual(computedMac, fileMac)) {
    throw new Error("WhatsApp media MAC mismatch — corrupted download or wrong key");
  }

  const decipher = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Download the encrypted blob and decrypt it in one step. Throws on
 *  any network or decryption failure — callers should treat that as
 *  "media unavailable" rather than surfacing raw bytes. */
export async function fetchAndDecryptWhatsappMedia(
  url: string,
  mediaKeyBase64: string,
  kind: WhatsappMediaKind,
): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download encrypted media: HTTP ${res.status}`);
  }
  const encrypted = Buffer.from(await res.arrayBuffer());
  return decryptWhatsappMedia(encrypted, mediaKeyBase64, kind);
}

/** Strip any `; codecs=...`-style parameters — Storage's allow-list
 *  matches the bare MIME type, not the full Content-Type value. */
export function baseMimetype(mimetype: string | undefined, fallback: string): string {
  return mimetype?.split(";")[0]?.trim() || fallback;
}

const EXTENSION_BY_KIND: Record<WhatsappMediaKind, string> = {
  image: "jpg",
  video: "mp4",
  audio: "ogg",
  document: "bin",
};

/** Best-effort filename extension for the re-uploaded copy — cosmetic
 *  only; the stored `Content-Type` is what actually controls playback. */
export function extensionForMedia(mimetype: string | undefined, kind: WhatsappMediaKind): string {
  const subtype = mimetype?.split(";")[0]?.split("/")[1]?.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return subtype || EXTENSION_BY_KIND[kind];
}
