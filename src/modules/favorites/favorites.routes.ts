import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as controller from "./favorites.controller.js";

const router: Router = Router();

router.use(authenticate);

router.get("/", controller.getMyFavorites);
router.get("/check/:product_id", controller.checkFavorite);
router.post("/:product_id", controller.addFavorite);
router.delete("/:product_id", controller.removeFavorite);

export default router;
