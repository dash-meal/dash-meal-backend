import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import {
  getWallet, getWalletTransactions, requestWithdrawal, verifyWithdrawPhone,
  getPlatformWallet, getPlatformTransactions, platformWithdraw,
} from "./wallet.controller.js";

const router = Router();
router.use(authenticate);

// ─── Admin : wallet de sa marque ──────────────────────────────────────────────
router.get("/",                requireRole("admin"), getWallet);
router.get("/transactions",    requireRole("admin"), getWalletTransactions);
router.post("/verify-phone",   requireRole("admin"), verifyWithdrawPhone);
router.post("/withdraw",       requireRole("admin"), requestWithdrawal);

// ─── Superadmin : wallet plateforme ──────────────────────────────────────────
router.get("/platform",              requireRole("superadmin"), getPlatformWallet);
router.get("/platform/transactions", requireRole("superadmin"), getPlatformTransactions);
router.post("/platform/withdraw",    requireRole("superadmin"), platformWithdraw);

export default router;
