import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import * as service from "./ads.service.js";

// ─── Admin : initier paiement Campay pour une pub ────────────────────────────
export async function initiateAdPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const brandId = req.user!.brand_id!;
    const { title, image_url, target_count, payment_phone, payment_method } = req.body;
    const data = await service.initiateAdPayment(brandId, {
      title, image_url, target_count: Number(target_count),
      payment_phone, payment_method,
    });
    res.status(201).json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── Admin : polling statut paiement ─────────────────────────────────────────
export async function getAdPaymentStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await service.pollAdPaymentStatus(String(req.params.reference));
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── Admin : lister ses pubs ──────────────────────────────────────────────────
export async function getMyAds(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await service.getAdsByBrand(req.user!.brand_id!);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── Admin : supprimer une pub ───────────────────────────────────────────────
export async function deleteMyAd(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await service.deleteAd(String(req.params.id), String(req.user!.brand_id!));
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ─── Admin : calculer le prix ────────────────────────────────────────────────
export async function getAdPrice(req: Request, res: Response, next: NextFunction) {
  try {
    const target = parseInt(String(req.query.target ?? ""));
    if (isNaN(target) || target < 6) {
      return res.status(400).json({ success: false, error: { code: "INVALID_TARGET", message: "target doit être >= 6" } });
    }
    res.json({ success: true, data: { target_count: target, amount: service.calculateAdPrice(target) } });
  } catch (err) { next(err); }
}

// ─── Superadmin : lister toutes les pubs ─────────────────────────────────────
export async function getAllAds(req: Request, res: Response, next: NextFunction) {
  try {
    const status = (req.query.status as string | undefined);
    const data = await service.getAllAds(status);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── Superadmin : approuver ───────────────────────────────────────────────────
export async function approveAd(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await service.approveAd(String(req.params.id), req.user!.id);
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── Superadmin : rejeter ─────────────────────────────────────────────────────
export async function rejectAd(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason } = req.body as { reason?: string };
    const data = await service.rejectAd(String(req.params.id), req.user!.id, reason ?? "Non conforme");
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── Superadmin : retrait wallet plateforme ───────────────────────────────────
export async function superadminWithdraw(req: Request, res: Response, next: NextFunction) {
  try {
    const { amount, phone } = req.body;
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: { code: "INVALID_AMOUNT", message: "Montant invalide" } });
    }
    if (!phone) {
      return res.status(400).json({ success: false, error: { code: "PHONE_REQUIRED", message: "Numéro de téléphone requis" } });
    }
    const data = await service.platformWithdraw(Number(amount), String(phone));
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

// ─── Mobile : toutes les pubs actives (public, pas d'auth) ───────────────────
export async function getPublicActiveAds(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("ads")
      .select("id, title, image_url, video_url, cta_url, brand_id, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(10);

    if (error) throw new AppError(500, "FETCH_ERROR", error.message);
    res.json({ success: true, data: data ?? [] });
  } catch (err) { next(err); }
}

// ─── Mobile : récupérer une pub active ───────────────────────────────────────
export async function getAdForUser(req: Request, res: Response, next: NextFunction) {
  try {
    const ad = await service.getAdForUser(req.user!.id);
    res.json({ success: true, data: ad });
  } catch (err) { next(err); }
}

// ─── Mobile : enregistrer une impression ─────────────────────────────────────
export async function recordImpression(req: Request, res: Response, next: NextFunction) {
  try {
    await service.recordImpression(String(req.params.id), req.user!.id);
    res.json({ success: true, data: { ok: true } });
  } catch (err) { next(err); }
}
