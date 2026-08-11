import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./driver-wallet.controller.js";

const router = Router();

// ─── Livreur : son propre wallet ──────────────────────────────────────────────
router.get( "/me",              authenticate, requireRole("driver"), controller.getMyWallet);
router.get( "/me/transactions", authenticate, requireRole("driver"), controller.getMyTransactions);
router.post("/me/withdraw",     authenticate, requireRole("driver"),
  validate(z.object({ amount: z.number().min(500), phone: z.string().min(8) })),
  controller.requestDriverWithdrawal
);

// ─── Admin : wallet d'un livreur ─────────────────────────────────────────────
router.get("/:driver_id", authenticate, requireRole("admin", "superadmin"), controller.getDriverWalletById);

export default router;
