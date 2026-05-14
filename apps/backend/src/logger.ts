// Shared pino logger instance for non-route code (keys, migrate, etc.).
// Route handlers should use req.log or app.log (Fastify's built-in pino instance).
import pino from "pino";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
