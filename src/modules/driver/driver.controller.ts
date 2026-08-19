import type { Request, Response, NextFunction } from "express";
import * as service from "./driver.service.js";

export async function getEarnings(req: Request, res: Response, next: NextFunction) {
  try {
    const driverId = req.user!.id;
    const period = (req.query.period as string) || "today";
    const result = await service.getEarnings(driverId, period);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}
