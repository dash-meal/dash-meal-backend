import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as controller from "./tracking.controller.js";

const router: Router = Router();

// ─── Mise à jour position GPS (livreur uniquement) ────────────────────────────
router.put(
  "/location",
  authenticate,
  requireRole("driver"),
  controller.updateLocation
);

// ─── Position du livreur pour une livraison active (user ou admin) ────────────
router.get(
  "/delivery/:order_id",
  authenticate,
  controller.getDeliveryLocation
);

// ─── Position brute d'un livreur (admin uniquement) ──────────────────────────
router.get(
  "/driver/:driver_id",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.getDriverLocation
);

export default router;
