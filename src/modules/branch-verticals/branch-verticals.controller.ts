import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import type { CreateBranchVerticalInput, UpdateBranchVerticalInput } from "../../shared/index.js";

// ─── GET /branch-verticals — liste tous les verticals (actifs + inactifs) ────
export async function listBranchVerticals(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branch_verticals")
      .select("*")
      .order("name_fr");

    if (error) throw new AppError(500, "DB_ERROR", error.message);
    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

// ─── GET /branch-verticals/:id ─────────────────────────────────────────────────
export async function getBranchVertical(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branch_verticals")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Vertical introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── POST /branch-verticals — superadmin uniquement ───────────────────────────
export async function createBranchVertical(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as CreateBranchVerticalInput;

    const { data: existing } = await supabase
      .from("branch_verticals")
      .select("id")
      .eq("key", input.key)
      .maybeSingle();
    if (existing) throw new AppError(409, "VERTICAL_ALREADY_EXISTS", "Un vertical avec cette clé existe déjà");

    const { data, error } = await supabase
      .from("branch_verticals")
      .insert(input)
      .select()
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création du vertical");
    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── PATCH /branch-verticals/:id — superadmin uniquement ──────────────────────
export async function updateBranchVertical(req: Request, res: Response, next: NextFunction) {
  try {
    const input = req.body as UpdateBranchVerticalInput;

    const { data, error } = await supabase
      .from("branch_verticals")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Vertical introuvable");
    sendSuccess(res, data, "Vertical mis à jour");
  } catch (err) {
    next(err);
  }
}

// ─── PATCH /branch-verticals/:id/deactivate — superadmin uniquement ───────────
// Désactivation plutôt que suppression : des agences peuvent déjà y être rattachées.
export async function deactivateBranchVertical(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branch_verticals")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Vertical introuvable");
    sendSuccess(res, data, "Vertical désactivé");
  } catch (err) {
    next(err);
  }
}
