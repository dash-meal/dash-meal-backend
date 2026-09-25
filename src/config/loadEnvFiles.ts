// Charge .env.local puis .env dans process.env (sans écraser les variables déjà définies).
// Module à effet de bord, importé en premier par config/env.ts et utils/logger.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

const currentFile = fileURLToPath(import.meta.url);
const backendRoot = path.resolve(path.dirname(currentFile), "../..");
loadEnvFile(path.join(backendRoot, ".env.local"));
loadEnvFile(path.join(backendRoot, ".env"));
