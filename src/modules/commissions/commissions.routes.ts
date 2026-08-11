import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as controller from "./commissions.controller.js";

const router: import("express").Router = Router();

// ─── Résumé global ────────────────────────────────────────────────────────────
router.get("/summary", authenticate, requireRole("admin", "superadmin"), controller.getCommissionsSummary);

// ─── Liste des commissions (superadmin : tout ; admin : sa marque) ────────────
router.get("/", authenticate, requireRole("admin", "superadmin"), controller.listCommissions);

// ─── Détail d'une commission ──────────────────────────────────────────────────
router.get("/:id", authenticate, requireRole("admin", "superadmin"), controller.getCommission);

// ─── Superadmin : marquer comme réglée ───────────────────────────────────────
router.patch("/:id/settle", authenticate, requireRole("superadmin"), controller.settleCommission);

// ─── Superadmin : régler plusieurs commissions d'un coup ─────────────────────
router.post("/settle-batch", authenticate, requireRole("superadmin"), controller.settleBatch);

export default router;
