import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { CreateAdminSchema, CreateDriverSchema } from "../../shared/index.js";
import { imageUpload } from "../../middleware/upload.js";
import * as controller from "./admins.controller.js";

const router: import("express").Router = Router();

// ─── Gestion des drivers (admin de la marque) — AVANT /:id pour éviter le conflit ──
router.post("/drivers/upload-photo", authenticate, requireRole("admin", "superadmin"), imageUpload.single("photo"), controller.uploadDriverPhoto);
router.get("/drivers", authenticate, requireRole("admin", "superadmin"), controller.listDrivers);
router.get("/drivers/:id", authenticate, requireRole("admin", "superadmin"), controller.getDriver);
router.post("/drivers", authenticate, requireRole("admin", "superadmin"), validate(CreateDriverSchema), controller.createDriver);
router.patch("/drivers/:id", authenticate, requireRole("admin", "superadmin"), controller.updateDriver);
router.patch("/drivers/:id/toggle-active", authenticate, requireRole("admin", "superadmin"), controller.toggleDriverActive);
router.patch("/drivers/:id/pin", authenticate, requireRole("admin", "superadmin"), validate(z.object({ pin: z.string().min(4).max(8) })), controller.setDriverPin);

// ─── Gestion des admins (superadmin uniquement) ───────────────────────────────
router.get("/", authenticate, requireRole("superadmin"), controller.listAdmins);
router.get("/:id", authenticate, requireRole("superadmin"), controller.getAdmin);
router.post("/", authenticate, requireRole("superadmin"), validate(CreateAdminSchema), controller.createAdmin);
router.patch("/:id", authenticate, requireRole("superadmin"), controller.updateAdmin);
router.patch("/:id/toggle-active", authenticate, requireRole("superadmin"), controller.toggleAdminActive);
router.patch("/:id/reset-password", authenticate, requireRole("superadmin"), controller.resetAdminPassword);
router.delete("/:id", authenticate, requireRole("superadmin"), controller.deleteAdmin);

export default router;
