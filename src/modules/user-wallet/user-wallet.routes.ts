import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as ctrl from "./user-wallet.controller.js";

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
router.get("/shared-cart/:token", ctrl.getSharedCartHandler);

// ── Authenticated user ────────────────────────────────────────────────────────
router.use(authenticate);

router.get("/",                          ctrl.getMyWallet);
router.get("/card-numbers",              ctrl.generateCardNumbers);
router.get("/transactions",              ctrl.getMyTransactions);
router.get("/payment-status/:reference", ctrl.getPaymentStatus);
router.post("/activate",     ctrl.activateWallet);
router.post("/topup",        ctrl.topUpWallet);
router.post("/verify-pin",   ctrl.verifyPinHandler);
router.post("/transfer",     ctrl.transferHandler);
router.post("/withdraw",     ctrl.withdrawHandler);
router.post("/shared-cart",  ctrl.createSharedCartHandler);

// ── Superadmin ────────────────────────────────────────────────────────────────
router.get("/admin/commission",             requireRole("superadmin"), ctrl.getCommissionWallet);
router.get("/admin/transactions",           requireRole("superadmin"), ctrl.getAllTransactions);
router.get("/admin/commission/transactions",requireRole("superadmin"), ctrl.getCommissionTransactions);

export default router;
