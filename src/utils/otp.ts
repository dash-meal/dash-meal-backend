import { supabase } from "../config/supabase.js";
import { OTP_EXPIRES_IN_MINUTES, OTP_LENGTH } from "../shared/index.js";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

function generateCode(): string {
  return Math.floor(
    Math.pow(10, OTP_LENGTH - 1) +
    Math.random() * 9 * Math.pow(10, OTP_LENGTH - 1)
  )
    .toString()
    .padStart(OTP_LENGTH, "0");
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (phone.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("237")) return `+${digits}`;
  return `+237${digits}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function sendOtp(phone: string): Promise<{ code: string; smsSent: boolean }> {
  const normalized = normalizePhone(phone);
  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_EXPIRES_IN_MINUTES * 60 * 1000);

  await supabase.from("otps").upsert(
    { phone, otp: code, expires_at: expiresAt.toISOString() },
    { onConflict: "phone" }
  );

  if (env.OTP_LOG_CODES) logger.info(`[OTP][SMS] ${normalized}: ${code} (expire dans ${OTP_EXPIRES_IN_MINUTES} min)`);

  if (!env.AT_API_KEY || !env.AT_USERNAME) {
    logger.warn("AT_API_KEY / AT_USERNAME manquants — SMS non envoyé");
    return { code, smsSent: false };
  }

  try {
    const params = new URLSearchParams({
      username: env.AT_USERNAME,
      to:       normalized,
      message:  `Votre code de vérification Dash Meal : ${code}. Valable ${OTP_EXPIRES_IN_MINUTES} minutes.`,
    });
    if (env.AT_SENDER_ID) params.set("from", env.AT_SENDER_ID);

    const response = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        "apiKey":       env.AT_API_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept":       "application/json",
      },
      body: params.toString(),
    });

    const result = await response.json() as {
      SMSMessageData?: { Recipients?: { statusCode: number; messageId: string }[] };
    };

    const recipient = result.SMSMessageData?.Recipients?.[0];
    if (!response.ok || !recipient || recipient.statusCode !== 101) {
      logger.error({ status: response.status, result }, "Échec SMS Africa's Talking");
      return { code, smsSent: false };
    }

    logger.info({ phoneSuffix: normalized.slice(-4), messageId: recipient.messageId }, "SMS OTP envoyé");
    return { code, smsSent: true };
  } catch (err) {
    logger.error({ err }, "Erreur réseau SMS Africa's Talking");
    return { code, smsSent: false };
  }
}

/** Vérifie un OTP envoyé par SMS (clé : phone) */
export async function verifyOtp(phone: string, code: string): Promise<boolean> {
  const { data } = await supabase
    .from("otps")
    .select("id")
    .eq("phone", phone)
    .eq("otp", code)
    .gt("expires_at", new Date().toISOString())
    .single();

  if (!data) return false;

  await supabase.from("otps").delete().eq("id", data.id);
  return true;
}

/** Vérifie un OTP envoyé par email (clé : email) */
export async function verifyEmailOtp(email: string, code: string): Promise<boolean> {
  const normalizedEmail = normalizeEmail(email);
  const { data, error } = await supabase
    .from("otps")
    .select("id")
    .eq("email", normalizedEmail)
    .eq("otp", code)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, "[verifyEmailOtp] Lecture OTP échouée");
    return false;
  }

  if (!data) return false;

  await supabase.from("otps").delete().eq("id", data.id);
  return true;
}
