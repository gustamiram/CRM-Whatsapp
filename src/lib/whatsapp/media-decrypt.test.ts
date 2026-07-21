import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  decryptWhatsappMedia,
  fetchAndDecryptWhatsappMedia,
  baseMimetype,
  extensionForMedia,
  type WhatsappMediaKind,
} from "./media-decrypt";

const MEDIA_INFO_BY_KIND: Record<WhatsappMediaKind, string> = {
  image: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  audio: "WhatsApp Audio Keys",
  document: "WhatsApp Document Keys",
};

/** Mirrors WhatsApp's media-encryption scheme exactly (the inverse of
 *  decryptWhatsappMedia) so the roundtrip can be verified without a
 *  real captured ciphertext — same HKDF expansion, AES-256-CBC, and
 *  trailing 10-byte HMAC-SHA256 MAC. */
function encryptWhatsappMediaForTest(
  plaintext: Buffer,
  mediaKeyBase64: string,
  kind: WhatsappMediaKind,
): Buffer {
  const mediaKey = Buffer.from(mediaKeyBase64, "base64");
  const expanded = Buffer.from(
    crypto.hkdfSync("sha256", mediaKey, Buffer.alloc(0), MEDIA_INFO_BY_KIND[kind], 112),
  );
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);

  const cipher = crypto.createCipheriv("aes-256-cbc", cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = crypto
    .createHmac("sha256", macKey)
    .update(Buffer.concat([iv, ciphertext]))
    .digest()
    .subarray(0, 10);
  return Buffer.concat([ciphertext, mac]);
}

const MEDIA_KEY_B64 = crypto.randomBytes(32).toString("base64");

describe("decryptWhatsappMedia", () => {
  it("round-trips for every media kind", () => {
    const plaintext = Buffer.from("hello whatsapp media, this is test content padding");
    for (const kind of Object.keys(MEDIA_INFO_BY_KIND) as WhatsappMediaKind[]) {
      const encrypted = encryptWhatsappMediaForTest(plaintext, MEDIA_KEY_B64, kind);
      const decrypted = decryptWhatsappMedia(encrypted, MEDIA_KEY_B64, kind);
      expect(decrypted.equals(plaintext)).toBe(true);
    }
  });

  it("throws on a MAC mismatch (tampered ciphertext)", () => {
    const plaintext = Buffer.from("some voice note bytes");
    const encrypted = encryptWhatsappMediaForTest(plaintext, MEDIA_KEY_B64, "audio");
    encrypted[0] ^= 0xff; // flip a byte in the ciphertext
    expect(() => decryptWhatsappMedia(encrypted, MEDIA_KEY_B64, "audio")).toThrow(/MAC mismatch/);
  });

  it("throws on a wrong media kind (wrong HKDF info string)", () => {
    const plaintext = Buffer.from("some image bytes");
    const encrypted = encryptWhatsappMediaForTest(plaintext, MEDIA_KEY_B64, "image");
    expect(() => decryptWhatsappMedia(encrypted, MEDIA_KEY_B64, "video")).toThrow(/MAC mismatch/);
  });

  it("throws on input too short to contain a MAC", () => {
    expect(() => decryptWhatsappMedia(Buffer.alloc(5), MEDIA_KEY_B64, "audio")).toThrow(/too short/);
  });
});

describe("fetchAndDecryptWhatsappMedia", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("downloads and decrypts", async () => {
    const plaintext = Buffer.from("voice note payload");
    const encrypted = encryptWhatsappMediaForTest(plaintext, MEDIA_KEY_B64, "audio");
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => encrypted.buffer.slice(encrypted.byteOffset, encrypted.byteOffset + encrypted.byteLength),
    });

    const result = await fetchAndDecryptWhatsappMedia("https://mmg.whatsapp.net/x.enc", MEDIA_KEY_B64, "audio");
    expect(result.equals(plaintext)).toBe(true);
  });

  it("throws when the download fails", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchAndDecryptWhatsappMedia("https://x/y.enc", MEDIA_KEY_B64, "audio")).rejects.toThrow(
      /HTTP 404/,
    );
  });
});

describe("baseMimetype", () => {
  it("strips codec parameters", () => {
    expect(baseMimetype("audio/ogg; codecs=opus", "audio/ogg")).toBe("audio/ogg");
  });
  it("falls back when absent", () => {
    expect(baseMimetype(undefined, "audio/ogg")).toBe("audio/ogg");
  });
});

describe("extensionForMedia", () => {
  it("derives from the mimetype subtype", () => {
    expect(extensionForMedia("audio/ogg; codecs=opus", "audio")).toBe("ogg");
    expect(extensionForMedia("image/jpeg", "image")).toBe("jpeg");
  });
  it("falls back to a per-kind default when mimetype is missing", () => {
    expect(extensionForMedia(undefined, "document")).toBe("bin");
  });
});
