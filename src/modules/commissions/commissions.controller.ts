import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";

// ─── Résumé des commissions ────────────────────────────────────────────────────
export async function getCommissionsSummary(req: Request, res: Response, next: NextFunction) {
  try {
    let query = supabase
      .from("commissions")
      .select("type, amount, is_settled, brand_id");

    // Admin : seulement sa marque
    if (req.user?.role === "admin" && req.user.brand_id) {
      query = query.eq("brand_id", req.user.brand_id);
    }

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    const rows = data as { type: string; amount: number; is_settled: boolean; brand_id: string }[];

    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    const totalOnline = rows.filter((r) => r.type === "online").reduce((sum, r) => sum + r.amount, 0);
    const totalInperson = rows.filter((r) => r.type === "inperson").reduce((sum, r) => sum + r.amount, 0);
    const settled = rows.filter((r) => r.is_settled).reduce((sum, r) => sum + r.amount, 0);
    const pending = rows.filter((r) => !r.is_settled).reduce((sum, r) => sum + r.amount, 0);

    sendSuccess(res, {
      total,
      online: totalOnline,
      inperson: totalInperson,
      settled,
      pending,
      count: rows.length,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Liste des commissions ────────────────────────────────────────────────────
export async function listCommissions(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      brand_id,
      type,
      is_settled,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string>;

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from("commissions")
      .select(
        `
        *,
        brands(name),
        orders(id, type, total, created_at),
        payments(method, provider_ref)
      `,
        { count: "exact" }
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limitNum - 1);

    // Admin : restriction à sa marque
    if (req.user?.role === "admin" && req.user.brand_id) {
      query = query.eq("brand_id", req.user.brand_id);
    } else if (brand_id) {
      query = query.eq("brand_id", brand_id);
    }

    if (type) query = query.eq("type", type);
    if (is_settled !== undefined) query = query.eq("is_settled", is_settled === "true");

    const { data, count, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    res.json({
      success: true,
      data: data ?? [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count ?? 0,
        total_pages: Math.ceil((count ?? 0) / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Détail d'une commission ──────────────────────────────────────────────────
export async function getCommission(req: Request, res: Response, next: NextFunction) {
  try {
    let query = supabase
      .from("commissions")
      .select(
        `
        *,
        brands(name, logo_url),
        orders(id, type, total, status, created_at, users(name, phone)),
        payments(method, amount, status, provider_ref, provider)
      `
      )
      .eq("id", req.params.id)
      .single();

    const { data, error } = await query;
    if (error || !data) throw new AppError(404, "NOT_FOUND", "Commission introuvable");

    // Admin : vérifier que c'est bien sa marque
    if (req.user?.role === "admin" && (data as { brand_id: string }).brand_id !== req.user.brand_id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Superadmin : marquer une commission comme réglée ────────────────────────
export async function settleCommission(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("commissions")
      .select("id, is_settled")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Commission introuvable");
    if ((data as { is_settled: boolean }).is_settled) {
      throw new AppError(400, "ALREADY_SETTLED", "Commission déjà réglée");
    }

    await supabase
      .from("commissions")
      .update({ is_settled: true, settled_at: new Date().toISOString() })
      .eq("id", req.params.id);

    sendSuccess(res, { id: req.params.id }, "Commission marquée comme réglée");
  } catch (err) {
    next(err);
  }
}

// ─── Superadmin : régler plusieurs commissions en lot ────────────────────────
export async function settleBatch(req: Request, res: Response, next: NextFunction) {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!ids || ids.length === 0) {
      throw new AppError(400, "MISSING_IDS", "Liste d'IDs requise");
    }

    const now = new Date().toISOString();
    const { count, error } = await supabase
      .from("commissions")
      .update({ is_settled: true, settled_at: now })
      .in("id", ids)
      .eq("is_settled", false);

    if (error) throw new AppError(500, "UPDATE_ERROR", "Erreur lors du règlement");

    sendSuccess(res, { settled: count ?? ids.length }, `${count ?? ids.length} commission(s) réglée(s)`);
  } catch (err) {
    next(err);
  }
}
