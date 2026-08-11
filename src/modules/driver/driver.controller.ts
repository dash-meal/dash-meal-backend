import type { Request, Response, NextFunction } from "express";
import * as service from "./driver.service.js";

export async function getDeliveries(req: Request, res: Response, next: NextFunction) {
  try {
    const driverId = req.user!.id;
    const status = Array.isArray(req.query.status) ? undefined : req.query.status as string | undefined;
    const result = await service.getDeliveries(driverId, status);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function updateDeliveryStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const driverId = req.user!.id;
    const result = await service.updateDeliveryStatus(driverId, req.params.id as string, req.body.status as string);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getEarnings(req: Request, res: Response, next: NextFunction) {
  try {
    const driverId = req.user!.id;
    const period = (req.query.period as string) || "today";
    const result = await service.getEarnings(driverId, period);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.getProfile(req.user!.id);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function updateProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.updateProfile(req.user!.id, req.body);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function updateAvailability(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.updateAvailability(req.user!.id, req.body.is_online);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function updateLocation(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.updateLocation(req.user!.id, req.body.lat, req.body.lng);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}
