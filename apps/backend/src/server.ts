// backend/src/server.ts
import "dotenv/config";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { authRoutes } from "./auth.js";
import { qrRoutes } from "./routes/qr.js";
import { wsRoutes } from "./routes/ws.js";
import { getSigningState } from "./kms.js";
import { sampleBundle } from "./services/sample-fhir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = Fastify({ logger: { level: "info" } });

await app.register(fastifyCors, {
  origin: [/localhost:\d+$/],
  methods: ["GET", "POST", "OPTIONS"],
});

await app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET ?? "dev-jwt-secret-do-not-use-in-production",
  sign: { expiresIn: "7d" },
});

// Public routes — no auth required
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

// Guard all non-exempt routes.
// WebSocket upgrades can't set custom headers, so they pass the JWT via ?token=<jwt>.
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
  reply.type("text/html").send(`
    <html><body style="font-family: system-ui; max-width: 640px; margin: 60px auto; padding: 20px">
    <h1>QuroVita v0 demo</h1>
    <p>Open these in two browser tabs:</p>
    <ul>
      <li><a href="/patient/">Patient app</a></li>
      <li><a href="http://localhost:3001/session">Provider portal</a> (Next.js — run separately)</li>
    </ul>
    <p>API health: <code>GET /healthz</code> · ECDSA pubkey: <code>GET /keys/ecdsa</code></p>
    </body></html>
  `);
});

app.get("/healthz", async () => ({ ok: true, ts: Date.now() }));

// Warm up signing state so any KMS or file-key error surfaces at startup
void getSigningState();

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`\n  QuroVita demo listening on http://localhost:${PORT}`);
  console.log(`  Patient:  http://localhost:${PORT}/patient/`);
  console.log(`  Provider: http://localhost:${PORT}/provider/\n`);
});
