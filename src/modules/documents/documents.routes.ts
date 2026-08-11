import { Router } from "express";
import multer from "multer";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as controller from "./documents.controller.js";

const router: import("express").Router = Router();

// Stockage en mémoire (pas de fichier tmp sur disque) — max 10 Mo par fichier
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Type de fichier non autorisé (JPEG, PNG, WEBP, PDF uniquement)"));
    }
  },
});

// ─── Marque : uploader un document pour sa demande d'accès ───────────────────
router.post(
  "/upload",
  upload.single("file"),
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
