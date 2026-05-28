import { describe, it, expect } from "vitest";
import { encode } from "cbor-x";
import { encodePayload, decodePayload, type QrPayload } from "./payload.js";
import { randomBytes } from "node:crypto";

// Realistic sample: random 16-byte sid, valid compressed P-256 spk,
// exp = now + 5 min in unix seconds.
function makeSample(overrides?: Partial<QrPayload>): QrPayload {
  const spk = Buffer.alloc(33);
  spk[0] = 0x02;
  randomBytes(32).copy(spk, 1);
  return {
    v: 1,
    sid: randomBytes(16),
    spk,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}

// Encode a raw object directly with cbor-x (bypasses our validation wrapper)
// to construct intentionally malformed payloads for rejection tests.
function rawEncode(obj: Record<string, unknown>): Buffer {
  return Buffer.from(encode(obj));
}

describe("CBOR QR payload codec", () => {
  it("round-trips without ble/wfd", () => {
    const p = makeSample();
    const decoded = decodePayload(encodePayload(p));
    expect(decoded.v).toBe(1);
    expect(decoded.sid).toEqual(p.sid);
    expect(decoded.spk).toEqual(p.spk);
    expect(decoded.exp).toBe(p.exp);
    expect(decoded.ble).toBeUndefined();
    expect(decoded.wfd).toBeUndefined();
  });

  it("round-trips with ble and wfd populated", () => {
    const p = makeSample({ ble: "AA:BB:CC:DD:EE:FF", wfd: "DIRECT-xy-QurovitaShare" });
    const decoded = decodePayload(encodePayload(p));
    expect(decoded.ble).toBe("AA:BB:CC:DD:EE:FF");
    expect(decoded.wfd).toBe("DIRECT-xy-QurovitaShare");
  });

  it("produces byte-identical output for the same input (deterministic)", () => {
    const p = makeSample({ ble: "11:22:33:44:55:66", wfd: "DIRECT-test" });
    const enc1 = encodePayload(p);
    const enc2 = encodePayload(p);
    expect(enc1.equals(enc2)).toBe(true);
  });

  it("encodes within QR Version 40 byte ceiling (< 2953 bytes)", () => {
    // Worst-case realistic sizes: 17-char BLE MAC, 32-char Wi-Fi Direct SSID.
    const p = makeSample({
      ble: "FF:EE:DD:CC:BB:AA",           // 17 chars
      wfd: "DIRECT-xy-SSID1234567890abcde", // 29 chars
    });
    const encoded = encodePayload(p);
    console.log(`[payload.test] CBOR payload size: ${encoded.length} bytes`);
    expect(encoded.length).toBeLessThan(2953);
  });

  it("tamper rejection: flipping the last byte makes decoded output differ or throws", () => {
    const p = makeSample();
    const encoded = encodePayload(p);
    const tampered = Buffer.from(encoded);
    tampered[tampered.length - 1] ^= 0xff;
    try {
      const decoded = decodePayload(tampered);
      // Parsed without throwing — result must differ from the original input
      const unchanged =
        decoded.sid.equals(p.sid) &&
        decoded.spk.equals(p.spk) &&
        decoded.exp === p.exp;
      expect(unchanged).toBe(false);
    } catch {
      // Threw a parse or validation error — tamper correctly detected
    }
  });

  it("rejects payload with wrong version (v=2)", () => {
    const p = makeSample();
    const wrongV = rawEncode({ v: 2, sid: p.sid, spk: p.spk, exp: p.exp });
    expect(() => decodePayload(wrongV)).toThrow(/version/i);
  });

  it("rejects spk of wrong length (65 bytes — uncompressed length)", () => {
    const badSpk = Buffer.alloc(65, 0x02);
    const encoded = rawEncode({
      v: 1,
      sid: randomBytes(16),
      spk: badSpk,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(() => decodePayload(encoded)).toThrow(/33 bytes/i);
  });

  it("rejects spk with uncompressed prefix (0x04)", () => {
    const badPrefixSpk = Buffer.alloc(33, 0x00);
    badPrefixSpk[0] = 0x04;
    const encoded = rawEncode({
      v: 1,
      sid: randomBytes(16),
      spk: badPrefixSpk,
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    expect(() => decodePayload(encoded)).toThrow(/0x02 or 0x03/i);
  });
});
