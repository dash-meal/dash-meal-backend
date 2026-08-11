import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as controller from "./promotions.controller.js";

const router: Router = Router();

// ─── Routes publiques utilisateur ────────────────────────────────────────────
router.post("/validate", authenticate, controller.validatePromotion);
router.post("/apply", authenticate, controller.applyPromotion);

// ─── Routes admin / superadmin ────────────────────────────────────────────────
router.get(
  "/",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.listPromotions
);
router.post(
  "/",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.createPromotion
);
router.get(
  "/:id",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.getPromotion
);
router.patch(
  "/:id",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.updatePromotion
);
router.delete(
  "/:id",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.deletePromotion
);

export default router;
