import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";

// ─── Superadmin : liste des logs d'activité ───────────────────────────────────
export async function listActivityLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      actor_id,
      actor_role,
      action,
      resource_type,
      from,
      to,
      page = "1",
      limit = "50",
    } = req.query as Record<string, string>;

    const pageNum = Number(page);
    const limitNum = Math.min(Number(limit), 200); // cap à 200 par page
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from("activity_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (actor_id)     query = query.eq("actor_id", actor_id);
    if (actor_role)   query = query.eq("actor_role", actor_role);
    if (action)       query = query.ilike("action", `%${action}%`);
    if (resource_type) query = query.eq("resource_type", resource_type);
    if (from)         query = query.gte("created_at", from);
    if (to)           query = query.lte("created_at", to);

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

// ─── Superadmin : détail d'un log ─────────────────────────────────────────────
export async function getActivityLog(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("activity_logs")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Log introuvable");

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}
