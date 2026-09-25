import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { documentUpload } from "../../middleware/upload.js";
import * as controller from "./documents.controller.js";

const router: import("express").Router = Router();

// ─── Marque : uploader un document pour sa demande d'accès ───────────────────
router.post(
  "/upload",
  documentUpload.single("file"),
  controller.uploadDocument
);

// ─── Superadmin : voir tous les documents d'une demande ──────────────────────
router.get(
  "/:applicationId",
  authenticate,
  requireRole("superadmin"),
  controller.listApplicationDocuments
);

// ─── Superadmin : marquer un document comme vérifié ──────────────────────────
router.patch(
  "/:id/verify",
  authenticate,
  requireRole("superadmin"),
  controller.verifyDocument
);

// ─── Superadmin : supprimer un document ──────────────────────────────────────
router.delete(
  "/:id",
  authenticate,
  requireRole("superadmin"),
  controller.deleteDocument
);

export default router;
