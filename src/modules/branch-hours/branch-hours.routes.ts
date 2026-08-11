import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./branch-hours.controller.js";

const router = Router();

const HoursSchema = z.object({
  hours: z.array(z.object({
    day_of_week: z.number().int().min(0).max(6),
    open_time:   z.string().regex(/^\d{2}:\d{2}$/),
    close_time:  z.string().regex(/^\d{2}:\d{2}$/),
    is_closed:   z.boolean(),
  })).length(7),
});

const DaySchema = z.object({
  open_time:  z.string().regex(/^\d{2}:\d{2}$/),
  close_time: z.string().regex(/^\d{2}:\d{2}$/),
  is_closed:  z.boolean(),
});

// Public : vérifier si une agence est ouverte (mobile app)
router.get("/:branch_id/is-open", controller.isBranchOpen);
router.get("/:branch_id",         controller.getBranchHours);

// Protégé : admin ou branch_manager de cette agence
router.put(  "/:branch_id",      authenticate, requireRole("admin", "superadmin", "branch_manager"), validate(HoursSchema), controller.setBranchHours);
router.patch("/:branch_id/:day", authenticate, requireRole("admin", "superadmin", "branch_manager"), validate(DaySchema),   controller.updateDayHours);

export default router;
