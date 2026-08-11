import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./branch-managers.controller.js";

const router = Router();
router.use(authenticate, requireRole("admin", "superadmin"));

const CreateSchema = z.object({
  branch_id: z.string().uuid(),
  brand_id:  z.string().uuid().optional(),
  name:      z.string().min(2).max(100),
  phone:     z.string().min(8).max(20),
  email:     z.string().email().optional(),
  password:  z.string().min(6).max(100),
});

const UpdateSchema = z.object({
  name:      z.string().min(2).max(100).optional(),
  phone:     z.string().min(8).max(20).optional(),
  email:     z.string().email().optional(),
  is_active: z.boolean().optional(),
  password:  z.string().min(6).max(100).optional(),
});

router.get(  "/",                   controller.listBranchManagers);
router.post( "/",                   validate(CreateSchema), controller.createBranchManager);
router.get(  "/:id",                controller.getBranchManager);
router.patch("/:id",                validate(UpdateSchema), controller.updateBranchManager);
router.delete("/:id",               controller.deleteBranchManager);
router.post( "/:id/reset-password", validate(z.object({ new_password: z.string().min(6) })), controller.resetBranchManagerPassword);

export default router;
