import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Variables factices — prioritaires sur .env.local (env.ts ne les écrase pas)
Object.assign(process.env, {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test",
  JWT_SECRET: "x".repeat(32),
  JWT_REFRESH_SECRET: "x".repeat(32),
  AT_API_KEY: "test",
  AT_USERNAME: "test",
  CAMPAY_APP_USERNAME: "test",
  CAMPAY_APP_PASSWORD: "test",
  CAMPAY_BASE_URL: "https://campay.test",
  CAMPAY_CALLBACK_URL: "https://api.test/payments/webhook/campay",
  CAMPAY_WEBHOOK_SECRET: "x".repeat(16),
  GOOGLE_MAPS_API_KEY: "test",
});

const { campayPayout } = await import("../src/services/campay.js");
const { AppError } = await import("../src/middleware/errorHandler.js");

type Handler = (url: string) => Response | Promise<Response>;
let withdrawHandler: Handler;
let calls: string[];

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/token/")) return Response.json({ token: "tok", expiresIn: 3600 });
    return withdrawHandler(url);
  }) as typeof fetch;
});

const params = { amount: 1000, phone: "690123456", description: "test", externalReference: "ref_1" };

test("succès : renvoie la référence Campay", async () => {
  withdrawHandler = () => Response.json({ reference: "CP-123", status: "PENDING" });
  assert.equal(await campayPayout(params, "test"), "CP-123");
});

test("erreur réseau : convertie en 502 CAMPAY_ERROR", async () => {
  withdrawHandler = () => { throw new TypeError("fetch failed"); };
  await assert.rejects(campayPayout(params, "test"), (err: any) =>
    err instanceof AppError && err.statusCode === 502 && err.code === "CAMPAY_ERROR");
});

test("refus Campay (HTTP non-2xx) : AppError d'origine propagée", async () => {
  withdrawHandler = () => new Response("nope", { status: 400 });
  await assert.rejects(campayPayout(params, "test"), (err: any) =>
    err instanceof AppError && err.statusCode === 502 && err.code === "CAMPAY_WITHDRAW_ERROR");
});

test("montant sous le minimum opérateur : 400 AMOUNT_TOO_LOW, aucun appel Campay", async () => {
  withdrawHandler = () => { throw new Error("ne doit pas être appelé"); };
  await assert.rejects(campayPayout({ ...params, amount: 5 }, "test"), (err: any) =>
    err instanceof AppError && err.statusCode === 400 && err.code === "AMOUNT_TOO_LOW");
  assert.equal(calls.length, 0);
});
