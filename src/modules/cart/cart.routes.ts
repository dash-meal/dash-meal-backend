import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { AddToCartSchema, UpdateCartItemSchema } from "../../shared/index.js";
import * as controller from "./cart.controller.js";

const router: import("express").Router = Router();

// ─── Lire le panier ───────────────────────────────────────────────────────────
router.get("/", authenticate, requireRole("user"), controller.getCart);

// ─── Ajouter un produit ───────────────────────────────────────────────────────
router.post("/items", authenticate, requireRole("user"), validate(AddToCartSchema), controller.addToCart);

// ─── Modifier la quantité d'un article (body: { quantity: 0 } = suppression) ─
router.patch("/items/:itemId", authenticate, requireRole("user"), validate(UpdateCartItemSchema), controller.updateCartItem);

// ─── Supprimer un article ─────────────────────────────────────────────────────
router.delete("/items/:itemId", authenticate, requireRole("user"), controller.removeCartItem);

// ─── Vider le panier (optionnel: ?branch_id=xxx pour cibler une agence) ───────
router.delete("/", authenticate, requireRole("user"), controller.clearCart);

export default router;
