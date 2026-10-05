import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as ctrl from "./user-wallet.controller.js";

const router = Router();

// ─── Schémas ───────────────────────────────────────────────────────────────────

export const PaymentMethodSchema = z.enum(["orange_money", "mtn_mobile_money"]);
export const CardNumberSchema = z.string().regex(/^\d{8}$/, "Le numéro de carte doit comporter 8 chiffres");
export const PinSchema = z.string().min(4).max(8);
export const PhoneSchema = z.string().min(8);

export const ActivateSchema = z.object({
  card_number: CardNumberSchema,
  pin: PinSchema,
  payment_phone: PhoneSchema,
  payment_method: PaymentMethodSchema,
  initial_amount: z.number().min(10, "Le dépôt initial minimum est de 10 FCFA"),
});

export const TopUpSchema = z.object({
  amount: z.number().min(10, "Le montant minimum de recharge est de 10 FCFA"),
  phone: PhoneSchema,
  payment_method: PaymentMethodSchema.optional(),
});

export const VerifyPinSchema = z.object({
  pin: PinSchema,
});

export const TransferSchema = z.object({
  // Numéro de carte (8 chiffres) ou email du destinataire
  identifier: z.string().min(3, "Identifiant du destinataire requis"),
  amount: z.number().min(100, "Montant minimum de transfert : 100 FCFA"),
});

export const WithdrawSchema = z
  .object({
    amount: z.number().min(500, "Le retrait minimum est de 500 FCFA"),
    phone: PhoneSchema,
    phone_confirm: PhoneSchema,
  })
  .refine((data) => data.phone === data.phone_confirm, {
    message: "Les numéros de téléphone ne correspondent pas",
    path: ["phone_confirm"],
  });

// ── Public ────────────────────────────────────────────────────────────────────
router.get("/shared-cart/:token", ctrl.getSharedCartHandler);

// ── Authenticated user ────────────────────────────────────────────────────────
router.use(authenticate);

router.get("/",                          ctrl.getMyWallet);
router.get("/card-numbers",              ctrl.generateCardNumbers);
router.get("/transactions",              ctrl.getMyTransactions);
router.get("/payment-status/:reference", ctrl.getPaymentStatus);
router.post("/activate",     validate(ActivateSchema),  ctrl.activateWallet);
router.post("/topup",        validate(TopUpSchema),     ctrl.topUpWallet);
router.post("/verify-pin",   validate(VerifyPinSchema), ctrl.verifyPinHandler);
router.post("/transfer",     validate(TransferSchema),  ctrl.transferHandler);
router.post("/withdraw",     validate(WithdrawSchema),  ctrl.withdrawHandler);
router.post("/shared-cart",  ctrl.createSharedCartHandler);

// ── Superadmin ────────────────────────────────────────────────────────────────
router.get("/admin/commission",             requireRole("superadmin"), ctrl.getCommissionWallet);
router.get("/admin/transactions",           requireRole("superadmin"), ctrl.getAllTransactions);
router.get("/admin/commission/transactions",requireRole("superadmin"), ctrl.getCommissionTransactions);

export default router;
