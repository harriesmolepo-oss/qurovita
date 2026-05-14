// backend/src/crypto/keys.ts
//
// In production this loads from AWS KMS. For the local demo we generate
// once and cache to ./.keys/ — DO NOT ship a real key this way.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { p256 } from "@noble/curves/p256";
import { logger } from "../logger.js";

const KEYS_DIR = join(process.cwd(), ".keys");
const PRIV_PATH = join(KEYS_DIR, "ecdsa-signing.priv");
const PUB_PATH = join(KEYS_DIR, "ecdsa-signing.pub");

let cached: { priv: Uint8Array; pub: Uint8Array } | null = null;

export function loadOrCreateSigningKey(): { priv: Uint8Array; pub: Uint8Array } {
  if (cached) return cached;

  if (!existsSync(KEYS_DIR)) mkdirSync(KEYS_DIR, { recursive: true });

  if (existsSync(PRIV_PATH) && existsSync(PUB_PATH)) {
    cached = {
      priv: new Uint8Array(readFileSync(PRIV_PATH)),
      pub: new Uint8Array(readFileSync(PUB_PATH)),
    };
    return cached;
  }

  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, true);
  writeFileSync(PRIV_PATH, priv);
  writeFileSync(PUB_PATH, pub);
  logger.info("Generated demo ECDSA signing key in .keys/ (NEVER do this in prod — use KMS).");
  cached = { priv, pub };
  return cached;
}

export function signingPubKeyHex(): string {
  return Buffer.from(loadOrCreateSigningKey().pub).toString("hex");
}
