import { Router } from "express";
import { z } from "zod";
import { authenticate, optionalAuthenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./reels.controller.js";

const router: import("express").Router = Router();

// ─── Schémas de validation ────────────────────────────────────────────────────

const CreateReelSchema = z.object({
  branch_id: z.string().uuid("L'identifiant d'agence est invalide"),
  video_url: z.string().url("URL vidéo invalide"),
  thumbnail_url: z.string().url("URL miniature invalide").optional(),
  caption: z.string().min(1, "La légende est requise").max(500),
  product_id: z.string().uuid().optional(),
});

const UpdateReelSchema = z.object({
  video_url: z.string().url("URL vidéo invalide").optional(),
  thumbnail_url: z.string().url("URL miniature invalide").optional(),
  caption: z.string().min(1).max(500).optional(),
  product_id: z.string().uuid().optional(),
  is_active: z.boolean().optional(),
});

const CommentSchema = z.object({
  content: z.string().min(1, "Le commentaire ne peut pas être vide").max(1000),
});

// ─── Routes publiques (avec auth optionnelle pour liked_by_user) ──────────────

router.get("/", optionalAuthenticate, controller.listReels);
router.get("/:id", optionalAuthenticate, controller.getReelById);
router.get("/:id/comments", controller.getComments);

// ─── Routes utilisateur authentifié ──────────────────────────────────────────

router.post("/:id/like", authenticate, controller.likeReel);
router.delete("/:id/like", authenticate, controller.unlikeReel);
router.post("/:id/comments", authenticate, validate(CommentSchema), controller.addComment);
router.delete("/:id/comments/:comment_id", authenticate, controller.deleteComment);

// ─── Routes admin / superadmin ────────────────────────────────────────────────

router.post(
  "/",
  authenticate,
  requireRole("admin", "superadmin"),
  validate(CreateReelSchema),
  controller.createReel
);

router.patch(
  "/:id",
  authenticate,
  requireRole("admin", "superadmin"),
  validate(UpdateReelSchema),
  controller.updateReel
);

router.delete(
  "/:id",
  authenticate,
  requireRole("admin", "superadmin"),
  controller.deleteReel
);

router.post(
  "/:id/comments/:comment_id/reply",
  authenticate,
  requireRole("admin", "superadmin"),
  validate(CommentSchema),
  controller.addAdminReply
);

export default router;
