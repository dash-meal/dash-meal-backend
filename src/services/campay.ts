/**
 * CamPay Payment Service
 *
 * API reference: https://documenter.getpostman.com/view/2391374/T1LV8PVA
 * Sandbox: https://demo.campay.net/
 * Production: https://www.campay.net/
 *
 * All endpoints are prefixed with /api/
 * Authentication: POST /api/token/ → { token, expiresIn }
 * Authorization header: "Token {token}"
 */

import { env } from "../config/env.js";
import { AppError } from "../middleware/errorHandler.js";
import { logger } from "../utils/logger.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CamPayStatus = "SUCCESSFUL" | "FAILED" | "PENDING";

export interface CamPayCollectResponse {
  reference: string;
  ussd_code?: string;
  operator?: string; // "MTN" | "Orange"
}

export interface CamPayTransactionStatus {
  reference: string;
  status: CamPayStatus;
  amount: number;
  currency: string;
  operator: string;
  code: string;
  operator_reference: string;
}

export interface CamPayBalanceResponse {
  total_balance: number;
  mtn_balance: number;
  orange_balance: number;
  currency: string;
}

export interface CamPayWithdrawResponse {
  reference: string;
  status: string;
  operator?: string;
}

// ─── Operator detection & minimums ───────────────────────────────────────────

/**
 * Cameroon mobile prefixes (9-digit local format, first 3 digits):
 *   MTN:    650-654, 658-659, 670-679, 680-687
 *   Orange: 655-657, 688-689, 690-699
 */
function detectOperator(phone: string): "MTN" | "Orange" | "unknown" {
  const digits = normalizePhone(phone); // 237XXXXXXXXX
  // Extract the 3 digits after country code 237 (positions 3-5)
  const prefix = parseInt(digits.slice(3, 6), 10);
  if (isNaN(prefix)) return "unknown";

  if (
    (prefix >= 650 && prefix <= 654) ||
    (prefix >= 658 && prefix <= 659) ||
    (prefix >= 670 && prefix <= 679) ||
    (prefix >= 680 && prefix <= 687)
  ) return "MTN";

  if (
    (prefix >= 655 && prefix <= 657) ||
    (prefix >= 688 && prefix <= 689) ||
    (prefix >= 690 && prefix <= 699)
  ) return "Orange";

  return "unknown";
}

// Message générique renvoyé au client — jamais le détail brut du prestataire
// (ni son nom) dans une réponse visible par l'utilisateur final.
const GENERIC_PROVIDER_ERROR = "Une erreur est survenue, veuillez contacter le support.";

const CAMPAY_MIN_AMOUNT: Record<"MTN" | "Orange" | "unknown", number> = {
  MTN:     100, // MTN Mobile Money minimum
  Orange:   10, // Orange Money minimum
  unknown: 100, // conservative fallback
};

// ─── Token cache (module-level singleton) ────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: number; // timestamp ms
}

let _tokenCache: TokenCache | null = null;

function baseUrl(): string {
  return env.CAMPAY_BASE_URL.replace(/\/$/, "");
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const now = Date.now();

  // Reuse cached token if it has more than 60s remaining
  if (_tokenCache && _tokenCache.expiresAt > now + 60_000) {
    return _tokenCache.token;
  }

  const res = await fetch(`${baseUrl()}/api/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: env.CAMPAY_APP_USERNAME,
      password: env.CAMPAY_APP_PASSWORD,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CamPay auth failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { token: string; expiresIn?: number };
  const ttl = (data.expiresIn ?? 3600) * 1000; // default 1h
  _tokenCache = { token: data.token, expiresAt: now + ttl };
  return data.token;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise un numéro de téléphone au format CamPay : 237XXXXXXXXX
 * Gère les cas :
 *   +237690123456  → 237690123456
 *   00237690123456 → 237690123456
 *   237690123456   → 237690123456  (déjà bon)
 *   690123456      → 237690123456  (numéro local Cameroun 9 chiffres)
 */
function normalizePhone(phone: string): string {
  // Supprimer tout sauf les chiffres
  const digits = phone.replace(/\D/g, "");

  // 00237... → supprimer le 00
  if (digits.startsWith("00237")) return digits.slice(2);

  // Déjà au bon format 237 + 9 chiffres = 12 chiffres
  if (digits.startsWith("237") && digits.length === 12) return digits;

  // Numéro local : 9 chiffres commençant par 6, 7, 8 ou 9 (Cameroun)
  if (digits.length === 9 && /^[6789]/.test(digits)) return `237${digits}`;

  // Numéro avec indicatif sans le + : ex 237690... mais longueur différente
  if (digits.startsWith("237")) return digits;

  // Fallback : retourner tel quel (laisse CamPay rejeter si vraiment invalide)
  return digits;
}

async function authHeader(): Promise<{ Authorization: string; "Content-Type": string }> {
  const token = await getToken();
  return {
    "Content-Type": "application/json",
    Authorization: `Token ${token}`,
  };
}

// ─── API calls ────────────────────────────────────────────────────────────────

/**
 * Initiate a Mobile Money collection (debit the customer).
 * Campay sends a USSD push notification to the customer's phone.
 */
export async function campayCollect(params: {
  amount: number;
  phone: string;
  description: string;
  externalReference: string;
  paymentMethod?: string; // e.g. "orange_money" | "mtn_mobile_money" | "mobile_money"
}): Promise<CamPayCollectResponse> {
  // Trust explicit payment method selection over phone-prefix detection
  let operator: "MTN" | "Orange" | "unknown";
  if (params.paymentMethod === "orange_money") {
    operator = "Orange";
  } else if (params.paymentMethod === "mtn_mobile_money") {
    operator = "MTN";
  } else {
    operator = detectOperator(params.phone);
  }
  const minAmount = CAMPAY_MIN_AMOUNT[operator];

  if (params.amount < minAmount) {
    const operatorLabel = operator === "unknown" ? "Mobile Money" : `${operator} Mobile Money`;
    throw new AppError(
      400,
      "AMOUNT_TOO_LOW",
      `Le montant minimum pour ${operatorLabel} est de ${minAmount} FCFA. Montant actuel : ${params.amount} FCFA.`,
    );
  }

  const headers = await authHeader();

  // Campay accepte "MTN Mobile Money" | "Orange Money" comme payment_method
  const campayPaymentMethod =
    operator === "MTN"    ? "MTN Mobile Money" :
    operator === "Orange" ? "Orange Money"      :
    undefined;

  const res = await fetch(`${baseUrl()}/api/collect/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      amount: String(params.amount),
      currency: "XAF",
      from: normalizePhone(params.phone),
      description: params.description,
      external_reference: params.externalReference,
      ...(campayPaymentMethod ? { payment_method: campayPaymentMethod } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, "[Campay collect] Réponse en erreur");
    throw new AppError(502, "CAMPAY_ERROR", GENERIC_PROVIDER_ERROR);
  }

  return res.json() as Promise<CamPayCollectResponse>;
}

/**
 * Check the status of a transaction by its reference.
 * Poll this until status is SUCCESSFUL or FAILED.
 */
export async function campayTransactionStatus(
  reference: string,
): Promise<CamPayTransactionStatus> {
  const headers = await authHeader();

  const res = await fetch(`${baseUrl()}/api/transaction/${reference}/`, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CamPay status check failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<CamPayTransactionStatus>;
}

/**
 * Disburse money to a phone number (requires withdrawal enabled in CamPay dashboard).
 * Used for refunds or driver payouts.
 */
export async function campayWithdraw(params: {
  amount: number;
  phone: string;
  description: string;
  externalReference: string;
}): Promise<CamPayWithdrawResponse> {
  const normalized = normalizePhone(params.phone);
  const operator = detectOperator(params.phone);

  // Validation montant minimum avant d'appeler Campay
  const minAmount = CAMPAY_MIN_AMOUNT[operator];
  if (params.amount < minAmount) {
    const label = operator === "unknown" ? "Mobile Money" : `${operator} Mobile Money`;
    throw new AppError(
      400,
      "AMOUNT_TOO_LOW",
      `Montant minimum pour ${label} : ${minAmount} FCFA. Montant demandé : ${params.amount} FCFA.`,
    );
  }

  const headers = await authHeader();

  const body: Record<string, string> = {
    amount:             String(params.amount),
    currency:           "XAF",
    to:                 normalized,
    description:        params.description,
    external_reference: params.externalReference,
  };

  // Orange Money nécessite le champ operator explicite
  if (operator === "Orange") body.operator = "Orange";
  if (operator === "MTN")    body.operator = "MTN";

  const res = await fetch(`${baseUrl()}/api/withdraw/`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const raw = await res.text();
    logger.error({ status: res.status, body: raw }, "[Campay withdraw] Réponse en erreur");
    throw new AppError(502, "CAMPAY_WITHDRAW_ERROR", GENERIC_PROVIDER_ERROR);
  }

  return res.json() as Promise<CamPayWithdrawResponse>;
}

/**
 * Virement Mobile Money pour un retrait de wallet — renvoie la référence Campay.
 * Les AppError (montant trop bas, refus Campay) remontent telles quelles ;
 * toute autre erreur (réseau, parsing…) est loguée et convertie en 502 CAMPAY_ERROR.
 */
export async function campayPayout(
  params: { amount: number; phone: string; description: string; externalReference: string },
  logTag: string,
): Promise<string> {
  try {
    const res = await campayWithdraw(params);
    return res.reference;
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    logger.error({ err, tag: logTag }, "Virement Campay échoué");
    throw new AppError(502, "CAMPAY_ERROR", "Une erreur est survenue, veuillez contacter le support.");
  }
}

/**
 * Lookup subscriber name for a phone number.
 * Returns null if Campay doesn't support it or the lookup fails.
 */
export async function campayGetSubscriberName(phone: string): Promise<{
  name: string;
  operator: "MTN" | "Orange" | "unknown";
} | null> {
  const normalized = normalizePhone(phone);
  const operator = detectOperator(phone);
  const headers = await authHeader();

  const res = await fetch(`${baseUrl()}/api/get-name/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ phone: normalized }),
  });

  const raw = await res.text();
  logger.debug({ status: res.status, body: raw }, "[Campay get-name] Réponse");

  if (!res.ok) {
    // Endpoint non supporté par ce compte Campay → traiter comme non disponible
    if (res.status === 404 || res.status === 403) return null;
    throw new AppError(502, "CAMPAY_ERROR", GENERIC_PROVIDER_ERROR);
  }

  let data: Record<string, unknown>;
  try { data = JSON.parse(raw); } catch { return null; }

  const name = (data.name ?? data.subscriber_name ?? data.fullname ?? null) as string | null;
  if (!name) return null;

  return { name, operator };
}

/**
 * Get current wallet balance (total, MTN, Orange).
 */
export async function campayBalance(): Promise<CamPayBalanceResponse> {
  const headers = await authHeader();

  const res = await fetch(`${baseUrl()}/api/balance/`, {
    method: "GET",
    headers,
  });

  if (!res.ok) {
    throw new Error(`CamPay balance check failed (${res.status})`);
  }

  return res.json() as Promise<CamPayBalanceResponse>;
}
