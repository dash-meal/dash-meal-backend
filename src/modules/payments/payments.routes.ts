import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { InitiatePaymentSchema, RecordInPersonPaymentSchema, CreateOrderSchema } from "../../shared/index.js";
import * as controller from "./payments.controller.js";
import { env } from "../../config/env.js";
import type { Request, Response, NextFunction } from "express";

const router: import("express").Router = Router();

// ─── Nouveau flux : payer d'abord, commande créée après confirmation ──────────
router.post("/initiate-order", authenticate, requireRole("user"), validate(CreateOrderSchema), controller.initiateOrderPayment);

// ─── Paiement en ligne sur commande existante ─────────────────────────────────
router.post("/initiate", authenticate, requireRole("user"), validate(InitiatePaymentSchema), controller.initiatePayment);
// Webhook CamPay — secret token dans le query param (embarqué dans CAMPAY_CALLBACK_URL)
function verifyWebhookSecret(req: Request, res: Response, next: NextFunction) {
  const secret = req.query.secret as string | undefined;
  if (!secret || secret !== env.CAMPAY_WEBHOOK_SECRET) {
    res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Webhook non autorisé" } });
    return;
  }
  next();
}
router.post("/webhook/campay", verifyWebhookSecret, controller.campayWebhook);

// ─── Paiement en présentiel (enregistré par l'admin/caissier) ────────────────
router.post("/inperson", authenticate, requireRole("admin", "superadmin"), validate(RecordInPersonPaymentSchema), controller.recordInPersonPayment);

// ─── Statut temps réel (polling mobile) ───────────────────────────────────────
router.get("/status/:reference", authenticate, requireRole("user"), controller.getPaymentStatus);

// ─── Historique ───────────────────────────────────────────────────────────────
router.get("/order/:orderId", authenticate, controller.getPaymentByOrder);

// ─── Solde Campay (superadmin) ────────────────────────────────────────────────
router.get("/balance", authenticate, requireRole("superadmin"), controller.getCampayBalance);

export default router;
