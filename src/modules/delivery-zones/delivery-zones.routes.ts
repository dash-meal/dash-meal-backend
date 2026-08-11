import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as controller from "./delivery-zones.controller.js";

const router: Router = Router();

// ─── Route publique (sans auth) ───────────────────────────────────────────────
router.get("/public/:branch_id", controller.getZonesPublic);

// ─── Routes authentifiées ─────────────────────────────────────────────────────
router.get(
  "/",
  authenticate,
  requireRole("admin", "superadmin", "branch_manager"),
  controller.listZones
);
router.post(
  "/",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.createZone
);
router.get(
  "/:id",
  authenticate,
  requireRole("admin", "superadmin", "branch_manager"),
  controller.getZone
);
router.patch(
  "/:id",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.updateZone
);
router.delete(
  "/:id",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.deleteZone
);

export default router;
