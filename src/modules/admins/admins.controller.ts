import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import path from "path";
import { randomUUID } from "crypto";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";

// ─── Admins ───────────────────────────────────────────────────────────────────

export async function listAdmins(req: Request, res: Response, next: NextFunction) {
  try {
    const { brand_id, is_active } = req.query;

    let query = supabase
      .from("admins")
      .select("id, username, email, phone, role, is_active, created_at, brands(name)")
      .order("created_at", { ascending: false });

    if (brand_id) query = query.eq("brand_id", brand_id as string);
    if (is_active !== undefined) query = query.eq("is_active", is_active === "true");

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function getAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("admins")
      .select("id, username, email, phone, role, is_active, created_at, brands(id, name, logo_url)")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Admin introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function createAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const { username, email, phone, password, brand_id } = req.body;

    // Vérifier unicité
    const { data: existing } = await supabase
      .from("admins")
      .select("id")
      .or(`email.eq.${email},phone.eq.${phone},username.eq.${username}`)
      .single();

    if (existing) {
      throw new AppError(409, "ALREADY_EXISTS", "Email, téléphone ou nom d'utilisateur déjà utilisé");
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data, error } = await supabase
      .from("admins")
      .insert({ username, email, phone, password_hash, brand_id, role: "admin", is_active: true })
      .select("id, username, email, phone, role, is_active, created_at")
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création");
    sendCreated(res, data, "Admin créé avec succès");
  } catch (err) {
    next(err);
  }
}

export async function updateAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    // Ne pas autoriser la modification du mot de passe via cette route
    const { password: _, password_hash: __, ...safeUpdate } = req.body as Record<string, unknown>;

    const { data, error } = await supabase
      .from("admins")
      .update(safeUpdate)
      .eq("id", req.params.id)
      .select("id, username, email, phone, role, is_active")
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Admin introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function toggleAdminActive(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: admin } = await supabase
      .from("admins")
      .select("is_active")
      .eq("id", req.params.id)
      .single();

    if (!admin) throw new AppError(404, "NOT_FOUND", "Admin introuvable");

    const { data, error } = await supabase
      .from("admins")
      .update({ is_active: !admin.is_active })
      .eq("id", req.params.id)
      .select("id, is_active")
      .single();

    if (error || !data) throw new AppError(500, "UPDATE_ERROR", "Échec de mise à jour");
    sendSuccess(res, data, `Admin ${data.is_active ? "activé" : "suspendu"}`);
  } catch (err) {
    next(err);
  }
}

export async function resetAdminPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { password } = req.body as { password?: string };
    if (!password || password.length < 8) {
      throw new AppError(400, "INVALID_PASSWORD", "Le mot de passe doit faire au moins 8 caractères");
    }

    const { data: admin } = await supabase
      .from("admins")
      .select("id")
      .eq("id", req.params.id)
      .single();

    if (!admin) throw new AppError(404, "NOT_FOUND", "Admin introuvable");

    const password_hash = await bcrypt.hash(password, 12);

    const { error } = await supabase
      .from("admins")
      .update({ password_hash })
      .eq("id", req.params.id);

    if (error) throw new AppError(500, "UPDATE_ERROR", "Échec de la réinitialisation");

    sendSuccess(res, { id: req.params.id }, "Mot de passe réinitialisé");
  } catch (err) {
    next(err);
  }
}

export async function deleteAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    // Soft delete : désactiver plutôt que supprimer
    const { error } = await supabase
      .from("admins")
      .update({ is_active: false })
      .eq("id", req.params.id);

    if (error) throw new AppError(500, "DELETE_ERROR", "Échec de suppression");
    sendSuccess(res, null, "Admin supprimé");
  } catch (err) {
    next(err);
  }
}

// ─── Drivers ─────────────────────────────────────────────────────────────────

export async function listDrivers(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.role === "superadmin"
      ? (req.query.brand_id as string | undefined)
      : req.user!.brand_id;

    let query = supabase
      .from("drivers")
      .select("id, name, phone, branch_id, brand_id, is_active, photo_url, created_at, branches(name)")
      .order("created_at", { ascending: false });

    if (brand_id) query = query.eq("brand_id", brand_id);

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

export async function getDriver(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("drivers")
      .select("*, branches(name, address)")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Livreur introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function uploadDriverPhoto(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError(400, "NO_FILE", "Aucun fichier reçu");
    const ext = path.extname(req.file.originalname).toLowerCase() || ".jpg";
    if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext))
      throw new AppError(400, "INVALID_TYPE", "Type non supporté (jpg/png/webp)");
    const brand_id = req.user!.brand_id ?? "shared";
    const filename = `${brand_id}/${randomUUID()}${ext}`;
    const { error } = await supabase.storage
      .from("driver-photos")
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (error) throw new AppError(500, "UPLOAD_ERROR", "Échec de l'upload : " + error.message);
    const { data } = supabase.storage.from("driver-photos").getPublicUrl(filename);
    sendSuccess(res, { url: data.publicUrl });
  } catch (err) {
    next(err);
  }
}

export async function createDriver(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, phone, branch_id, pin, photo_url } = req.body;

    const { data: existing } = await supabase
      .from("drivers")
      .select("id")
      .eq("phone", phone)
      .maybeSingle();

    if (existing) {
      throw new AppError(409, "ALREADY_EXISTS", "Ce numéro est déjà enregistré");
    }

    const pin_hash = pin ? await bcrypt.hash(String(pin), 12) : null;

    const { data, error } = await supabase
      .from("drivers")
      .insert({
        name,
        phone,
        admin_id: req.user!.id,
        brand_id: req.user!.brand_id ?? null,
        branch_id: branch_id ?? null,
        is_active: false,
        pin_hash,
        photo_url: photo_url ?? null,
      })
      .select("id, name, phone, branch_id, brand_id, is_active, photo_url, created_at")
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création");
    sendCreated(res, data, "Livreur créé avec succès");
  } catch (err) {
    next(err);
  }
}

export async function setDriverPin(req: Request, res: Response, next: NextFunction) {
  try {
    const { pin } = req.body as { pin?: string };
    if (!pin || pin.length < 4 || pin.length > 8) {
      throw new AppError(400, "INVALID_PIN", "Le PIN doit faire entre 4 et 8 chiffres");
    }

    const { data: driver } = await supabase
      .from("drivers")
      .select("id")
      .eq("id", req.params.id)
      .single();

    if (!driver) throw new AppError(404, "NOT_FOUND", "Livreur introuvable");

    const pin_hash = await bcrypt.hash(pin, 12);
    await supabase.from("drivers").update({ pin_hash }).eq("id", req.params.id);

    sendSuccess(res, { id: req.params.id }, "PIN mis à jour");
  } catch (err) {
    next(err);
  }
}

export async function updateDriver(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("drivers")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Livreur introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function toggleDriverActive(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: driver } = await supabase
      .from("drivers")
      .select("is_active")
      .eq("id", req.params.id)
      .single();

    if (!driver) throw new AppError(404, "NOT_FOUND", "Livreur introuvable");

    const { data, error } = await supabase
      .from("drivers")
      .update({ is_active: !driver.is_active })
      .eq("id", req.params.id)
      .select("id, is_active")
      .single();

    if (error || !data) throw new AppError(500, "UPDATE_ERROR", "Échec de mise à jour");
    sendSuccess(res, data, `Livreur ${data.is_active ? "activé" : "suspendu"}`);
  } catch (err) {
    next(err);
  }
}
