import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { z } from "zod";
import * as controller from "./audit.controller.js";

const router: import("express").Router = Router();

// ─── Superadmin : consulter l'historique d'activité ───────────────────────────
router.get("/", authenticate, requireRole("superadmin"), controller.listActivityLogs);

// ─── Superadmin : détail d'un log ─────────────────────────────────────────────
router.get("/:id", authenticate, requireRole("superadmin"), controller.getActivityLog);

export default router;
