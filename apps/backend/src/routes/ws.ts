// backend/src/routes/ws.ts
//
// WebSocket route — substitute transport for BLE in the demo. The crypto layer
// above this is identical to the BLE path: the patient encrypts a FHIR Bundle
// with AES-256-GCM using the ECDH-derived shared key, the provider decrypts.
//
// Two roles can connect to /ws/:sessionId:
//   ?role=patient   — sends the encrypted bundle and the patient pubkey
//   ?role=provider  — receives the encrypted bundle and the patient pubkey
//
// The server is only a relay here. It cannot decrypt the bundle (it never
// has both ECDH privkeys in the patient↔provider direction). The "server"
// ECDH key in the QR is used for ECDSA-bound key establishment in the prod
// path; in this demo we forward the patient's ephemeral pubkey directly so
// the provider can derive the same key the patient used.

import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { auditLog } from "../services/audit.js";

type Role = "patient" | "provider";

interface Peer {
  socket: any; // fastify-websocket SocketStream
  role: Role;
}

const rooms = new Map<string, Peer[]>();

export async function wsRoutes(app: FastifyInstance) {
  app.get("/ws/:sessionId", { websocket: true }, async (conn, req) => {
    const sessionId = (req.params as any).sessionId as string;
    const role = ((req.query as any).role as Role) ?? "patient";

    // Validate session exists and is pending
    const r = await pool.query(
      `select id, status, expires_at from qr_sessions where id = $1`,
      [sessionId],
    );
    if (r.rowCount === 0) {
      conn.socket.send(JSON.stringify({ type: "error", error: "session not found" }));
      conn.socket.close();
      return;
    }
    const session = r.rows[0];
    if (session.status !== "pending") {
      conn.socket.send(JSON.stringify({ type: "error", error: `session ${session.status}` }));
      conn.socket.close();
      return;
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      await pool.query(`update qr_sessions set status='expired' where id=$1`, [sessionId]);
      conn.socket.send(JSON.stringify({ type: "error", error: "session expired" }));
      conn.socket.close();
      return;
    }

    const room = rooms.get(sessionId) ?? [];
    room.push({ socket: conn.socket, role });
    rooms.set(sessionId, room);

    conn.socket.send(JSON.stringify({ type: "joined", role, peers: room.length }));
    await auditLog({
      actor_kind: role, action: "ws.join", target_type: "QrSession", target_id: sessionId,
    });

    conn.socket.on("message", async (raw: Buffer) => {
      const peers = rooms.get(sessionId) ?? [];
      const others = peers.filter(p => p.socket !== conn.socket);

      // Relay verbatim — server is a blind relay
      for (const p of others) {
        try { p.socket.send(raw); } catch { /* peer gone */ }
      }

      // Best-effort message-type peek for audit + state transitions
      try {
        const txt = raw.toString("utf8");
        if (txt.startsWith("{")) {
          const msg = JSON.parse(txt);
          if (msg.type === "bundle_transferred") {
            await pool.query(
              `update qr_sessions set status='consumed', consumed_at = now()
               where id = $1 and status='pending'`,
              [sessionId],
            );
            await auditLog({
              actor_kind: "provider", action: "qr.session.consume",
              target_type: "QrSession", target_id: sessionId,
            });
          }
        }
      } catch {
        // binary payload (encrypted bundle bytes) — no peek
      }
    });

    conn.socket.on("close", () => {
      const peers = rooms.get(sessionId) ?? [];
      const next = peers.filter(p => p.socket !== conn.socket);
      if (next.length === 0) rooms.delete(sessionId);
      else rooms.set(sessionId, next);
    });
  });
}
