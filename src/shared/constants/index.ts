// Commissions SaaS
export const COMMISSION_RATE_ONLINE = 0.02; // 2% pour paiement via l'app
export const COMMISSION_RATE_INPERSON = 0.015; // 1,5% pour paiement en présentiel

// Pagination
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Auth
export const JWT_ACCESS_EXPIRES_IN = "24h"; // TODO: remettre "15m" en production
export const JWT_REFRESH_EXPIRES_IN = "30d";
export const OTP_EXPIRES_IN_MINUTES = 10;
export const OTP_LENGTH = 6;

// Upload
export const MAX_IMAGE_SIZE_MB = 5;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Commandes
export const MIN_ORDER_COLLECT_ADVANCE_MINUTES = 30; // Click & Collect : min 30min à l'avance

// Locales supportées
export const SUPPORTED_LOCALES = ["fr", "en"] as const;
export const DEFAULT_LOCALE = "fr";

// Routes API
export const API_VERSION = "v1";
export const API_PREFIX = `/api/${API_VERSION}`;
