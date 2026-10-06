import "../config/loadEnvFiles.js";
import pino from "pino";

// Lit process.env directement (et non `env`) : config/env.ts utilise lui-même
// le logger pour signaler les variables invalides, avant que `env` n'existe.
const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

/**
 * Logger structuré de l'application.
 * - production : JSON sur stdout (lisible par les logs Render), niveau `info` par défaut
 * - développement : sortie colorée via pino-pretty, niveau `debug` par défaut
 * - test : silencieux par défaut
 * Le niveau peut être forcé avec LOG_LEVEL (trace, debug, info, warn, error, fatal, silent).
 *
 * Usage : logger.info({ orderId }, "Commande créée") — l'objet de contexte en
 * premier, le message ensuite. Les erreurs se passent sous la clé `err`.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (nodeEnv === "test" ? "silent" : isProduction ? "info" : "debug"),
  redact: {
    paths: [
      "password",
      "*.password",
      "token",
      "*.token",
      "access_token",
      "*.access_token",
      "refresh_token",
      "*.refresh_token",
      "authorization",
      "*.authorization",
      "*.headers.authorization",
      "otp",
      "*.otp",
    ],
    censor: "[REDACTED]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
});
