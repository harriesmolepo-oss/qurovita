// apps/backend/src/auth.ts
//
// OTP-based patient authentication.
//
// Dev:  OTP 000000 is always accepted (no SMS).
// Prod: Twilio Verify integration — 🔴 HUMAN ACTION NEEDED before go-live.
//       Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID.

import type { FastifyInstance } from "fastify";
import { pool } from "./db.js";
import { seedSampleData } from "./services/sample-fhir.js";

// Extend @fastify/jwt types so req.user is typed throughout the app
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; phone: string };
    user: { sub: string; phone: string };
  }
}

// In-memory OTP store: phone → { otp, expiresAt }
// Dev only — OTPs are never sent via SMS; 000000 is always valid.
const otpStore = new Map<string, { otp: string; expiresAt: number }>();
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function authRoutes(app: FastifyInstance) {
  /**
   * Request an OTP for a phone number.
   * Dev: OTP is always 000000 — no SMS is sent.
   * Prod: Twilio Verify will dispatch the SMS (not yet wired).
   */
  app.post("/auth/otp-request", async (req, reply) => {
    const body = req.body as { phone?: string } | undefined;
    if (!body?.phone) {
      return reply.code(400).send({ error: "phone required" });
    }
    const phone = body.phone.trim();

    if (process.env.NODE_ENV !== "production") {
      otpStore.set(phone, { otp: "000000", expiresAt: Date.now() + OTP_TTL_MS });
      return reply.send({ ok: true, dev_hint: "use OTP 000000" });
    }

    // 🔴 HUMAN ACTION NEEDED: wire Twilio Verify here (T5.2 / T1.3 prod path).
    // Until then, production cannot send real OTPs.
    return reply.code(501).send({ error: "SMS OTP not yet configured for production" });
  });

  /**
   * Verify the OTP and return a signed JWT.
   * Body: { phone, otp }
   * Response: { token }
   */
  app.post("/auth/otp-verify", async (req, reply) => {
    const body = req.body as { phone?: string; otp?: string } | undefined;
    if (!body?.phone || !body?.otp) {
      return reply.code(400).send({ error: "phone and otp required" });
    }
    const phone = body.phone.trim();
    const otp = body.otp.trim();

    const stored = otpStore.get(phone);
    if (!stored || stored.otp !== otp || Date.now() > stored.expiresAt) {
      return reply.code(401).send({ error: "invalid or expired OTP" });
    }

    otpStore.delete(phone);

    // Look up or create a user record keyed by phone_e164
    const upsert = await pool.query<{ id: string }>(
      `insert into users (display_name, phone_e164)
       values ($1, $2)
       on conflict (phone_e164) do update set phone_e164 = excluded.phone_e164
       returning id`,
      [`Patient ${phone}`, phone],
    );
    const userId = upsert.rows[0].id;

    // Seed sample FHIR data on first login (idempotent, awaited so callers see live data)
    await seedSampleData(userId);

    const token = app.jwt.sign({ sub: userId, phone });
    return reply.send({ token });
  });
}
