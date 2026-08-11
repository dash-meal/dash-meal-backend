import { Router } from "express";
import * as controller from "./maps.controller.js";

const router: import("express").Router = Router();

// Ces endpoints sont publics — la clé Google Maps est côté serveur uniquement.
// Le rate limiter global (200 req / 4 min) protège contre les abus.

router.get("/autocomplete", controller.autocomplete);
router.get("/place",        controller.placeDetails);
router.get("/reverse",      controller.reverseGeocode);
router.get("/staticmap",    controller.staticMap);

export default router;
