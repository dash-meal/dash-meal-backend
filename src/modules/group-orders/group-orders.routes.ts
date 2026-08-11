import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as controller from "./group-orders.controller.js";

const router: Router = Router();

router.use(authenticate);

// ─── Création et jonction ─────────────────────────────────────────────────────
router.post("/", controller.createGroupCart);
router.post("/join", controller.joinGroupCart);

// ─── Consultation ─────────────────────────────────────────────────────────────
router.get("/:id", controller.getGroupCart);

// ─── Gestion des articles ─────────────────────────────────────────────────────
router.post("/:id/items", controller.addItem);
router.delete("/:id/items/:product_id", controller.removeItem);

// ─── Actions hôte ─────────────────────────────────────────────────────────────
router.post("/:id/lock", controller.lockCart);
router.post("/:id/order", controller.placeGroupOrder);

export default router;
