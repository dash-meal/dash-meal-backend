import { z } from "zod";
import "./loadEnvFiles.js";
import { logger } from "../utils/logger.js";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGINS: z.string().default("https://dashmeal.vercel.app,https://dash-meal.com,https://www.dash-meal.com,https://dashmeal-3ix5.onrender.com,exp://,http://localhost:3000,http://localhost:8081"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  AT_API_KEY:    z.string().min(1),
  AT_USERNAME:   z.string().min(1),
  AT_SENDER_ID:  z.string().default(""),
  OTP_EXPOSE_CODE: z.coerce.boolean().default(false),
  OTP_LOG_CODES: z.coerce.boolean().default(false),

  CAMPAY_APP_USERNAME: z.string().min(1),
  CAMPAY_APP_PASSWORD: z.string().min(1),
  CAMPAY_BASE_URL: z.string().url(),
  CAMPAY_CALLBACK_URL: z.string().url(),
  CAMPAY_WEBHOOK_SECRET: z.string().min(16),

  GOOGLE_MAPS_API_KEY: z.string().min(1),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().email().default("support@dash-meal.com"),

  STORAGE_BUCKET_PRODUCTS: z.string().default("product-images"),
  STORAGE_BUCKET_DOCUMENTS: z.string().default("brand-documents"),
  STORAGE_BUCKET_INVOICES: z.string().default("invoices"),
  STORAGE_BUCKET_ADS: z.string().default("ad-images"),
});

function loadEnv() {
  const result = EnvSchema.safeParse(process.env);
  if (!result.success) {
    logger.fatal(
      { issues: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) },
      "Variables d'environnement manquantes ou invalides"
    );
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
