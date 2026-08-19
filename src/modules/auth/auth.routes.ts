import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import {
  RegisterUserSchema,
  LoginUserSchema,
  VerifyOtpSchema,
  ResetPasswordSchema,
  LoginAdminSchema,
  RefreshTokenSchema,
} from "../../shared/index.js";
import * as controller from "./auth.controller.js";
import { z } from "zod";

const router: import("express").Router = Router();

// ─── Utilisateur (mobile) ─────────────────────────────────────────────────────
router.post(
  "/user/google",
  validate(z.object({ id_token: z.string().min(1, "Le token Google est requis") })),
  controller.googleAuth
);
router.post(
  "/user/supabase-oauth",
  validate(z.object({ supabase_token: z.string().min(1, "Token Supabase requis") })),
  controller.googleAuthSupabase
);
router.post(
  "/user/apple",
  validate(z.object({
    id_token:   z.string().min(1, "Le token Apple est requis"),
    first_name: z.string().optional(),
    last_name:  z.string().optional(),
  })),
  controller.appleAuth
);
router.post("/user/register", validate(RegisterUserSchema), controller.registerUser);
router.post("/user/verify-phone", validate(VerifyOtpSchema), controller.verifyPhone);
router.post(
  "/user/verify-email",
  validate(z.object({ email: z.string().email(), code: z.string().length(6) })),
  controller.verifyEmail
);
router.post("/user/login", validate(LoginUserSchema), controller.loginUser);
router.post(
  "/user/resend-email-otp",
  validate(z.object({ email: z.string().email() })),
  controller.resendEmailOtp
);
router.post("/user/request-reset", validate(z.object({ phone: z.string().min(8) })), controller.requestReset);
router.post("/user/reset-password", validate(ResetPasswordSchema), controller.resetPassword);

// ─── Livreur (mobile driver) ──────────────────────────────────────────────────
router.post(
  "/driver/login",
  validate(z.object({ phone: z.string().min(8), pin: z.string().min(4).max(8) })),
  controller.loginDriver,
);

// ─── Admin (marque) ───────────────────────────────────────────────────────────
router.post("/admin/login", validate(LoginAdminSchema), controller.loginAdmin);
router.post(
  "/admin/verify-otp",
  validate(z.object({ identifier: z.string().min(1), code: z.string().length(6) })),
  controller.verifyAdminOtp
);

// ─── Super Admin ──────────────────────────────────────────────────────────────
const StrongPassword = z.string()
  .min(12, "Le mot de passe doit contenir au moins 12 caractères")
  .refine((p) => /[A-Z]/.test(p), "Doit contenir une majuscule")
  .refine((p) => /[0-9]/.test(p), "Doit contenir un chiffre")
  .refine((p) => /[!@#$%^&*\-_]/.test(p), "Doit contenir un caractère spécial");

router.post(
  "/superadmin/register",
  validate(
    z.object({
      email: z.string().email(),
      phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
      password: StrongPassword,
    })
  ),
  controller.registerSuperAdmin
);
router.post("/superadmin/login", validate(LoginAdminSchema), controller.loginSuperAdmin);
router.post(
  "/superadmin/verify-otp",
  validate(z.object({ identifier: z.string().min(1), code: z.string().length(6) })),
  controller.verifySuperAdminOtp
);

// ─── Demande d'accès marque (landing page) ───────────────────────────────────
router.post(
  "/apply",
  validate(
    z.object({
      brand_name:    z.string().min(2),
      contact_name:  z.string().min(2),
      contact_email: z.string().email(),
      contact_phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
      city:          z.string().min(2),
      description:   z.string().min(20).max(500),
      password:      z.string().min(8),
    })
  ),
  controller.applyBrand
);

// ─── Commun ───────────────────────────────────────────────────────────────────
router.post("/refresh", validate(RefreshTokenSchema), controller.refreshTokens);

export default router;
