import { z } from "zod";

// ─── Utilisateur (mobile) ─────────────────────────────────────────────────────

export const RegisterUserSchema = z.object({
  name: z.string().min(2).max(100),
  phone: z
    .string()
    .regex(/^\+?[1-9]\d{7,14}$/, "Numéro de téléphone invalide"),
  password: z.string().min(8).max(100),
  email: z.string().email().optional(),
});

export const LoginUserSchema = z.object({
  identifier: z.string().min(1).optional(), // email ou téléphone
  email: z.string().email().optional(),
  phone: z.string().min(8).optional(),
  password: z.string().min(1),
}).refine((v) => Boolean(v.identifier || v.email || v.phone), {
  message: "Email ou téléphone requis",
  path: ["identifier"],
});

export const VerifyOtpSchema = z.object({
  phone: z.string().min(8),
  code: z.string().length(6),
});

export const ResetPasswordSchema = z.object({
  phone: z.string().min(8),
  code: z.string().length(6),
  new_password: z.string().min(8).max(100),
});

// ─── Admin ────────────────────────────────────────────────────────────────────

export const LoginAdminSchema = z.object({
  identifier: z.string().min(1), // email ou téléphone
  password: z.string().min(1),
});

export const CreateAdminSchema = z.object({
  username: z.string().min(3).max(50),
  email: z.string().email(),
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
  password: z.string().min(8).max(100),
  brand_id: z.string().uuid(),
  role: z.enum(["admin"]),
});

export const CreateDriverSchema = z.object({
  name: z.string().min(2).max(100),
  phone: z.string().regex(/^\+?[1-9]\d{7,14}$/),
  branch_id: z.string().uuid().optional(),
});

export const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1),
});

// ─── Types inférés ────────────────────────────────────────────────────────────

export type RegisterUserInput = z.infer<typeof RegisterUserSchema>;
export type LoginUserInput = z.infer<typeof LoginUserSchema>;
export type VerifyOtpInput = z.infer<typeof VerifyOtpSchema>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
export type LoginAdminInput = z.infer<typeof LoginAdminSchema>;
export type CreateAdminInput = z.infer<typeof CreateAdminSchema>;
export type CreateDriverInput = z.infer<typeof CreateDriverSchema>;
