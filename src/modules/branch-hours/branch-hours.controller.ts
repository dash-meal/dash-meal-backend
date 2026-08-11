import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";

const DAY_NAMES = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

// GET /branch-hours/:branch_id
export async function getBranchHours(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branch_hours")
      .select("*")
      .eq("branch_id", req.params.branch_id)
      .order("day_of_week");

    if (error) throw new AppError(500, "DB_ERROR", error.message);
    sendSuccess(res, (data ?? []).map((h) => ({ ...h, day_name: DAY_NAMES[h.day_of_week] })));
  } catch (err) {
    next(err);
  }
}

// PUT /branch-hours/:branch_id — remplace tous les horaires d'un coup
export async function setBranchHours(req: Request, res: Response, next: NextFunction) {
  try {
    const branch_id = req.params.branch_id;
    const hours = req.body.hours as Array<{
      day_of_week: number; open_time: string; close_time: string; is_closed: boolean;
    }>;

    // Vérification accès
    if (req.user!.role === "branch_manager" && req.user!.branch_id !== branch_id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé à cette agence");
    }
    if (req.user!.role === "admin") {
      const { data: branch } = await supabase.from("branches").select("brand_id").eq("id", branch_id).single();
      if (!branch || branch.brand_id !== req.user!.brand_id) throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    const rows = hours.map((h) => ({
      branch_id,
      day_of_week: h.day_of_week,
      open_time:   h.open_time,
      close_time:  h.close_time,
      is_closed:   h.is_closed,
    }));

    const { error } = await supabase
      .from("branch_hours")
      .upsert(rows, { onConflict: "branch_id,day_of_week" });

    if (error) throw new AppError(500, "DB_ERROR", error.message);
    sendSuccess(res, null, "Horaires mis à jour");
  } catch (err) {
    next(err);
  }
}

// PATCH /branch-hours/:branch_id/:day — modifier un seul jour
export async function updateDayHours(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id, day } = req.params;
    const { open_time, close_time, is_closed } = req.body;

    const { data, error } = await supabase
      .from("branch_hours")
      .upsert({ branch_id, day_of_week: Number(day), open_time, close_time, is_closed }, { onConflict: "branch_id,day_of_week" })
      .select()
      .single();

    if (error) throw new AppError(500, "DB_ERROR", error.message);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// GET /branch-hours/:branch_id/is-open — l'agence est-elle ouverte maintenant ?
export async function isBranchOpen(req: Request, res: Response, next: NextFunction) {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=dim
    const currentTime = now.toTimeString().slice(0, 5); // "HH:mm"

    const { data } = await supabase
      .from("branch_hours")
      .select("open_time, close_time, is_closed")
      .eq("branch_id", req.params.branch_id)
      .eq("day_of_week", dayOfWeek)
      .single();

    if (!data || data.is_closed) {
      return sendSuccess(res, { is_open: false, reason: "closed_today" });
    }

    const open  = data.open_time.slice(0, 5);
    const close = data.close_time.slice(0, 5);
    const is_open = currentTime >= open && currentTime < close;

    sendSuccess(res, { is_open, open_time: open, close_time: close, current_time: currentTime });
  } catch (err) {
    next(err);
  }
}
