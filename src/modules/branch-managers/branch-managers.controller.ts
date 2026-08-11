import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated, sendPaginated } from "../../utils/response.js";

// GET /branch-managers — liste tous les managers de la marque
export async function listBranchManagers(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id   = req.user!.role === "superadmin" ? (req.query.brand_id as string) : req.user!.brand_id!;
    const branch_id  = req.query.branch_id as string | undefined;
    const page       = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit      = Math.min(50, parseInt(req.query.limit as string) || 20);
    const from       = (page - 1) * limit;

    let query = supabase
      .from("branch_managers")
      .select("id, name, phone, email, branch_id, brand_id, is_active, created_at, branches(id, name)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, from + limit - 1);

    if (brand_id)  query = query.eq("brand_id",  brand_id);
    if (branch_id) query = query.eq("branch_id", branch_id);

    const { data, count, error } = await query;
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendPaginated(res, data ?? [], count ?? 0, page, limit);
  } catch (err) {
    next(err);
  }
}

// GET /branch-managers/:id
export async function getBranchManager(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branch_managers")
      .select("id, name, phone, email, branch_id, brand_id, is_active, created_at, updated_at, branches(id, name, address)")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Manager introuvable");

    if (req.user!.role === "admin" && data.brand_id !== req.user!.brand_id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// POST /branch-managers — créer un manager d'agence
export async function createBranchManager(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id, name, phone, email, password } = req.body as {
      branch_id: string; name: string; phone: string; email?: string; password: string;
    };

    const brand_id = req.user!.role === "superadmin" ? req.body.brand_id : req.user!.brand_id!;

    // Vérifier que la branche appartient à la marque
    const { data: branch } = await supabase.from("branches").select("brand_id").eq("id", branch_id).single();
    if (!branch || branch.brand_id !== brand_id) {
      throw new AppError(403, "FORBIDDEN", "Cette agence n'appartient pas à votre marque");
    }

    // Vérifier unicité du téléphone
    const { data: existing } = await supabase.from("branch_managers").select("id").eq("phone", phone).maybeSingle();
    if (existing) throw new AppError(409, "CONFLICT", "Ce numéro est déjà utilisé");

    const password_hash = await bcrypt.hash(password, 12);

    const { data, error } = await supabase
      .from("branch_managers")
      .insert({ branch_id, brand_id, name, phone, email: email ?? null, password_hash })
      .select("id, name, phone, email, branch_id, brand_id, is_active, created_at")
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création: " + error?.message);

    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

// PATCH /branch-managers/:id
export async function updateBranchManager(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, phone, email, is_active, password } = req.body;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (name      !== undefined) updates.name       = name;
    if (phone     !== undefined) updates.phone      = phone;
    if (email     !== undefined) updates.email      = email;
    if (is_active !== undefined) updates.is_active  = is_active;
    if (password)                updates.password_hash = await bcrypt.hash(password, 12);

    const { data, error } = await supabase
      .from("branch_managers")
      .update(updates)
      .eq("id", req.params.id)
      .select("id, name, phone, email, branch_id, brand_id, is_active, updated_at")
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Manager introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// DELETE /branch-managers/:id — désactiver (soft delete)
export async function deleteBranchManager(req: Request, res: Response, next: NextFunction) {
  try {
    await supabase
      .from("branch_managers")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);

    sendSuccess(res, null, "Manager désactivé");
  } catch (err) {
    next(err);
  }
}

// POST /branch-managers/:id/reset-password — admin resets password
export async function resetBranchManagerPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { new_password } = req.body as { new_password: string };
    const password_hash = await bcrypt.hash(new_password, 12);

    const { error } = await supabase
      .from("branch_managers")
      .update({ password_hash, updated_at: new Date().toISOString() })
      .eq("id", req.params.id);

    if (error) throw new AppError(500, "DB_ERROR", error.message);
    sendSuccess(res, null, "Mot de passe réinitialisé");
  } catch (err) {
    next(err);
  }
}
