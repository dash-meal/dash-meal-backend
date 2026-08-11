import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import * as controller from "./reports.controller.js";

const router: Router = Router();

router.use(authenticate, requireRole("admin", "superadmin"));

router.get("/orders.csv", controller.exportOrdersCsv);
router.get("/products.csv", controller.exportProductsSalesCsv);
router.get("/summary", controller.getSummary);

export default router;
