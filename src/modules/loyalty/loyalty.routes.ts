import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as controller from "./loyalty.controller.js";

const router: Router = Router();

router.get("/me", authenticate, controller.getMyLoyalty);
router.get("/transactions", authenticate, controller.getLoyaltyTransactions);
router.post("/earn", authenticate, controller.earnPoints);
router.post("/redeem", authenticate, requireRole("user"), controller.redeemPoints);

export default router;
