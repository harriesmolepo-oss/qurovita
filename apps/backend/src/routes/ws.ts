// apps/backend/src/routes/ws.ts
//
// WebSocket relay — /shared/ws/:sessionId
//
// Auth-exempt via the /shared/ prefix in isExempt (app.ts).
// The session UUID is the access credential.
//
// Gate-before-listeners: the DB validity check runs before socket.on()
// is called and before the socket joins the room. This prevents an
// unvalidated connection from relaying bytes to existing room members
// while the gate query is in flight.
//
// @fastify/websocket v10 supports async wsHandlers: index.js line 193
// checks result.catch and routes errors to errorHandler.
//
// Session gate: expires_at > now AND revoked_at IS NULL.
// claimed_at is NOT gated — HTTP POST /shared/qr-sessions/:id/claim
// owns that state transition; the WS layer is a pure relay.
//
// Late-joiner protection (C1.b): bundle_transferred sentinel closes all
// room sockets and deletes the room entry. Late joiners can connect to a
// still-valid session but land in a fresh single-peer room with no sender.

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
  app.get("/shared/ws/:sessionId", { websocket: true }, async (socket: WebSocket, req) => {
    const sessionId = (req.params as any).sessionId as string;
    const role = ((req.query as any).role as Role) ?? "patient";

    // ── GATE ────────────────────────────────────────────────────────────────
    const r = await pool.query<{
      expires_at: Date;
      revoked_at: Date | null;
      claimed_at: Date | null;
    }>(
      `select expires_at, revoked_at, claimed_at from qr_sessions where id = $1`,
      [sessionId],
    );

    if (r.rowCount === 0) {
      await auditLog({
        actor_kind: role, action: "ws.reject",
        target_type: "QrSession", target_id: sessionId,
        details: { reason: "not_found" },
      });
      try { socket.send(JSON.stringify({ type: "error", error: "session not found" })); } catch { /* broken */ }
      socket.close(1008, "session not found");
      return;
    }

    const row = r.rows[0];
    if (row.expires_at.getTime() < Date.now()) {
      await auditLog({
        actor_kind: role, action: "ws.reject",
        target_type: "QrSession", target_id: sessionId,
        details: { reason: "expired" },
      });
      try { socket.send(JSON.stringify({ type: "error", error: "session expired" })); } catch { /* broken */ }
      socket.close(1008, "session expired");
      return;
    }

    if (row.revoked_at !== null) {
      await auditLog({
        actor_kind: role, action: "ws.reject",
        target_type: "QrSession", target_id: sessionId,
        details: { reason: "revoked" },
      });
      try { socket.send(JSON.stringify({ type: "error", error: "session revoked" })); } catch { /* broken */ }
      socket.close(1008, "session revoked");
      return;
    }

    // ── HANDLERS (registered only after gate passes) ─────────────────────────
    socket.on("message", async (raw: Buffer) => {
      const peers = rooms.get(sessionId) ?? [];
      const others = peers.filter(p => p.socket !== socket);

      for (const p of others) {
        try { p.socket.send(raw); } catch { /* peer gone */ }
      }

      try {
        const txt = raw.toString("utf8");
        if (txt.startsWith("{")) {
          const msg = JSON.parse(txt) as { type?: string };
          if (msg.type === "bundle_transferred") {
            const all = rooms.get(sessionId) ?? [];
            rooms.delete(sessionId);
            for (const p of all) {
              try { p.socket.close(); } catch { /* already gone */ }
            }
            // actor_kind reflects which side sent the sentinel;
            // in patient-push mode this is the patient.
            await auditLog({
              actor_kind: role, action: "qr.session.bundle_transferred",
              target_type: "QrSession", target_id: sessionId,
            });
          }
        }
      } catch { /* binary payload */ }
    });

    socket.on("close", () => {
      const peers = rooms.get(sessionId) ?? [];
      const next = peers.filter(p => p.socket !== socket);
      if (next.length === 0) rooms.delete(sessionId);
      else rooms.set(sessionId, next);
    });

    // ── JOIN + ANNOUNCE (only after gate passes and handlers are wired) ──────
    const room = rooms.get(sessionId) ?? [];
    room.push({ socket, role });
    rooms.set(sessionId, room);

    socket.send(JSON.stringify({ type: "joined", role, peers: room.length }));

    await auditLog({
      actor_kind: role, action: "ws.join",
      target_type: "QrSession", target_id: sessionId,
    });
  });
}
