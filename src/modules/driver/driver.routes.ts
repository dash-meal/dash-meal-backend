import { Router } from "express";
import { z } from "zod";
import { authenticate, requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import * as controller from "./driver.controller.js";

const router: Router = Router();

router.use(authenticate);
router.use(requireRole("driver"));

// Deliveries
router.get("/deliveries", controller.getDeliveries);
router.patch(
  "/deliveries/:id/status",
  validate(z.object({ status: z.enum(["accepted", "picked_up", "delivered", "failed"]) })),
  controller.updateDeliveryStatus,
);

// Earnings
router.get("/earnings", controller.getEarnings);

// Profile
router.get("/profile", controller.getProfile);
router.patch(
  "/profile",
  validate(z.object({ name: z.string().min(2).optional(), vehicle_type: z.string().optional() })),
  controller.updateProfile,
);
router.patch(
  "/profile/availability",
  validate(z.object({ is_online: z.boolean() })),
  controller.updateAvailability,
);

// Location
router.patch(
  "/location",
  validate(z.object({ lat: z.number(), lng: z.number() })),
  controller.updateLocation,
);

export default router;
