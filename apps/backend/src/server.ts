// backend/src/server.ts — entry point (not used in tests)
import "dotenv/config";
import { buildApp } from "./app.js";
import { getSigningState } from "./kms.js";
import { scheduleDailySummary } from "./popia/breach.js";

const PORT = Number(process.env.PORT ?? 3000);

const app = await buildApp();

void getSigningState();
void scheduleDailySummary();

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  app.log.info(`QuroVita demo listening on http://localhost:${PORT}`);
  app.log.info(`Patient app: http://localhost:${PORT}/patient/`);
});
