import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as controller from "./invoices.controller.js";

const router: import("express").Router = Router();

router.post("/generate/:orderId", authenticate, controller.generateInvoice);
router.get("/:orderId", authenticate, controller.getInvoice);

export default router;
