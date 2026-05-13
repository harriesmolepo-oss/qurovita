/**
 * E2E round-trip verification script for the QuroVita v0 demo.
 *
 * Requires:
 *   - Node 22+ (built-in WebSocket)
 *   - Backend running on localhost:3000
 *
 * Protocol (mirrors the real patient HTML + provider portal):
 *   1. Patient generates ECDH keypair, POSTs /qr-sessions
 *   2. Patient derives AES-256 session key: HKDF(ECDH(patient_priv, server_pub), sid)
 *   3. Patient opens WebSocket (?role=patient), waits for {type:"joined"}
 *   4. Provider opens WebSocket (?role=provider)
 *   5. Provider waits for its own {type:"joined", peers:2} — this confirms it is
 *      registered in the relay room before sending "ready". Without this wait,
 *      the patient's binary bundle arrives before the provider joins the room
 *      and is dropped by the relay (race condition).
 *   6. Provider sends {type:"ready", provider_pub:...}
 *   7. Patient receives "ready", fetches /sample-bundle, encrypts, sends binary
 *   8. Provider receives binary, decrypts, JSON-parses, asserts 9 FHIR resources
 *
 * Exit 0 on success, exit 1 on failure.
 */

import {
  generateEcdhKeypair,
  deriveSharedKey,
  encryptBundle,
  decryptBundle,
  hex,
  unhex,
} from "@qurovita/crypto";

const API = "http://localhost:3000";

const EXPECTED_TYPES = [
  "Patient",
  "Condition",
  "Condition",
  "MedicationStatement",
  "MedicationStatement",
  "Observation",
  "Observation",
  "Observation",
  "AllergyIntolerance",
];

// ── helpers ───────────────────────────────────────────────────────────────

const pass = (msg) => console.log(`  ✅  ${msg}`);
const fail = (msg) => { console.error(`  ❌  FAIL: ${msg}`); process.exit(1); };

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => resolve(ws));
    ws.addEventListener("error", () => reject(new Error(`WS connect failed: ${url}`)));
  });
}

/** Wait until a message arrives where predicate(parsedMsg, rawData) is truthy. */
function wsWaitFor(ws, predicate, label, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`)),
      timeoutMs
    );
    function onMessage(ev) {
      const raw = ev.data;
      // Relay sends Buffer → arrives as ArrayBuffer even for text-frame JSON.
      // Try to parse as JSON regardless of whether it's a string or ArrayBuffer.
      let msg = null;
      try {
        const text =
          typeof raw === "string"
            ? raw
            : new TextDecoder().decode(raw instanceof ArrayBuffer ? raw : new Uint8Array(raw));
        msg = JSON.parse(text);
      } catch {
        // binary payload (encrypted bundle) — msg stays null
      }
      if (predicate(msg, raw)) {
        clearTimeout(t);
        ws.removeEventListener("message", onMessage);
        resolve({ msg, raw });
      }
    }
    ws.addEventListener("message", onMessage);
  });
}

// ── step 1: patient ECDH keypair + POST /qr-sessions ─────────────────────

const patientEcdh = generateEcdhKeypair();

const sessRes = await fetch(`${API}/qr-sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ patient_pub_compressed_hex: hex(patientEcdh.pubCompressed) }),
});
if (!sessRes.ok) fail(`POST /qr-sessions → ${sessRes.status}: ${await sessRes.text()}`);
const { session_id, server_pub_compressed_hex, websocket_url } = await sessRes.json();
pass(`Session created: ${session_id}`);

// ── step 2: derive session key ────────────────────────────────────────────

const sharedKey = deriveSharedKey(
  patientEcdh.priv,
  unhex(server_pub_compressed_hex),
  session_id
);
pass(`Shared key derived (ECDH P-256 + HKDF-SHA256)`);

// ── step 3: patient WS — wait for joined ─────────────────────────────────

const patientWs = await wsConnect(`${websocket_url}?role=patient`);
// The server immediately sends {type:"joined"} on connect; wait for it
// so we know patient is registered before provider attempts to join.
await wsWaitFor(patientWs, (m) => m?.type === "joined", "patient joined");
pass(`Patient WebSocket open and joined`);

// Register the "ready" listener now (before provider even connects) to
// guarantee we don't miss the message.
const readyPromise = wsWaitFor(
  patientWs,
  (m) => m?.type === "ready",
  "ready signal from provider"
);

// ── step 4 + 5: provider WS — wait for joined (peers:2) before sending ready

const providerEcdh = generateEcdhKeypair();
const providerWs = await wsConnect(`${websocket_url}?role=provider`);

// CRITICAL: wait for {type:"joined"} before sending "ready".
// The server's async handler adds the provider to the relay room only AFTER
// its DB validation query resolves (~50–200 ms). If "ready" is sent before
// that, the patient receives "ready" and sends the binary bundle while the
// provider is still not in the room — and the relay drops the bundle.
await wsWaitFor(providerWs, (m) => m?.type === "joined", "provider joined");
pass(`Provider WebSocket open and joined (in relay room)`);

// Register bundle listener before patient sends anything.
const bundlePromise = wsWaitFor(
  providerWs,
  (_m, raw) => raw instanceof ArrayBuffer && raw.byteLength > 28, // iv(12) + tag(16) + at least 1 byte
  "encrypted binary bundle"
);

// ── step 6: provider signals ready ───────────────────────────────────────

providerWs.send(
  JSON.stringify({ type: "ready", provider_pub: hex(providerEcdh.pubCompressed) })
);
pass(`Provider sent {type:"ready"}`);

// ── step 7: patient receives ready, encrypts bundle, sends binary ────────

await readyPromise;
pass(`Patient received {type:"ready"}`);

const bundleRes = await fetch(`${API}/sample-bundle`);
if (!bundleRes.ok) fail(`GET /sample-bundle → ${bundleRes.status}`);
const bundleJson = await bundleRes.json();
const plaintext = new TextEncoder().encode(JSON.stringify(bundleJson));
const aad = new TextEncoder().encode(session_id);
const ciphertext = await encryptBundle(plaintext, sharedKey, aad);
pass(`Bundle encrypted: ${plaintext.length}B plaintext → ${ciphertext.length}B ciphertext (AES-256-GCM)`);

patientWs.send(ciphertext.buffer);
patientWs.send(JSON.stringify({ type: "bundle_transferred", bytes: ciphertext.length }));
pass(`Patient sent binary bundle`);

// ── step 8: provider decrypts + asserts ──────────────────────────────────

const { raw: wireData } = await bundlePromise;
pass(`Provider received ${wireData.byteLength}B binary`);

const plainBytes = await decryptBundle(new Uint8Array(wireData), sharedKey, aad);
pass(`AES-256-GCM decryption succeeded`);

const recovered = JSON.parse(new TextDecoder().decode(plainBytes));
if (recovered.resourceType !== "Bundle")
  fail(`Expected Bundle, got ${recovered.resourceType}`);

const entries = recovered.entry ?? [];
if (entries.length !== 9)
  fail(`Expected 9 FHIR resources, got ${entries.length}`);

const gotTypes = entries.map((e) => e.resource.resourceType);
const mismatches = EXPECTED_TYPES.filter((t, i) => gotTypes[i] !== t);
if (mismatches.length > 0)
  fail(`Resource type mismatch. Got: ${gotTypes.join(", ")}`);

pass(`Decrypted to Bundle — ${entries.length} resources: ${gotTypes.join(", ")}`);

patientWs.close();
providerWs.close();

console.log("\nROUND-TRIP OK: 9 resources\n");
