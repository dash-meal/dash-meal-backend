import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated, sendPaginated } from "../../utils/response.js";
import { resolvePromotion, recordPromotionUsage } from "./promotions.service.js";

export async function listPromotions(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const brandId = user.role === "superadmin" ? (req.query.brand_id as string | undefined) : user.brand_id;
    const branchId = req.query.branch_id as string | undefined;

    if (!brandId) throw new AppError(400, "MISSING_BRAND_ID", "brand_id requis");

    let query = supabase
      .from("promotions")
      .select("*, usage_count:promotion_usages(count)", { count: "exact" })
      .eq("brand_id", brandId)
      .order("created_at", { ascending: false });

    if (branchId) query = query.eq("branch_id", branchId);

    const { data, error } = await query;
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

export async function getPromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const brandId = user.role === "superadmin" ? undefined : user.brand_id;

    let query = supabase
      .from("promotions")
      .select("*, usage_count:promotion_usages(count)")
      .eq("id", req.params.id);

    if (brandId) query = query.eq("brand_id", brandId);

    const { data, error } = await query.single();

    if (error?.code === "PGRST116" || !data) throw new AppError(404, "NOT_FOUND", "Promotion introuvable");
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function createPromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const brandId = user.role === "superadmin" ? req.body.brand_id : user.brand_id;

    if (!brandId) throw new AppError(400, "MISSING_BRAND_ID", "brand_id requis");

    const {
      code, type, value, min_order, max_uses, max_uses_per_user,
      starts_at, expires_at, description, branch_id,
    } = req.body;

    // Vérifier unicité du code au sein de la marque
    const { data: existing } = await supabase
      .from("promotions")
      .select("id")
      .eq("brand_id", brandId)
      .eq("code", (code as string).toUpperCase())
      .maybeSingle();

    if (existing) throw new AppError(409, "CONFLICT", "Ce code promotionnel existe déjà");

    const { data, error } = await supabase
      .from("promotions")
      .insert({
        brand_id: brandId,
        code: (code as string).toUpperCase(),
        type,
        value: Number(value),
        min_order: min_order ? Number(min_order) : null,
        max_uses: max_uses ? Number(max_uses) : null,
        max_uses_per_user: max_uses_per_user ? Number(max_uses_per_user) : null,
        starts_at: starts_at ?? null,
        expires_at: expires_at ?? null,
        description: description ?? null,
        branch_id: branch_id ?? null,
        uses_count: 0,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendCreated(res, data, "Promotion créée");
  } catch (err) {
    next(err);
  }
}

export async function updatePromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const brandId = user.role === "superadmin" ? undefined : user.brand_id;

    const allowed = [
      "type", "value", "min_order", "max_uses", "max_uses_per_user",
      "starts_at", "expires_at", "description", "is_active", "branch_id",
    ];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    let query = supabase
      .from("promotions")
      .update(updates)
      .eq("id", req.params.id);

    if (brandId) query = query.eq("brand_id", brandId);

    const { data, error } = await query.select().single();

    if (!data) throw new AppError(404, "NOT_FOUND", "Promotion introuvable");
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, data, "Promotion mise à jour");
  } catch (err) {
    next(err);
  }
}

export async function deletePromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const brandId = user.role === "superadmin" ? undefined : user.brand_id;

    let query = supabase
      .from("promotions")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);

    if (brandId) query = query.eq("brand_id", brandId);

    const { data: deleted, error: deleteErr } = await query.select("id").single();

    if (deleteErr) throw new AppError(500, "DB_ERROR", deleteErr.message);
    if (!deleted) throw new AppError(404, "NOT_FOUND", "Promotion introuvable");

    sendSuccess(res, null, "Promotion désactivée");
  } catch (err) {
    next(err);
  }
}

export async function validatePromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, order_total, branch_id } = req.body as {
      code: string;
      order_total: number;
      branch_id?: string;
    };

    const result = await resolvePromotion({
      code,
      orderTotal: Number(order_total),
      userId: req.user!.id,
      branchId: branch_id,
    });

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function applyPromotion(req: Request, res: Response, next: NextFunction) {
  try {
    const { promotion_id, order_id } = req.body as { promotion_id: string; order_id: string };

    await recordPromotionUsage(promotion_id, order_id, req.user!.id);

    sendSuccess(res, null, "Promotion appliquée");
  } catch (err) {
    next(err);
  }
}
