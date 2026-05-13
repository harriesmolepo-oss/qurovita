// backend/src/server.ts
import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { qrRoutes } from "./routes/qr.js";
import { wsRoutes } from "./routes/ws.js";
import { loadOrCreateSigningKey } from "./crypto/keys.js";
import { sampleBundle } from "./services/sample-fhir.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

const app = Fastify({ logger: { level: "info" } });

await app.register(fastifyWebsocket);
await app.register(qrRoutes);
await app.register(wsRoutes);

// Sample FHIR bundle endpoint — the patient app fetches this to pretend
// it has WatermelonDB data to share. In production, the patient app builds
// the bundle locally from its offline store.
app.get("/sample-bundle", async () => sampleBundle("11111111-1111-1111-1111-111111111111"));

// Serve the two clients (clients/ is at monorepo root, 3 levels above apps/backend/src/)
await app.register(fastifyStatic, {
  root: join(__dirname, "..", "..", "..", "clients", "patient"),
  prefix: "/patient/",
  decorateReply: false,
});
await app.register(fastifyStatic, {
  root: join(__dirname, "..", "..", "..", "clients", "provider"),
  prefix: "/provider/",
  decorateReply: false,
});
await app.register(fastifyStatic, {
  root: join(__dirname, "..", "..", "..", "clients", "shared"),
  prefix: "/shared/",
  decorateReply: false,
});

// Friendly root
app.get("/", async (_req, reply) => {
  reply.type("text/html").send(`
    <html><body style="font-family: system-ui; max-width: 640px; margin: 60px auto; padding: 20px">
    <h1>QuroVita v0 demo</h1>
    <p>Open these in two browser tabs:</p>
    <ul>
      <li><a href="/patient/">Patient app</a></li>
      <li><a href="/provider/">Provider portal</a></li>
    </ul>
    <p>API health: <code>GET /healthz</code> · ECDSA pubkey: <code>GET /keys/ecdsa</code></p>
    </body></html>
  `);
});

app.get("/healthz", async () => ({ ok: true, ts: Date.now() }));

// Warm up the signing key so any error surfaces at startup
loadOrCreateSigningKey();

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`\n  QuroVita demo listening on http://localhost:${PORT}`);
  console.log(`  Patient:  http://localhost:${PORT}/patient/`);
  console.log(`  Provider: http://localhost:${PORT}/provider/\n`);
});
