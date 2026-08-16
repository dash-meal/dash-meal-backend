import { Router } from "express";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { CreateBranchVerticalSchema, UpdateBranchVerticalSchema } from "../../shared/index.js";
import * as controller from "./branch-verticals.controller.js";

const router: import("express").Router = Router();

// Lecture ouverte à tout admin authentifié (pour peupler les sélecteurs de formulaire)
router.get("/", authenticate, controller.listBranchVerticals);
router.get("/:id", authenticate, controller.getBranchVertical);

// Écriture réservée au superadmin
router.post("/", authenticate, requireRole("superadmin"), validate(CreateBranchVerticalSchema), controller.createBranchVertical);
router.patch("/:id", authenticate, requireRole("superadmin"), validate(UpdateBranchVerticalSchema), controller.updateBranchVertical);
router.patch("/:id/deactivate", authenticate, requireRole("superadmin"), controller.deactivateBranchVertical);

export default router;
