import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { env } from "../../config/env.js";

const ACCESS_EXPIRES  = "24h";
const REFRESH_EXPIRES = "30d";

function signTokens(manager: { id: string; brand_id: string; branch_id: string; name: string }) {
  const payload = { id: manager.id, role: "branch_manager", brand_id: manager.brand_id, branch_id: manager.branch_id, name: manager.name };
  const access_token  = jwt.sign(payload, env.JWT_SECRET, { expiresIn: ACCESS_EXPIRES });
  const refresh_token = jwt.sign({ id: manager.id, role: "branch_manager" }, env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES });
  return { access_token, refresh_token, expires_in: 86400 };
}

// POST /branch-auth/login
export async function loginBranchManager(req: Request, res: Response, next: NextFunction) {
  try {
    const { phone, password } = req.body as { phone: string; password: string };

    const { data: manager, error } = await supabase
      .from("branch_managers")
      .select("id, branch_id, brand_id, name, phone, email, is_active, password_hash")
      .eq("phone", phone.trim())
      .single();

    if (error || !manager) throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");
    if (!manager.is_active)  throw new AppError(403, "ACCOUNT_DISABLED",   "Compte désactivé");

    const valid = await bcrypt.compare(password, manager.password_hash);
    if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "Identifiants incorrects");

    const tokens = signTokens(manager);

    sendSuccess(res, {
      manager: { id: manager.id, name: manager.name, phone: manager.phone, email: manager.email, branch_id: manager.branch_id, brand_id: manager.brand_id },
      tokens,
    }, "Connexion réussie");
  } catch (err) {
    next(err);
  }
}

// POST /branch-auth/refresh
export async function refreshBranchToken(req: Request, res: Response, next: NextFunction) {
  try {
    const { refresh_token } = req.body as { refresh_token: string };
    if (!refresh_token) throw new AppError(400, "MISSING_TOKEN", "Token de rafraîchissement manquant");

    let payload: { id: string };
    try {
      payload = jwt.verify(refresh_token, env.JWT_REFRESH_SECRET) as { id: string };
    } catch {
      throw new AppError(401, "INVALID_TOKEN", "Token invalide ou expiré");
    }

    const { data: manager } = await supabase
      .from("branch_managers")
      .select("id, branch_id, brand_id, name, is_active")
      .eq("id", payload.id)
      .single();

    if (!manager || !manager.is_active) throw new AppError(401, "ACCOUNT_DISABLED", "Compte désactivé");

    const tokens = signTokens(manager);
    sendSuccess(res, tokens);
  } catch (err) {
    next(err);
  }
}

// GET /branch-auth/me
export async function getBranchManagerMe(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branch_managers")
      .select("id, name, phone, email, branch_id, brand_id, is_active, created_at, branches(id, name, address, lat, lng, phone)")
      .eq("id", req.user!.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Compte introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// PATCH /branch-auth/me — change password
export async function updateBranchManagerPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { current_password, new_password } = req.body as { current_password: string; new_password: string };

    const { data: manager } = await supabase
      .from("branch_managers")
      .select("password_hash")
      .eq("id", req.user!.id)
      .single();

    if (!manager) throw new AppError(404, "NOT_FOUND", "Compte introuvable");

    const valid = await bcrypt.compare(current_password, manager.password_hash);
    if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "Mot de passe actuel incorrect");

    const password_hash = await bcrypt.hash(new_password, 12);
    await supabase.from("branch_managers").update({ password_hash, updated_at: new Date().toISOString() }).eq("id", req.user!.id);

    sendSuccess(res, null, "Mot de passe mis à jour");
  } catch (err) {
    next(err);
  }
}
