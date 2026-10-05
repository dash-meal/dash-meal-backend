import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as controller from "./promo-codes.controller.js";

const router: import("express").Router = Router();

// ─── Public (mobile) ─────────────────────────────────────────────────────────
router.get("/validate", controller.validatePromoCode);

// ─── Admin ────────────────────────────────────────────────────────────────────
router.get(  "/",    authenticate, requireRole("admin", "superadmin"), controller.listPromoCodes);
router.post( "/",    authenticate, requireRole("admin", "superadmin"), controller.createPromoCode);
router.patch("/:id", authenticate, requireRole("admin", "superadmin"), controller.updatePromoCode);
router.delete("/:id", authenticate, requireRole("admin", "superadmin"), controller.deletePromoCode);

export default router;
