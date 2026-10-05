import { Router } from "express";
import multer from "multer";
import { authenticate, requireRole, loadBrandFromParam, requireOwnBrand } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { BrandApplicationSchema, ReviewApplicationSchema, CreateBrandSchema } from "../../shared/index.js";
import * as controller from "./brands.controller.js";

const router: import("express").Router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─── Public ───────────────────────────────────────────────────────────────────
router.post("/apply", validate(BrandApplicationSchema), controller.applyForBrand);

// ─── Super Admin uniquement ───────────────────────────────────────────────────
router.get("/", authenticate, requireRole("superadmin"), controller.listBrands);
router.post("/", authenticate, requireRole("superadmin"), validate(CreateBrandSchema), controller.createBrand);
router.get("/catalogue", authenticate, requireRole("superadmin"), controller.getCatalogue);
router.get("/applications", authenticate, requireRole("superadmin"), controller.listApplications);
router.get("/applications/:id", authenticate, requireRole("superadmin"), controller.getApplication);
router.post("/applications/:id/review", authenticate, requireRole("superadmin"), validate(ReviewApplicationSchema), controller.reviewApplication);
router.patch("/:id/suspend", authenticate, requireRole("superadmin"), controller.suspendBrand);
router.post("/:id/review-legal", authenticate, requireRole("superadmin"), controller.reviewLegalDocs);

// ─── Admin (sa propre marque) ─────────────────────────────────────────────────
router.get("/:id", authenticate, requireRole("admin", "superadmin"), loadBrandFromParam("id"), requireOwnBrand, controller.getBrand);
router.patch("/:id", authenticate, requireRole("admin", "superadmin"), loadBrandFromParam("id"), requireOwnBrand, controller.updateBrand);
router.post("/:id/logo", authenticate, requireRole("admin", "superadmin"), loadBrandFromParam("id"), requireOwnBrand, upload.single("logo"), controller.uploadBrandLogo);
router.post("/:id/legal-doc", authenticate, requireRole("admin", "superadmin"), loadBrandFromParam("id"), requireOwnBrand, upload.single("document"), controller.uploadLegalDoc);
router.post("/:id/submit-legal", authenticate, requireRole("admin"), loadBrandFromParam("id"), requireOwnBrand, controller.submitLegalDocs);

export default router;
