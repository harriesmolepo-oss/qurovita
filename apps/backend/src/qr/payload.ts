import { Encoder, decode } from "cbor-x";

// Deterministic CBOR encoder for the OOB QR session payload.
//
// useRecords:false — use standard CBOR maps, not cbor-x's compact tagged-record
// format. The mobile decoder (and any future provider-portal decoder) must be
// able to read standard CBOR without a shared schema.
//
// Key ordering is guaranteed by always building the output object in the same
// explicit insertion sequence in encodePayload() below, so two calls with
// identical inputs produce byte-identical output.
const encoder = new Encoder({ useRecords: false });

export type QrPayload = {
  v: 1;
  sid: Buffer; // 16 raw bytes — UUID binary (no dashes)
  spk: Buffer; // 65 raw bytes — uncompressed P-256 public key (0x04 || X || Y)
  exp: number; // Unix epoch seconds (not milliseconds)
  ble?: string;
  wfd?: string;
};

export function encodePayload(p: QrPayload): Buffer {
  // Fixed insertion order guarantees byte-identical output across calls.
  const obj: Record<string, unknown> = {
    v: p.v,
    sid: p.sid,
    spk: p.spk,
    exp: p.exp,
  };
  if (p.ble !== undefined) obj.ble = p.ble;
  if (p.wfd !== undefined) obj.wfd = p.wfd;
  return Buffer.from(encoder.encode(obj));
}

export function decodePayload(b: Buffer): QrPayload {
  const raw = decode(b) as Record<string, unknown>;

  if (raw.v !== 1) {
    throw new Error(`Unsupported payload version: ${raw.v}`);
  }

  const sid = toBuffer(raw.sid);
  if (sid.length !== 16) {
    throw new Error(`sid must be 16 bytes, got ${sid.length}`);
  }

  const spk = toBuffer(raw.spk);
  if (spk.length !== 65) {
    throw new Error(`spk must be 65 bytes, got ${spk.length}`);
  }
  if (spk[0] !== 0x04) {
    throw new Error(
      `spk must be uncompressed P-256 (0x04 prefix), got 0x${spk[0].toString(16).padStart(2, "0")}`,
    );
  }

  const exp = raw.exp;
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp <= 0) {
    throw new Error(`exp must be a positive integer, got ${exp}`);
  }

  const result: QrPayload = { v: 1, sid, spk, exp };

  if (raw.ble !== undefined) {
    if (typeof raw.ble !== "string") throw new Error("ble must be a string");
    result.ble = raw.ble;
  }
  if (raw.wfd !== undefined) {
    if (typeof raw.wfd !== "string") throw new Error("wfd must be a string");
    result.wfd = raw.wfd;
  }

  return result;
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(`Expected bytes, got ${typeof value}`);
}
