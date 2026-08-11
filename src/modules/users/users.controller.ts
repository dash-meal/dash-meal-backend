import type { Request, Response, NextFunction } from "express";
import bcrypt from "bcryptjs";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated, sendPaginated } from "../../utils/response.js";
import { verifyOtp, verifyEmailOtp } from "../../utils/otp.js";

// ─── Avatar ───────────────────────────────────────────────────────────────────

export async function uploadAvatar(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError(400, "NO_FILE", "Aucun fichier fourni");

    const ext = req.file.mimetype === "image/png" ? "png" : req.file.mimetype === "image/webp" ? "webp" : "jpg";
    const path = `avatars/${req.user!.id}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("profile-images")
      .upload(path, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });
    if (uploadError) throw new AppError(500, "UPLOAD_ERROR", "Échec de l'upload: " + uploadError.message);

    const { data: urlData } = supabase.storage.from("profile-images").getPublicUrl(path);
    const avatar_url = urlData.publicUrl;

    await supabase.from("users").update({ avatar_url }).eq("id", req.user!.id);

    sendSuccess(res, { avatar_url }, "Avatar mis à jour");
  } catch (err) {
    next(err);
  }
}

// ─── Paiement par défaut ─────────────────────────────────────────────────────

export async function updateDefaultPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { phone, method } = req.body as { phone: string; method: string };

    const { data, error } = await supabase
      .from("users")
      .update({ default_payment_phone: phone, default_payment_method: method })
      .eq("id", req.user!.id)
      .select("id, default_payment_phone, default_payment_method")
      .single();

    if (error || !data) throw new AppError(500, "UPDATE_ERROR", "Échec de mise à jour");
    sendSuccess(res, data, "Paiement par défaut enregistré");
  } catch (err) {
    next(err);
  }
}

// ─── Favoris agences ─────────────────────────────────────────────────────────

export async function getFavorites(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branch_favorites")
      .select("branch_id, branches(id, name, address, city, type, brands(id, name, logo_url))")
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false });

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur récupération favoris");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function toggleFavorite(req: Request, res: Response, next: NextFunction) {
  try {
    const { branchId } = req.params;

    const { data: existing } = await supabase
      .from("branch_favorites")
      .select("id")
      .eq("user_id", req.user!.id)
      .eq("branch_id", branchId)
      .maybeSingle();

    if (existing) {
      await supabase.from("branch_favorites").delete().eq("id", existing.id);
      sendSuccess(res, { is_favorite: false }, "Retiré des favoris");
    } else {
      await supabase.from("branch_favorites").insert({ user_id: req.user!.id, branch_id: branchId });
      sendSuccess(res, { is_favorite: true }, "Ajouté aux favoris");
    }
  } catch (err) {
    next(err);
  }
}

// ─── Profil ───────────────────────────────────────────────────────────────────

export async function getMyProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, name, phone, email, is_verified, preferred_locale, created_at, avatar_url, default_payment_phone, default_payment_method, google_id, apple_id")
      .eq("id", req.user!.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Utilisateur introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function updateMyProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("users")
      .update(req.body)
      .eq("id", req.user!.id)
      .select("id, name, phone, preferred_locale")
      .single();

    if (error || !data) throw new AppError(500, "UPDATE_ERROR", "Échec de mise à jour");
    sendSuccess(res, data, "Profil mis à jour");
  } catch (err) {
    next(err);
  }
}

export async function changePassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { method, current_password, new_password, contact, otp } = req.body as {
      method?: "current" | "email" | "sms";
      current_password?: string;
      new_password: string;
      contact?: string;
      otp?: string;
    };

    const resolvedMethod = method ?? "current";

    if (resolvedMethod === "current") {
      const { data: user } = await supabase
        .from("users")
        .select("password_hash")
        .eq("id", req.user!.id)
        .single();

      if (!user) throw new AppError(404, "NOT_FOUND", "Utilisateur introuvable");
      if (!current_password) throw new AppError(400, "MISSING_FIELD", "Mot de passe actuel requis");

      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid) throw new AppError(401, "INVALID_PASSWORD", "Mot de passe actuel incorrect");
    } else {
      if (!contact || !otp) throw new AppError(400, "MISSING_FIELD", "Contact et code OTP requis");

      let isValid = false;
      if (resolvedMethod === "email") {
        isValid = await verifyEmailOtp(contact.trim().toLowerCase(), otp);
      } else {
        isValid = await verifyOtp(contact.trim(), otp);
      }
      if (!isValid) throw new AppError(400, "INVALID_OTP", "Code OTP invalide ou expiré");
    }

    const password_hash = await bcrypt.hash(new_password, 12);
    await supabase.from("users").update({ password_hash }).eq("id", req.user!.id);

    sendSuccess(res, null, "Mot de passe mis à jour");
  } catch (err) {
    next(err);
  }
}

// ─── Adresses sauvegardées ────────────────────────────────────────────────────

export async function listAddresses(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("saved_addresses")
      .select("*")
      .eq("user_id", req.user!.id)
      .order("is_default", { ascending: false });

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function addAddress(req: Request, res: Response, next: NextFunction) {
  try {
    const { is_default, ...rest } = req.body;

    // Si cette adresse est définie comme défaut, retirer le défaut des autres
    if (is_default) {
      await supabase
        .from("saved_addresses")
        .update({ is_default: false })
        .eq("user_id", req.user!.id);
    }

    const { data, error } = await supabase
      .from("saved_addresses")
      .insert({ ...rest, user_id: req.user!.id, is_default: is_default ?? false })
      .select()
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création");
    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

export async function updateAddress(req: Request, res: Response, next: NextFunction) {
  try {
    const { is_default, ...rest } = req.body;

    if (is_default) {
      await supabase
        .from("saved_addresses")
        .update({ is_default: false })
        .eq("user_id", req.user!.id);
    }

    const { data, error } = await supabase
      .from("saved_addresses")
      .update({ ...rest, ...(is_default !== undefined ? { is_default } : {}) })
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id) // sécurité : ne modifier que ses propres adresses
      .select()
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Adresse introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function deleteAddress(req: Request, res: Response, next: NextFunction) {
  try {
    const { error } = await supabase
      .from("saved_addresses")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id);

    if (error) throw new AppError(500, "DELETE_ERROR", "Échec de suppression");
    sendSuccess(res, null, "Adresse supprimée");
  } catch (err) {
    next(err);
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────

export async function getNotifications(req: Request, res: Response, next: NextFunction) {
  try {
    const { page = "1", limit = "20", unread_only } = req.query as Record<string, string>;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from("notifications")
      .select("*", { count: "exact" })
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (unread_only === "true") query = query.eq("is_read", false);

    const { data, count, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    sendPaginated(res, data ?? [], count ?? 0, pageNum, limitNum);
  } catch (err) {
    next(err);
  }
}

export async function markNotificationRead(req: Request, res: Response, next: NextFunction) {
  try {
    const { error } = await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("id", req.params.id)
      .eq("user_id", req.user!.id);

    if (error) throw new AppError(500, "UPDATE_ERROR", "Échec de mise à jour");
    sendSuccess(res, null, "Notification marquée comme lue");
  } catch (err) {
    next(err);
  }
}

export async function markAllNotificationsRead(req: Request, res: Response, next: NextFunction) {
  try {
    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", req.user!.id)
      .eq("is_read", false);

    sendSuccess(res, null, "Toutes les notifications marquées comme lues");
  } catch (err) {
    next(err);
  }
}

// ─── Token push ───────────────────────────────────────────────────────────────

export async function registerPushToken(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, platform } = req.body;
    if (!token) throw new AppError(400, "MISSING_TOKEN", "Token manquant");

    const { error } = await supabase
      .from("push_tokens")
      .upsert(
        { user_id: req.user!.id, token, platform: platform ?? null, updated_at: new Date().toISOString() },
        { onConflict: "token" }  // token est unique — mettre à jour user_id si le token change d'utilisateur
      );

    if (error) {
      // Si la contrainte unique n'est pas sur "token", essayer par user_id
      const { error: err2 } = await supabase
        .from("push_tokens")
        .upsert(
          { user_id: req.user!.id, token, platform: platform ?? null, updated_at: new Date().toISOString() },
          { onConflict: "user_id" }
        );
      if (err2) console.error("[PushToken] Upsert error:", err2.message);
    }

    console.log(`[PushToken] Enregistré pour user ${req.user!.id}: ${token.slice(0, 30)}...`);
    sendSuccess(res, null, "Token enregistré");
  } catch (err) {
    next(err);
  }
}

// ─── Gestion superadmin ───────────────────────────────────────────────────────

export async function listUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const { q, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from("users")
      .select("id, name, phone, is_verified, is_active, preferred_locale, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);

    const { data, count, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    sendPaginated(res, data ?? [], count ?? 0, pageNum, limitNum);
  } catch (err) {
    next(err);
  }
}

export async function getUserById(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, name, phone, is_verified, preferred_locale, created_at")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Utilisateur introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function toggleUserActive(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: user } = await supabase
      .from("users")
      .select("is_active")
      .eq("id", req.params.id)
      .single();

    if (!user) throw new AppError(404, "NOT_FOUND", "Utilisateur introuvable");

    const { data, error } = await supabase
      .from("users")
      .update({ is_active: !(user as { is_active: boolean }).is_active })
      .eq("id", req.params.id)
      .select("id, is_active")
      .single();

    if (error || !data) throw new AppError(500, "UPDATE_ERROR", "Échec de mise à jour");
    sendSuccess(res, data, `Utilisateur ${(data as { is_active: boolean }).is_active ? "activé" : "suspendu"}`);
  } catch (err) {
    next(err);
  }
}
