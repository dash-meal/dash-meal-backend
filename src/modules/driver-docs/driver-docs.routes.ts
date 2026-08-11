import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { upload, getDriverDocs, uploadDriverDoc, listDriversKyc, reviewDriverKyc } from "./driver-docs.controller.js";

const router: Router = Router();

// ─── Liste des conducteurs avec statut KYC ────────────────────────────────────
router.get(
  "/list",
  authenticate,
  requireRole("admin", "superadmin"),
  listDriversKyc
);

// ─── Détails KYC d'un conducteur ─────────────────────────────────────────────
router.get(
  "/driver/:driver_id",
  authenticate,
  requireRole("admin", "superadmin"),
  getDriverDocs
);

// ─── Upload de document (conducteur pour soi-même, admin pour n'importe qui) ──
router.post(
  "/driver/:driver_id/upload",
  authenticate,
  upload.single("document"),
  uploadDriverDoc
);

// ─── Révision KYC ─────────────────────────────────────────────────────────────
router.post(
  "/driver/:driver_id/review",
  authenticate,
  requireRole("admin", "superadmin"),
  reviewDriverKyc
);

export default router;
