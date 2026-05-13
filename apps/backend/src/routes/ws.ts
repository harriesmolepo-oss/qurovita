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
//
// @fastify/websocket v10 API: handler receives (socket, req) where socket IS
// the raw WebSocket — not a SocketStream wrapper. Use socket.send() directly.
//
// IMPORTANT: register socket.on("message") and socket.on("close") before
// any await to avoid losing messages that arrive during async DB work.

import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { pool } from "../db.js";
import { auditLog } from "../services/audit.js";

type Role = "patient" | "provider";

interface Peer {
  socket: WebSocket;
  role: Role;
}

const rooms = new Map<string, Peer[]>();

export async function wsRoutes(app: FastifyInstance) {
  app.get("/ws/:sessionId", { websocket: true }, (socket: WebSocket, req) => {
    const sessionId = (req.params as any).sessionId as string;
    const role = ((req.query as any).role as Role) ?? "patient";

    // Register message + close handlers immediately (before any await) so
    // we never miss a message that arrives during async DB operations.
    socket.on("message", async (raw: Buffer) => {
      const peers = rooms.get(sessionId) ?? [];
      const others = peers.filter(p => p.socket !== socket);

      // Relay verbatim — server is a blind relay
      for (const p of others) {
        try { p.socket.send(raw); } catch { /* peer gone */ }
      }

      // Best-effort peek for audit + state transitions
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
        // binary payload — no peek needed
      }
    });

    socket.on("close", () => {
      const peers = rooms.get(sessionId) ?? [];
      const next = peers.filter(p => p.socket !== socket);
      if (next.length === 0) rooms.delete(sessionId);
      else rooms.set(sessionId, next);
    });

    // Async setup: validate session, join room, send "joined"
    void (async () => {
      const r = await pool.query(
        `select id, status, expires_at from qr_sessions where id = $1`,
        [sessionId],
      );
      if (r.rowCount === 0) {
        socket.send(JSON.stringify({ type: "error", error: "session not found" }));
        socket.close();
        return;
      }
      const session = r.rows[0];
      if (session.status !== "pending") {
        socket.send(JSON.stringify({ type: "error", error: `session ${session.status}` }));
        socket.close();
        return;
      }
      if (new Date(session.expires_at).getTime() < Date.now()) {
        await pool.query(`update qr_sessions set status='expired' where id=$1`, [sessionId]);
        socket.send(JSON.stringify({ type: "error", error: "session expired" }));
        socket.close();
        return;
      }

      const room = rooms.get(sessionId) ?? [];
      room.push({ socket, role });
      rooms.set(sessionId, room);

      socket.send(JSON.stringify({ type: "joined", role, peers: room.length }));
      await auditLog({
        actor_kind: role, action: "ws.join", target_type: "QrSession", target_id: sessionId,
      });
    })();
  });
}
