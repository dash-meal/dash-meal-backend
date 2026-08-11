import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";

// ─── Validation d'un code promo (mobile, public) ──────────────────────────────
// GET /promo-codes/validate?code=XX&branch_id=YY&order_total=ZZ
export async function validatePromoCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { code, branch_id, order_total } = req.query as Record<string, string>;

    if (!code || !branch_id) {
      throw new AppError(400, "MISSING_PARAMS", "Paramètres 'code' et 'branch_id' requis");
    }

    const orderTotal = order_total ? Number(order_total) : 0;

    const { data, error } = await supabase
      .from("promo_codes")
      .select("id, code, label, discount_pct, min_order_amt, max_uses, used_count, valid_from, valid_until, is_active")
      .eq("branch_id", branch_id)
      .ilike("code", code.trim())
      .single();

    if (error || !data) {
      throw new AppError(404, "PROMO_NOT_FOUND", "Code promo invalide");
    }

    if (!data.is_active) {
      throw new AppError(400, "PROMO_INACTIVE", "Ce code promo n'est plus actif");
    }

    const now = new Date();
    if (data.valid_from && new Date(data.valid_from) > now) {
      throw new AppError(400, "PROMO_NOT_STARTED", "Ce code promo n'est pas encore valide");
    }
    if (data.valid_until && new Date(data.valid_until) < now) {
      throw new AppError(400, "PROMO_EXPIRED", "Ce code promo a expiré");
    }
    if (data.max_uses !== null && data.used_count >= data.max_uses) {
      throw new AppError(400, "PROMO_MAX_USES", "Ce code promo a atteint sa limite d'utilisation");
    }
    if (orderTotal < (data.min_order_amt ?? 0)) {
      throw new AppError(400, "PROMO_MIN_ORDER", `Commande minimale de ${data.min_order_amt} FCFA requise`);
    }

    const discount_amount = Math.round(orderTotal * data.discount_pct / 100);

    sendSuccess(res, {
      id:              data.id,
      code:            data.code,
      label:           data.label,
      discount_pct:    data.discount_pct,
      discount_amount,
      total_after:     Math.max(0, orderTotal - discount_amount),
    });
  } catch (err) {
    next(err);
  }
}

// ─── Admin : lister les codes promo de son agence ─────────────────────────────
export async function listPromoCodes(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id } = req.query as Record<string, string>;
    const userBrandId = req.user!.brand_id;
    const isSuperadmin = req.user!.role === "superadmin";

    let query = supabase
      .from("promo_codes")
      .select("*, branches(id, name, brand_id)")
      .order("created_at", { ascending: false });

    if (branch_id) {
      query = query.eq("branch_id", branch_id);
    }

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", error.message);

    // Filtrage brand pour les admins non-superadmin
    const filtered = isSuperadmin
      ? (data ?? [])
      : (data ?? []).filter((r: any) => r.branches?.brand_id === userBrandId);

    sendSuccess(res, filtered);
  } catch (err) {
    next(err);
  }
}

// ─── Admin : créer un code promo ──────────────────────────────────────────────
export async function createPromoCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id, code, label, discount_pct, min_order_amt, max_uses, valid_from, valid_until } = req.body;

    if (!branch_id || !code || !discount_pct) {
      throw new AppError(400, "MISSING_FIELDS", "Champs requis : branch_id, code, discount_pct");
    }

    // Vérification accès agence pour admin non-superadmin
    if (req.user!.role === "admin") {
      const { data: branch } = await supabase
        .from("branches")
        .select("brand_id")
        .eq("id", branch_id)
        .single();
      if (!branch || branch.brand_id !== req.user!.brand_id) {
        throw new AppError(403, "FORBIDDEN", "Cette agence n'appartient pas à votre marque");
      }
    }

    const { data, error } = await supabase
      .from("promo_codes")
      .insert({
        branch_id,
        code:          code.trim().toUpperCase(),
        label:         label ?? null,
        discount_pct:  Number(discount_pct),
        min_order_amt: min_order_amt ? Number(min_order_amt) : 0,
        max_uses:      max_uses ? Number(max_uses) : null,
        valid_from:    valid_from ?? null,
        valid_until:   valid_until ?? null,
        is_active:     true,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw new AppError(409, "PROMO_EXISTS", "Ce code promo existe déjà pour cette agence");
      throw new AppError(500, "CREATE_ERROR", error.message);
    }

    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Admin : modifier un code promo ──────────────────────────────────────────
export async function updatePromoCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("promo_codes")
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Code promo introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Admin : supprimer un code promo ──────────────────────────────────────────
export async function deletePromoCode(req: Request, res: Response, next: NextFunction) {
  try {
    await supabase.from("promo_codes").delete().eq("id", req.params.id);
    sendSuccess(res, null, "Code promo supprimé");
  } catch (err) {
    next(err);
  }
}
