import { Router } from "express";
import multer from "multer";
import { authenticate, requireRole, optionalAuthenticate } from "../../middleware/auth.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
import { validate } from "../../middleware/validate.js";
import {
  CreateProductSchema,
  UpdateProductSchema,
  CreateProductVariantSchema,
  UpdateStockSchema,
  CreateCategorySchema,
  ProductSearchSchema,
  SetPromoSchema,
} from "../../shared/index.js";
import * as controller from "./products.controller.js";

const router: import("express").Router = Router();

// ─── Public (mobile) ─────────────────────────────────────────────────────────
router.get("/public/best-sellers", controller.listBestSellers);
router.get("/public",              controller.listPublicProducts);
router.get("/public/:id",          controller.getProduct);
router.get("/search",              validate(ProductSearchSchema, "query"), controller.searchProducts);
router.get("/categories",          controller.listCategories);

// ─── Notation produit (utilisateurs authentifiés) ─────────────────────────────
router.post("/:id/rate",       authenticate, controller.rateProduct);
router.get("/:id/my-rating",   authenticate, controller.getUserProductRating);

router.get("/:id",             controller.getProduct);

// ─── Semi-public : accessible par mobile (filtre is_hidden auto) et admins ───
router.get("/branch/:branch_id", optionalAuthenticate, controller.listByBranch);

// ─── Admin ────────────────────────────────────────────────────────────────────
router.post("/", authenticate, requireRole("admin", "superadmin"), validate(CreateProductSchema), controller.createProduct);
router.patch("/:id", authenticate, requireRole("admin", "superadmin"), validate(UpdateProductSchema), controller.updateProduct);
router.patch("/:id/toggle-hidden", authenticate, requireRole("admin", "superadmin"), controller.toggleHidden);
router.patch("/:id/promo", authenticate, requireRole("admin", "superadmin"), validate(SetPromoSchema), controller.setPromo);
router.delete("/:id", authenticate, requireRole("admin", "superadmin"), controller.deleteProduct);

// Variantes
router.post("/:id/variants", authenticate, requireRole("admin", "superadmin"), validate(CreateProductVariantSchema), controller.createVariant);

// Stock par agence
router.put("/stock", authenticate, requireRole("admin", "superadmin"), validate(UpdateStockSchema), controller.updateStock);
router.get("/:id/stock", authenticate, requireRole("admin", "superadmin"), controller.getStockByBranch);

// Upload image produit
router.post("/upload-image", authenticate, requireRole("admin", "superadmin"), upload.single("image"), controller.uploadImage);

// Catégories
router.post("/categories", authenticate, requireRole("admin", "superadmin"), validate(CreateCategorySchema), controller.createCategory);
router.delete("/categories/:id", authenticate, requireRole("admin", "superadmin"), controller.deleteCategory);

export default router;
