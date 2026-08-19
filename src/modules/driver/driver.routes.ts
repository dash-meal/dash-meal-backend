import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as controller from "./driver.controller.js";

const router: Router = Router();

router.use(authenticate);
router.use(requireRole("driver"));

// Earnings
router.get("/earnings", controller.getEarnings);

export default router;
