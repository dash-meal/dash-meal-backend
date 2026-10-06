import { Resend } from "resend";
import { env } from "../config/env.js";
import { OTP_EXPIRES_IN_MINUTES } from "../shared/index.js";
import { supabase } from "../config/supabase.js";
import { logger } from "./logger.js";

type SendEmailResult = { ok: boolean; id?: string };

// Adresses dédiées sur le domaine dash-meal.com (vérifié chez Resend).
export const FROM_OTP = "otp@dash-meal.com";
export const FROM_SUPPORT = "support@dash-meal.com";
// Réservée pour un futur module RH, pas encore utilisée par un flux d'envoi.
export const FROM_HR = "hr@dash-meal.com";

let resendClient: Resend | null = null;

function getResendClient(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  if (!resendClient) resendClient = new Resend(env.RESEND_API_KEY);
  return resendClient;
}

async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
}): Promise<SendEmailResult> {
  const client = getResendClient();

  if (!client) {
    logger.warn({ to: params.to, subject: params.subject }, "RESEND_API_KEY manquante — email non envoyé");
    return { ok: false };
  }

  try {
    const { data, error } = await client.emails.send({
      from: params.from ?? env.RESEND_FROM_EMAIL,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });

    if (error) {
      logger.error({ err: error, to: params.to }, "Envoi email échoué");
      return { ok: false };
    }

    return { ok: true, id: data?.id };
  } catch (error) {
    logger.error({ err: error, to: params.to }, "Erreur lors de l'envoi email");
    return { ok: false };
  }
}

function generateOtpCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function sendCodeByEmail(email: string, code: string): Promise<{ emailSent: boolean }> {
  const normalizedEmail = normalizeEmail(email);
  if (env.OTP_LOG_CODES) logger.info(`[OTP][EMAIL] ${normalizedEmail}: ${code} (expire dans ${OTP_EXPIRES_IN_MINUTES} min)`);

  const expiresAt = new Date(Date.now() + OTP_EXPIRES_IN_MINUTES * 60 * 1000);
  await supabase.from("otps").delete().eq("email", normalizedEmail);
  await supabase
    .from("otps")
    .insert({ email: normalizedEmail, otp: code, expires_at: expiresAt.toISOString() });

  const result = await sendEmail({
    to: normalizedEmail,
    subject: "Code OTP Dash Meal",
    html: `<p>Votre code OTP Dash Meal est :</p><h2>${code}</h2><p>Valable ${OTP_EXPIRES_IN_MINUTES} minutes.</p>`,
    text: `Votre code OTP Dash Meal est: ${code}. Valable ${OTP_EXPIRES_IN_MINUTES} minutes.`,
    from: FROM_OTP,
  });

  return { emailSent: result.ok };
}

export async function sendEmailOtp(email: string): Promise<{ emailSent: boolean; code: string }> {
  const normalizedEmail = normalizeEmail(email);
  const code = generateOtpCode();
  const { emailSent } = await sendCodeByEmail(normalizedEmail, code);
  return { emailSent, code };
}

export async function sendBranchLiveRequestEmail(input: {
  adminEmail: string;
  adminName: string;
  branchName: string;
  branchEmail: string;
}): Promise<{ sent: boolean }> {
  const result = await sendEmail({
    to: input.adminEmail,
    subject: `Demande de mise en ligne - ${input.branchName}`,
    html: `<p>Bonjour ${input.adminName},</p><p>L'agence <strong>${input.branchName}</strong> a demande sa mise en ligne.</p><p>Email agence: ${input.branchEmail}</p>`,
    text: `Bonjour ${input.adminName}, l'agence ${input.branchName} a demande sa mise en ligne. Email agence: ${input.branchEmail}`,
  });

  return { sent: result.ok };
}

export async function sendBranchLiveDecisionEmail(input: {
  to: string;
  branchName: string;
  approved: boolean;
  reason?: string;
}): Promise<{ sent: boolean }> {
  const decision = input.approved ? "approuvee" : "refusee";
  const reasonLine = input.reason ? `<p>Motif: ${input.reason}</p>` : "";

  const result = await sendEmail({
    to: input.to,
    subject: `Decision mise en ligne - ${input.branchName}`,
    html: `<p>Votre demande de mise en ligne pour <strong>${input.branchName}</strong> est ${decision}.</p>${reasonLine}`,
    text: `Votre demande de mise en ligne pour ${input.branchName} est ${decision}.${input.reason ? ` Motif: ${input.reason}` : ""}`,
  });

  return { sent: result.ok };
}

export async function sendLegalDocsSubmittedEmail(input: {
  brandName: string;
  adminEmail: string;
}): Promise<{ sent: boolean }> {
  const result = await sendEmail({
    to: input.adminEmail,
    subject: `Documents legaux soumis - ${input.brandName}`,
    html: `<p>Les documents legaux de <strong>${input.brandName}</strong> ont ete soumis pour validation.</p>`,
    text: `Les documents legaux de ${input.brandName} ont ete soumis pour validation.`,
  });

  return { sent: result.ok };
}

export async function sendLegalDocsDecisionEmail(input: {
  to: string;
  brandName: string;
  approved: boolean;
  reason?: string;
}): Promise<{ sent: boolean }> {
  const decision = input.approved ? "approuves" : "refuses";

  const result = await sendEmail({
    to: input.to,
    subject: `Decision documents legaux - ${input.brandName}`,
    html: `<p>Les documents legaux de <strong>${input.brandName}</strong> sont ${decision}.</p>${input.reason ? `<p>Motif: ${input.reason}</p>` : ""}`,
    text: `Les documents legaux de ${input.brandName} sont ${decision}.${input.reason ? ` Motif: ${input.reason}` : ""}`,
  });

  return { sent: result.ok };
}

export async function sendCollectQrEmail(input: {
  to: string;
  customerName: string;
  orderId: string;
  qrToken: string;
  qrImageDataUrl: string;
  numericCode: string;
  branchName: string;
  slotDate: string;
  slotTime: string;
  total: number;
}): Promise<{ sent: boolean }> {
  const result = await sendEmail({
    to: input.to,
    subject: `Votre QR code de retrait - Commande ${input.orderId.slice(0, 8)}`,
    html: `
      <p>Bonjour ${input.customerName},</p>
      <p>Votre commande est confirmee pour retrait chez <strong>${input.branchName}</strong>.</p>
      <p>Date: ${input.slotDate} | Horaire: ${input.slotTime}</p>
      <p>Total: ${input.total}</p>
      <p>Code numerique: <strong>${input.numericCode}</strong></p>
      <p>Token QR: ${input.qrToken}</p>
      <p><img src="${input.qrImageDataUrl}" alt="QR code" style="max-width:280px;" /></p>
    `,
    text: `Bonjour ${input.customerName}, commande ${input.orderId} chez ${input.branchName}. Date ${input.slotDate}, horaire ${input.slotTime}, total ${input.total}. Code: ${input.numericCode}. Token: ${input.qrToken}`,
  });

  return { sent: result.ok };
}
