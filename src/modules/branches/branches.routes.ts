import { Router } from "express";
import { authenticate, requireRole, loadBranchOwnership, requireOwnBrand } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { CreateBranchSchema, UpdateBranchSchema, CreateDeliveryZoneSchema } from "../../shared/index.js";
import { imageUpload } from "../../middleware/upload.js";
import * as controller from "./branches.controller.js";

const router: import("express").Router = Router();

// ─── Public ───────────────────────────────────────────────────────────────────
router.get("/nearby", controller.getNearbyBranches);
router.get("/:id", controller.getBranch);
router.get("/:id/time-slots", controller.getTimeSlots);
router.get("/:id/delivery-zones", controller.getDeliveryZones);

// ─── Admin : liste des agences de la marque ───────────────────────────────────
router.get("/", authenticate, requireRole("admin", "superadmin"), controller.listBranches);

// ─── Admin : CRUD agences ─────────────────────────────────────────────────────
router.post("/", authenticate, requireRole("admin", "superadmin"), validate(CreateBranchSchema), controller.createBranch);
router.patch("/:id", authenticate, requireRole("admin", "superadmin"), loadBranchOwnership, requireOwnBrand, validate(UpdateBranchSchema), controller.updateBranch);
router.delete("/:id", authenticate, requireRole("admin", "superadmin"), loadBranchOwnership, requireOwnBrand, controller.deleteBranch);

// ─── Image agence ─────────────────────────────────────────────────────────────
router.post("/:id/image", authenticate, requireRole("admin", "superadmin"), imageUpload.single("image"), controller.uploadBranchImage);

// ─── Workflow live ────────────────────────────────────────────────────────────
router.post("/:id/request-live", authenticate, requireRole("admin", "branch_manager"), controller.requestLive);
router.post("/:id/review-live", authenticate, requireRole("admin", "superadmin"), controller.reviewLiveRequest);

// ─── Click & Collect ──────────────────────────────────────────────────────────
router.post("/time-slots", authenticate, requireRole("admin", "superadmin"), controller.createTimeSlot);

// ─── Zones de livraison ───────────────────────────────────────────────────────
router.post("/delivery-zones", authenticate, requireRole("admin", "superadmin"), validate(CreateDeliveryZoneSchema), controller.createDeliveryZone);

export default router;
