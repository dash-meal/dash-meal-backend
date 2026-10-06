import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { env } from "../../config/env.js";
import { createUpload } from "../../middleware/upload.js";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_SIZE_MB } from "../../shared/index.js";
import * as controller from "./ads.controller.js";

const router: import("express").Router = Router();

// Les pubs acceptent aussi les GIF animés, en plus des formats image standard
const imageUpload = createUpload({
  allowedTypes: [...ALLOWED_IMAGE_TYPES, "image/gif"],
  maxSizeMb: MAX_IMAGE_SIZE_MB,
  typesLabel: "JPEG, PNG, WEBP, GIF",
});

async function uploadAdImage(file: Express.Multer.File, brandId: string): Promise<string> {
  const ext = file.originalname.split(".").pop() ?? "jpg";
  const path = `${brandId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from(env.STORAGE_BUCKET_ADS ?? "ad-images")
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw new AppError(500, "UPLOAD_ERROR", `Upload échoué : ${error.message}`);
  const { data } = supabase.storage.from(env.STORAGE_BUCKET_ADS ?? "ad-images").getPublicUrl(path);
  return data.publicUrl;
}

// ─── Admin ────────────────────────────────────────────────────────────────────
router.get("/price",   authenticate, requireRole("admin"), controller.getAdPrice);
router.get("/",        authenticate, requireRole("admin"), controller.getMyAds);
router.delete("/:id",  authenticate, requireRole("admin"), controller.deleteMyAd);

// Étape 1 : upload image + initier paiement Campay
router.post(
  "/",
  authenticate,
  requireRole("admin"),
  imageUpload.single("image"),
  async (req, res, next) => {
    try {
      if (!req.file) throw new AppError(400, "MISSING_IMAGE", "Image requise");
      const { title, target_count, payment_phone, payment_method } = req.body;
      if (!title || !target_count) throw new AppError(400, "MISSING_FIELDS", "title et target_count requis");
      if (!payment_phone) throw new AppError(400, "PHONE_REQUIRED", "Numéro de téléphone requis");
      const parsed = parseInt(target_count);
      if (isNaN(parsed) || parsed < 6) throw new AppError(400, "INVALID_TARGET", "target_count doit être >= 6");

      const image_url = await uploadAdImage(req.file, req.user!.brand_id!);
      req.body.image_url    = image_url;
      req.body.target_count = parsed;
      req.body.payment_method = payment_method ?? "mobile_money";
      next();
    } catch (err) { next(err); }
  },
  controller.initiateAdPayment,
);

// Étape 2 : polling statut paiement
router.get("/payment/:reference/status", authenticate, requireRole("admin"), controller.getAdPaymentStatus);

// ─── Superadmin ───────────────────────────────────────────────────────────────
router.get(
  "/superadmin/all",
  authenticate, requireRole("superadmin"),
  controller.getAllAds,
);
router.patch(
  "/superadmin/:id/approve",
  authenticate, requireRole("superadmin"),
  controller.approveAd,
);
router.patch(
  "/superadmin/:id/reject",
  authenticate, requireRole("superadmin"),
  validate(z.object({ reason: z.string().min(5).optional() })),
  controller.rejectAd,
);
router.post(
  "/superadmin/withdraw",
  authenticate, requireRole("superadmin"),
  controller.superadminWithdraw,
);

// ─── Mobile ───────────────────────────────────────────────────────────────────
router.get("/public/active",   controller.getPublicActiveAds);
router.get("/user/active",     authenticate, controller.getAdForUser);
router.post("/:id/impression", authenticate, controller.recordImpression);

export default router;
