// apps/backend/src/routes/assistant.ts
import type { FastifyPluginAsync } from "fastify";
import { askAssistant, type Language } from "../services/ai-assistant.js";

const ALLOWED_LANGUAGES = new Set<Language>(["en", "zu", "st"]);
const MAX_MESSAGE_LENGTH = 500;

export const assistantRoute: FastifyPluginAsync = async (app) => {
  app.post("/assistant/ask", async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = request.body as Record<string, unknown> | null;

    if (!body || typeof body !== "object") {
      return reply.status(400).send({ code: "INVALID_REQUEST" });
    }

    const { message, language: rawLang } = body as {
      message?: unknown;
      language?: unknown;
    };

    if (typeof message !== "string" || message.trim().length === 0) {
      return reply.status(400).send({ code: "INVALID_REQUEST" });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return reply.status(400).send({ code: "INPUT_TOO_LONG" });
    }

    const language: Language =
      typeof rawLang === "string" && ALLOWED_LANGUAGES.has(rawLang as Language)
        ? (rawLang as Language)
        : "en";

    const result = await askAssistant({ userId, message, language });

    return reply.status(200).send({
      verdict:    result.verdict,
      text:       result.text,
      violations: result.violations,
    });
  });
};
