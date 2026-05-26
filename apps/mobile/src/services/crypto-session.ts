/**
 * Patient-side ECDH session keys for QR share flows.
 *
 * CSIR-mandated: ECDH P-256, HKDF-SHA256, AES-256-GCM.
 * Key generation uses expo-crypto SubtleCrypto; HKDF/AES helpers align with @qurovita/crypto.
 */
import * as ExpoCrypto from 'expo-crypto';
import { p256 } from '@noble/curves/p256';
import { deriveSharedKey, encryptBundle, hex, unhex } from '@qurovita/crypto';
import * as SecureStore from 'expo-secure-store';

const PATIENT_ECDH_PRIV_KEY = 'qurovita_session_ecdh_priv_hex';
const PATIENT_ECDH_PUB_KEY = 'qurovita_session_ecdh_pub_hex';

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto SubtleCrypto is unavailable. Ensure expo-crypto is installed.');
  }
  return globalThis.crypto.subtle;
}

/** Ensure expo-crypto has installed the Web Crypto polyfill. */
export async function ensureWebCrypto(): Promise<void> {
  if (typeof ExpoCrypto.getRandomValues === 'function' && !globalThis.crypto?.subtle) {
    await ExpoCrypto.getRandomValues(new Uint8Array(1));
  }
}

function uncompressedToCompressed(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error('Expected 65-byte uncompressed P-256 public key');
  }
  const point = p256.ProjectivePoint.fromHex(uncompressed);
  return point.toRawBytes(true);
}

/** P-256 PKCS#8 private keys place the 32-byte scalar at the end of the structure. */
function pkcs8ToPrivate32(pkcs8: ArrayBuffer): Uint8Array {
  const bytes = new Uint8Array(pkcs8);
  if (bytes.length < 32) {
    throw new Error('Invalid PKCS#8 private key export');
  }
  return p256.utils.normPrivateKeyToScalar(bytes.slice(-32));
}

export interface PatientEcdhKeyMaterial {
  privateKey: Uint8Array;
  publicKeyCompressed: Uint8Array;
  publicKeyHex: string;
}

/**
 * Generate an ephemeral ECDH P-256 keypair via SubtleCrypto and return noble-compatible raw bytes.
 */
export async function generatePatientEcdhKeypair(): Promise<PatientEcdhKeyMaterial> {
  await ensureWebCrypto();
  const keyPair = await subtle().generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );

  const pubRaw = new Uint8Array(
    await subtle().exportKey('raw', keyPair.publicKey),
  );
  const privPkcs8 = new Uint8Array(
    await subtle().exportKey('pkcs8', keyPair.privateKey),
  );

  const privateKey = pkcs8ToPrivate32(privPkcs8.buffer);
  const publicKeyCompressed = uncompressedToCompressed(pubRaw);

  return {
    privateKey,
    publicKeyCompressed,
    publicKeyHex: hex(publicKeyCompressed),
  };
}

export async function persistPatientEcdhKeys(material: PatientEcdhKeyMaterial): Promise<void> {
  await SecureStore.setItemAsync(PATIENT_ECDH_PRIV_KEY, hex(material.privateKey));
  await SecureStore.setItemAsync(PATIENT_ECDH_PUB_KEY, material.publicKeyHex);
}

export async function loadPatientEcdhPrivateKey(): Promise<Uint8Array | null> {
  const stored = await SecureStore.getItemAsync(PATIENT_ECDH_PRIV_KEY);
  if (!stored) return null;
  return unhex(stored);
}

export async function clearPatientEcdhKeys(): Promise<void> {
  await SecureStore.deleteItemAsync(PATIENT_ECDH_PRIV_KEY).catch(() => undefined);
  await SecureStore.deleteItemAsync(PATIENT_ECDH_PUB_KEY).catch(() => undefined);
}

export function deriveSessionAesKey(
  patientPrivateKey: Uint8Array,
  peerPublicKeyCompressed: Uint8Array,
  sessionId: string,
): Uint8Array {
  return deriveSharedKey(patientPrivateKey, peerPublicKeyCompressed, sessionId);
}

export async function encryptFhirBundle(
  bundleJson: string,
  aesKey: Uint8Array,
  sessionId: string,
): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode(bundleJson);
  const aad = new TextEncoder().encode(sessionId);
  return encryptBundle(plaintext, aesKey, aad);
}
