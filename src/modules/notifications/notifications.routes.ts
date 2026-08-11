import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { z } from "zod";
import * as controller from "./notifications.controller.js";

const router: import("express").Router = Router();

const SendNotificationSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).optional(), // si absent = broadcast
  title_fr: z.string().min(1).max(200),
  title_en: z.string().min(1).max(200),
  body_fr: z.string().min(1).max(1000),
  body_en: z.string().min(1).max(1000),
  type: z.string().default("general"),
  data: z.record(z.unknown()).optional(),
});

// ─── Admin / Superadmin : historique des notifications ───────────────────────
router.get("/", authenticate, requireRole("admin", "superadmin"), controller.listNotifications);

// ─── Admin / Superadmin : envoyer une notification ────────────────────────────
router.post("/send", authenticate, requireRole("admin", "superadmin"), validate(SendNotificationSchema), controller.sendNotification);

// ─── Superadmin : broadcast à tous les utilisateurs ──────────────────────────
router.post("/broadcast", authenticate, requireRole("superadmin"), validate(SendNotificationSchema), controller.broadcastNotification);

export default router;
