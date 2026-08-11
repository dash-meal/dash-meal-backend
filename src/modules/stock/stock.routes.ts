import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./stock.controller.js";

const router = Router();
router.use(authenticate, requireRole("admin", "superadmin", "branch_manager"));

const UpdateSchema = z.object({
  quantity: z.number().int().min(0),
  type:     z.enum(["restock", "adjustment", "removal", "loss"]),
  note:     z.string().max(300).optional(),
});

const BulkSchema = z.object({
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity:   z.number().int().min(0),
    type:       z.enum(["restock", "adjustment"]),
    note:       z.string().max(300).optional(),
  })).min(1).max(200),
});

router.get( "/:branch_id",                     controller.getBranchStock);
router.get( "/:branch_id/movements",           controller.getStockMovements);
router.get( "/:branch_id/alerts",              controller.getStockAlerts);
router.post("/:branch_id/bulk",                validate(BulkSchema),   controller.bulkUpdateStock);
router.patch("/:branch_id/:product_id",        validate(UpdateSchema),  controller.updateStockItem);

export default router;
