// apps/backend/src/app.ts
// Exports buildApp() for both the server entry point and integration tests.
import Fastify, { type FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { authRoutes } from "./auth.js";
import { qrRoutes } from "./routes/qr.js";
import { wsRoutes } from "./routes/ws.js";
import { fhirRoutes } from "./routes/fhir.js";
import { sampleBundle } from "./services/sample-fhir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  /** Override global rate-limit max (useful in tests to trigger 429 cheaply). */
  rateLimitMax?: number;
  /** Suppress Fastify logger output in tests. */
  silent?: boolean;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.silent ? false : { level: "info" },
  });

  await app.register(fastifyCors, {
    origin: [/localhost:\d+$/],
    methods: ["GET", "POST", "OPTIONS"],
  });

  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? "dev-jwt-secret-do-not-use-in-production",
    sign: { expiresIn: "7d" },
  });

  // Global rate limit. Tests may pass a lower max to trigger 429s cheaply.
  await app.register(fastifyRateLimit, {
    max: opts.rateLimitMax ?? 60,
    timeWindow: "1 minute",
  });

  await app.register(fastifyWebsocket);
  await app.register(authRoutes);

  // Paths exempt from JWT verification
  const AUTH_EXEMPT = new Set(["/healthz", "/keys/ecdsa", "/"]);
  function isExempt(url: string): boolean {
    const path = url.split("?")[0];
    return AUTH_EXEMPT.has(path)
      || path.startsWith("/auth/")
      || path.startsWith("/patient/")
      || path.startsWith("/shared/");
  }

  app.addHook("onRequest", async (req, reply) => {
    if (isExempt(req.url)) return;
    const queryToken = (req.query as Record<string, string | undefined>)?.token;
    try {
      if (queryToken) {
        req.user = app.jwt.verify(queryToken);
      } else {
        await req.jwtVerify();
      }
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  await app.register(qrRoutes);
  await app.register(wsRoutes);
  await app.register(fhirRoutes);

  app.get("/sample-bundle", async () => sampleBundle("11111111-1111-1111-1111-111111111111"));

  await app.register(fastifyStatic, {
    root: join(__dirname, "..", "public", "patient"),
    prefix: "/patient/",
    decorateReply: false,
  });
  await app.register(fastifyStatic, {
    root: join(__dirname, "..", "public", "shared"),
    prefix: "/shared/",
    decorateReply: false,
  });

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send("<html><body><h1>QuroVita</h1></body></html>");
  });

  app.get("/healthz", async () => ({ ok: true, ts: Date.now() }));

  return app;
}
