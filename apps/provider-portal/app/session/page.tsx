"use client";

import { useEffect, useRef, useState } from "react";
import {
  generateEcdhKeypair, deriveSharedKey, decryptBundle, verifyQr,
  hex, unhex,
} from "@/lib/crypto";

const API = "http://localhost:3000";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FhirResource { resourceType: string; [k: string]: unknown }
interface FhirEntry { resource: FhirResource }
interface FhirBundle { entry?: FhirEntry[] }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ts() { return new Date().toLocaleTimeString(); }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function SessionPage() {
  const [logs, setLogs]       = useState<{ text: string; cls: string }[]>([]);
  const [sid, setSid]         = useState("");
  const [loading, setLoading] = useState(false);
  const [bundle, setBundle]   = useState<FhirBundle | null>(null);
  const ecdsaPubRef           = useRef<Uint8Array | null>(null);

  function log(text: string, cls = "") {
    setLogs(prev => [{ text: `${ts()}  ${text}`, cls }, ...prev]);
  }

  // Load the ECDSA verify pubkey once on mount
  useEffect(() => {
    fetch(`${API}/keys/ecdsa`)
      .then(r => r.json())
      .then(({ pub_compressed_hex }: { pub_compressed_hex: string }) => {
        ecdsaPubRef.current = unhex(pub_compressed_hex);
        log(`Loaded QuroVita ECDSA verify key (${pub_compressed_hex.slice(0, 16)}…)`);
      })
      .catch(() => log("Failed to load ECDSA verify key", "err"));
  }, []);

  async function openSession() {
    const sessionId = sid.trim();
    if (!sessionId) return;
    setLoading(true);
    setBundle(null);

    try {
      // 1. Fetch QR payload by session id (substitute for camera scan)
      const payloadResp = await fetch(`${API}/qr-sessions/${sessionId}/payload`);
      if (!payloadResp.ok) throw new Error(`session lookup: ${await payloadResp.text()}`);
      const meta = await payloadResp.json() as {
        server_pub_compressed_hex: string;
        websocket_url?: string;
      };
      log(`Session fetched — server pubkey: ${meta.server_pub_compressed_hex.slice(0, 16)}…`);

      // 2. Derive provider-side shared key via ECDH
      const serverPub = unhex(meta.server_pub_compressed_hex);
      const { priv, pubCompressed } = generateEcdhKeypair();
      const sharedKey = deriveSharedKey(priv, serverPub, sessionId);
      log("Provider derived AES-256 session key via ECDH + HKDF-SHA256");

      // 3. Open WebSocket and signal ready
      const wsUrl = meta.websocket_url ?? `ws://localhost:3000/shared/ws/${sessionId}?role=provider`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        log("WebSocket open — signalling ready to patient");
        ws.send(JSON.stringify({ type: "ready", provider_pub: hex(pubCompressed) }));
      };

      ws.onmessage = async (ev) => {
        if (typeof ev.data !== "string") {
          // Binary — the encrypted bundle
          const ciphertext = new Uint8Array(ev.data as ArrayBuffer);
          log(`Received ${ciphertext.length} bytes ciphertext — decrypting…`);
          try {
            const aad = new TextEncoder().encode(sessionId);
            const pt = await decryptBundle(ciphertext, sharedKey, aad);
            const parsed: FhirBundle = JSON.parse(new TextDecoder().decode(pt));
            log(`Decryption OK — ${parsed.entry?.length ?? 0} FHIR resources`, "ok");
            setBundle(parsed);
          } catch (e) {
            log(`Decryption FAILED — ${(e as Error).message} (likely MITM or wrong key)`, "err");
          }
        } else {
          try {
            const msg = JSON.parse(ev.data) as { type: string; error?: string; role?: string; peers?: number };
            if (msg.type === "error") log(`server: ${msg.error}`, "err");
            if (msg.type === "joined") log(`joined as ${msg.role} (peers in room: ${msg.peers})`);
          } catch { /* ignore */ }
        }
      };

      ws.onclose = () => log("WebSocket closed");
      ws.onerror  = () => log("WebSocket error", "err");

    } catch (e) {
      log(`open failed: ${(e as Error).message}`, "err");
    } finally {
      setLoading(false);
    }
  }

  // Tamper test: corrupt the verify pubkey and call verifyQr
  function tamperTest() {
    if (!ecdsaPubRef.current) { log("ECDSA key not loaded yet", "warn"); return; }
    log("=== ECDSA tamper test ===");
    const corrupted = new Uint8Array(ecdsaPubRef.current);
    corrupted[5] ^= 0x01;
    try {
      verifyQr(new Uint8Array([0xa6]), corrupted);
      log("Unexpected: tamper not detected", "err");
    } catch (e) {
      log(`Tamper detected and rejected: "${(e as Error).message}"`, "ok");
    }
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      {/* Header */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>QuroVita — Provider Portal</h1>
        <span style={{ fontSize: 11, padding: "4px 8px", borderRadius: 999, background: "#e0f2fe", color: "#0369a1" }}>v0 demo</span>
      </header>

      {/* Source-of-truth banner */}
      <div style={{ background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", padding: "12px 16px", borderRadius: 10, marginBottom: 16, fontSize: 14 }}>
        <strong style={{ color: "#78350f" }}>⚠ Source-of-truth notice:</strong> Documents classified by OCR are shown with a
        pointer to the original image. The original image is the legal source of truth.
        The clinician is the legally accountable interpreter (HPCSA Booklet 9 + 20).
      </div>

      {/* Session input card */}
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, marginBottom: 16, border: "1px solid var(--line)" }}>
        <strong style={{ display: "block", marginBottom: 8 }}>Open a patient session</strong>
        <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
          In production this comes from a QR scan. For the demo, paste the session ID the patient shows you.
        </p>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={sid}
            onChange={e => setSid(e.target.value)}
            onKeyDown={e => e.key === "Enter" && openSession()}
            placeholder="Session ID (UUID from patient app)"
            style={{ flex: 1, padding: 10, border: "1px solid var(--line)", borderRadius: 8, fontSize: 14 }}
          />
          <button
            onClick={openSession}
            disabled={loading}
            style={{ background: "var(--accent)", color: "white", border: "none", padding: "10px 16px", borderRadius: 8, fontWeight: 600, cursor: "pointer", fontSize: 14, opacity: loading ? 0.5 : 1 }}
          >
            {loading ? "Opening…" : "Open Session"}
          </button>
        </div>
        <div style={{ marginTop: 8 }}>
          <button
            onClick={tamperTest}
            style={{ background: "white", color: "var(--text)", border: "1px solid var(--line)", padding: "8px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13 }}
          >
            Tamper test
          </button>
        </div>
      </div>

      {/* FHIR bundle render */}
      {bundle && (
        <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, marginBottom: 16, border: "1px solid var(--line)" }}>
          <strong style={{ display: "block", marginBottom: 4 }}>Records (read-only)</strong>
          <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 12 }}>
            Decrypted by AES-256-GCM with key established via ECDH P-256. Session auto-expires.
          </p>
          {(bundle.entry ?? []).map((entry, i) => (
            <ResourceCard key={i} resource={entry.resource} />
          ))}
        </div>
      )}

      {/* Activity log */}
      <div style={{ background: "var(--card)", borderRadius: 12, padding: 20, border: "1px solid var(--line)" }}>
        <strong style={{ display: "block", marginBottom: 8 }}>Activity</strong>
        <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, maxHeight: 200, overflowY: "auto", background: "#0f172a", color: "#cbd5e1", padding: 12, borderRadius: 8, lineHeight: 1.5 }}>
          {logs.length === 0 ? <span style={{ color: "#475569" }}>No activity yet.</span> : logs.map((l, i) => (
            <div key={i} style={{ color: l.cls === "ok" ? "#86efac" : l.cls === "err" ? "#fca5a5" : l.cls === "warn" ? "#fcd34d" : "#cbd5e1" }}>
              {l.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FHIR resource card
// ---------------------------------------------------------------------------
function ResourceCard({ resource }: { resource: FhirResource }) {
  const r = resource;
  let name = r.resourceType as string;
  let meta = "";

  switch (r.resourceType) {
    case "Patient": {
      const n = (r.name as { given?: string[]; family?: string }[])?.[0];
      name = `${(n?.given ?? []).join(" ")} ${n?.family ?? ""}`.trim();
      meta = `${r.gender ?? ""} · DOB ${r.birthDate ?? "—"} · ${(r.address as { city?: string }[])?.[0]?.city ?? ""}`;
      break;
    }
    case "Condition":
      name = (r.code as { text?: string })?.text ?? "Condition";
      meta = `Recorded ${r.recordedDate ?? "—"}`;
      break;
    case "MedicationStatement":
      name = (r.medicationCodeableConcept as { text?: string })?.text ?? "Medication";
      meta = `${r.status ?? ""} · ${(r.dosage as { text?: string }[])?.[0]?.text ?? ""}`;
      break;
    case "Observation": {
      name = (r.code as { text?: string })?.text ?? "Observation";
      const vq = r.valueQuantity as { value?: number; unit?: string } | undefined;
      meta = `${vq ? `${vq.value} ${vq.unit}` : ((r.valueString as string) ?? "")} · ${r.effectiveDateTime ?? ""}`;
      break;
    }
    case "AllergyIntolerance":
      name = (r.code as { text?: string })?.text ?? "Allergy";
      meta = `Reaction: ${((r.reaction as { manifestation?: { text?: string }[] }[])?.[0]?.manifestation?.[0]?.text) ?? "—"}`;
      break;
    default:
      meta = JSON.stringify(r).slice(0, 200);
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginBottom: 8, background: "#fafbfd" }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)", marginBottom: 4 }}>
        {r.resourceType as string}
      </div>
      <div style={{ fontWeight: 600, fontSize: 15 }}>{name}</div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>{meta}</div>
    </div>
  );
}
