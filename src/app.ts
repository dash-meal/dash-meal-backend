import express, { type Application } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { API_PREFIX } from "./shared/index.js";
import { startStaleOrderNotifier } from "./services/staleOrderNotifier.js";
import { startKeepAlive } from "./services/keepAlive.js";

// Routes
import authRoutes          from "./modules/auth/auth.routes.js";
import branchAuthRoutes    from "./modules/branch-auth/branch-auth.routes.js";
import branchManagersRoutes from "./modules/branch-managers/branch-managers.routes.js";
import driverWalletRoutes  from "./modules/driver-wallet/driver-wallet.routes.js";
import branchHoursRoutes   from "./modules/branch-hours/branch-hours.routes.js";
import stockRoutes         from "./modules/stock/stock.routes.js";
import branchVerticalsRoutes from "./modules/branch-verticals/branch-verticals.routes.js";
import brandsRoutes from "./modules/brands/brands.routes.js";
import branchesRoutes from "./modules/branches/branches.routes.js";
import productsRoutes from "./modules/products/products.routes.js";
import ordersRoutes from "./modules/orders/orders.routes.js";
import paymentsRoutes from "./modules/payments/payments.routes.js";
import invoicesRoutes from "./modules/invoices/invoices.routes.js";
import chatRoutes from "./modules/chat/chat.routes.js";
import analyticsRoutes from "./modules/analytics/analytics.routes.js";
import cartRoutes from "./modules/cart/cart.routes.js";
import adminsRoutes from "./modules/admins/admins.routes.js";
import usersRoutes from "./modules/users/users.routes.js";
import collectRoutes from "./modules/collect/collect.routes.js";
import deliveryRoutes from "./modules/delivery/delivery.routes.js";
import notificationsRoutes from "./modules/notifications/notifications.routes.js";
import commissionsRoutes from "./modules/commissions/commissions.routes.js";
import documentsRoutes from "./modules/documents/documents.routes.js";
import auditRoutes from "./modules/audit/audit.routes.js";
import mapsRoutes from "./modules/maps/maps.routes.js";
import walletRoutes from "./modules/wallet/wallet.routes.js";
import adsRoutes from "./modules/ads/ads.routes.js";
import promotionsRoutes from "./modules/promotions/promotions.routes.js";
import loyaltyRoutes from "./modules/loyalty/loyalty.routes.js";
import deliveryZonesRoutes from "./modules/delivery-zones/delivery-zones.routes.js";
import driverDocsRoutes from "./modules/driver-docs/driver-docs.routes.js";
import reportsRoutes from "./modules/reports/reports.routes.js";
import favoritesRoutes from "./modules/favorites/favorites.routes.js";
import trackingRoutes from "./modules/tracking/tracking.routes.js";
import groupOrdersRoutes from "./modules/group-orders/group-orders.routes.js";
import driverRoutes from "./modules/driver/driver.routes.js";
import promoCodesRoutes  from "./modules/promo-codes/promo-codes.routes.js";
import userWalletRoutes  from "./modules/user-wallet/user-wallet.routes.js";

const app: Application = express();

// Render / reverse-proxy — faire confiance au premier proxy
app.set("trust proxy", 1);
// Désactiver ETags — évite les 304 Not Modified sur les endpoints de polling (ex: payment status)
app.disable("etag");

// ─── Sécurité ─────────────────────────────────────────────────────────────────
app.use(helmet());
const allowedOrigins = env.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, callback) => {
      // Appels server-to-server (webhooks, cron) n'ont pas d'origin
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origine non autorisée — ${origin}`));
    },
    credentials: true,
  })
);

// ─── Rate limiting global ─────────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: 4 * 60 * 1000, // 4 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: "RATE_LIMIT", message: "Trop de requêtes" } },
  })
);

// ─── Rate limiting strict pour auth ──────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 4 * 60 * 1000, // 4 minutes
  max: 20,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Trop de tentatives" } },
});

// Reset de mot de passe : 5 tentatives / 15 min par IP
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Trop de demandes de réinitialisation" } },
});

// Inscription : 10 tentatives / 1 heure par IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Trop d'inscriptions depuis cette adresse" } },
});

// Candidature marque : 5 tentatives / heure par IP
const applyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Trop de candidatures depuis cette adresse" } },
});

// ─── Parsing ──────────────────────────────────────────────────────────────────
// 1 MB suffit pour les requêtes JSON ; multer gère séparément les uploads binaires
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Logs ─────────────────────────────────────────────────────────────────────
if (env.NODE_ENV !== "test") {
  app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.get(`${API_PREFIX}/health`, (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Routes API ───────────────────────────────────────────────────────────────
// Rate limiters spécifiques appliqués avant les routes d'auth globales
app.use(`${API_PREFIX}/auth/user/register`,      registerLimiter);
app.use(`${API_PREFIX}/auth/user/request-reset`, resetLimiter);
app.use(`${API_PREFIX}/auth/driver/send-otp`,    resetLimiter);
app.use(`${API_PREFIX}/auth/apply`,              applyLimiter);
app.use(`${API_PREFIX}/auth`,                    authLimiter, authRoutes);
app.use(`${API_PREFIX}/branch-auth`,             authLimiter, branchAuthRoutes);
app.use(`${API_PREFIX}/branch-managers`,  branchManagersRoutes);
app.use(`${API_PREFIX}/driver-wallet`,    driverWalletRoutes);
app.use(`${API_PREFIX}/branch-hours`,     branchHoursRoutes);
app.use(`${API_PREFIX}/stock`,            stockRoutes);
app.use(`${API_PREFIX}/branch-verticals`, branchVerticalsRoutes);
app.use(`${API_PREFIX}/brands`, brandsRoutes);
app.use(`${API_PREFIX}/branches`, branchesRoutes);
app.use(`${API_PREFIX}/products`, productsRoutes);
app.use(`${API_PREFIX}/orders`, ordersRoutes);
app.use(`${API_PREFIX}/payments`, paymentsRoutes);
app.use(`${API_PREFIX}/invoices`, invoicesRoutes);
app.use(`${API_PREFIX}/chat`, chatRoutes);
app.use(`${API_PREFIX}/analytics`, analyticsRoutes);
app.use(`${API_PREFIX}/cart`, cartRoutes);
app.use(`${API_PREFIX}/admins`, adminsRoutes);
app.use(`${API_PREFIX}/users`, usersRoutes);
app.use(`${API_PREFIX}/collect`, collectRoutes);
app.use(`${API_PREFIX}/delivery`, deliveryRoutes);
app.use(`${API_PREFIX}/notifications`, notificationsRoutes);
app.use(`${API_PREFIX}/commissions`, commissionsRoutes);
app.use(`${API_PREFIX}/documents`, documentsRoutes);
app.use(`${API_PREFIX}/audit`, auditRoutes);
app.use(`${API_PREFIX}/maps`,   mapsRoutes);
app.use(`${API_PREFIX}/wallet`, walletRoutes);
app.use(`${API_PREFIX}/ads`,            adsRoutes);
app.use(`${API_PREFIX}/promotions`,    promotionsRoutes);
app.use(`${API_PREFIX}/loyalty`,       loyaltyRoutes);
app.use(`${API_PREFIX}/delivery-zones`, deliveryZonesRoutes);
app.use(`${API_PREFIX}/driver-docs`,   driverDocsRoutes);
app.use(`${API_PREFIX}/reports`,       reportsRoutes);
app.use(`${API_PREFIX}/favorites`,     favoritesRoutes);
app.use(`${API_PREFIX}/tracking`,      trackingRoutes);
app.use(`${API_PREFIX}/group-orders`,  groupOrdersRoutes);
app.use(`${API_PREFIX}/driver`,        driverRoutes);
app.use(`${API_PREFIX}/promo-codes`,   promoCodesRoutes);
app.use(`${API_PREFIX}/user-wallet`,   userWalletRoutes);

// ─── 404 ─────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: "Route introuvable" },
  });
});

// ─── Gestionnaire d'erreurs global ───────────────────────────────────────────
app.use(errorHandler);

// ─── Démarrage du serveur ────────────────────────────────────────────────────
app.listen(env.PORT, "0.0.0.0", () => {
  const host = process.env.RENDER_EXTERNAL_URL
    ?? `http://localhost:${env.PORT}`;
  console.log(`🚀 Dash Meal Backend démarré sur le port ${env.PORT}`);
  console.log(`   Environnement : ${env.NODE_ENV}`);
  console.log(`   API : ${host}${API_PREFIX}`);
  startStaleOrderNotifier();
  if (env.NODE_ENV === "production") startKeepAlive();
});

export default app as Application;
