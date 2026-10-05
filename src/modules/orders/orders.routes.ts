import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import {
  CreateCollectOrderSchema,
  CreateDeliveryOrderSchema,
  CreateOrderSchema,
  UpdateOrderStatusSchema,
  AssignDriverSchema,
  ConvertToDeliverySchema,
} from "../../shared/index.js";
import * as controller from "./orders.controller.js";

const router: import("express").Router = Router();

// ─── Passer commande (unified — mobile) ──────────────────────────────────────
router.post("/", authenticate, requireRole("user"), validate(CreateOrderSchema), controller.createOrder);

// ─── Passer commande (legacy routes) ─────────────────────────────────────────
router.post("/collect", authenticate, requireRole("user"), validate(CreateCollectOrderSchema), controller.createCollectOrder);
router.post("/delivery", authenticate, requireRole("user"), validate(CreateDeliveryOrderSchema), controller.createDeliveryOrder);

// ─── Historique utilisateur ───────────────────────────────────────────────────
router.get("/my-orders", authenticate, requireRole("user"), controller.getUserOrders);
router.get("/:id", authenticate, controller.getOrder);

// ─── Gestion admin / branch_manager ──────────────────────────────────────────
router.get("/", authenticate, requireRole("admin", "superadmin", "driver", "branch_manager"), controller.listOrders);
router.patch("/:id/status", authenticate, requireRole("admin", "superadmin", "branch_manager"), validate(UpdateOrderStatusSchema), controller.updateOrderStatus);
router.post("/:id/assign-driver", authenticate, requireRole("admin", "superadmin"), validate(AssignDriverSchema), controller.assignDriver);
router.get( "/:id/history", authenticate, requireRole("admin", "superadmin", "branch_manager"), controller.getOrderHistory);
router.post("/:id/cancel", authenticate, controller.cancelOrder);
router.post("/:id/convert-to-delivery", authenticate, requireRole("user"), validate(ConvertToDeliverySchema), controller.convertToDelivery);
router.post("/:id/rate", authenticate, requireRole("user"), validate(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(500).optional() })), controller.rateOrder);

export default router;
