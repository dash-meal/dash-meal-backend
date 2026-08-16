import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import { sendBranchLiveRequestEmail, sendBranchLiveDecisionEmail } from "../../utils/email.js";
import { env } from "../../config/env.js";
import type { BranchType } from "../../shared/index.js";

const DEFAULT_CATEGORIES: Record<BranchType, { name_fr: string; name_en: string; icon: string; sort_order: number }[]> = {
  supermarket: [
    { name_fr: "Épicerie", name_en: "Grocery", icon: "🛒", sort_order: 1 },
    { name_fr: "Boissons", name_en: "Beverages", icon: "🥤", sort_order: 2 },
    { name_fr: "Produits laitiers", name_en: "Dairy", icon: "🥛", sort_order: 3 },
    { name_fr: "Viandes & Poissons", name_en: "Meat & Fish", icon: "🥩", sort_order: 4 },
    { name_fr: "Fruits & Légumes", name_en: "Fruits & Vegetables", icon: "🥦", sort_order: 5 },
    { name_fr: "Boulangerie", name_en: "Bakery", icon: "🥖", sort_order: 6 },
    { name_fr: "Surgelés", name_en: "Frozen", icon: "❄️", sort_order: 7 },
    { name_fr: "Hygiène", name_en: "Hygiene", icon: "🧴", sort_order: 8 },
    { name_fr: "Ménager", name_en: "Household", icon: "🧹", sort_order: 9 },
  ],
  superette: [
    { name_fr: "Épicerie", name_en: "Grocery", icon: "🛒", sort_order: 1 },
    { name_fr: "Boissons", name_en: "Beverages", icon: "🥤", sort_order: 2 },
    { name_fr: "Snacks", name_en: "Snacks", icon: "🍿", sort_order: 3 },
    { name_fr: "Hygiène", name_en: "Hygiene", icon: "🧴", sort_order: 4 },
    { name_fr: "Boulangerie", name_en: "Bakery", icon: "🥖", sort_order: 5 },
  ],
  restaurant: [
    { name_fr: "Entrées", name_en: "Starters", icon: "🥗", sort_order: 1 },
    { name_fr: "Plats principaux", name_en: "Main dishes", icon: "🍽️", sort_order: 2 },
    { name_fr: "Desserts", name_en: "Desserts", icon: "🍰", sort_order: 3 },
    { name_fr: "Boissons", name_en: "Beverages", icon: "🥤", sort_order: 4 },
    { name_fr: "Menus", name_en: "Menus", icon: "📋", sort_order: 5 },
  ],
  cafe: [
    { name_fr: "Boissons chaudes", name_en: "Hot drinks", icon: "☕", sort_order: 1 },
    { name_fr: "Boissons froides", name_en: "Cold drinks", icon: "🧊", sort_order: 2 },
    { name_fr: "Viennoiseries", name_en: "Pastries", icon: "🥐", sort_order: 3 },
    { name_fr: "Snacks", name_en: "Snacks", icon: "🍿", sort_order: 4 },
  ],
  bakery: [
    { name_fr: "Pains", name_en: "Bread", icon: "🍞", sort_order: 1 },
    { name_fr: "Viennoiseries", name_en: "Pastries", icon: "🥐", sort_order: 2 },
    { name_fr: "Gâteaux", name_en: "Cakes", icon: "🎂", sort_order: 3 },
    { name_fr: "Boissons", name_en: "Beverages", icon: "🥤", sort_order: 4 },
  ],
  pharmacy: [
    { name_fr: "Médicaments", name_en: "Medicines", icon: "💊", sort_order: 1 },
    { name_fr: "Hygiène", name_en: "Hygiene", icon: "🧴", sort_order: 2 },
    { name_fr: "Cosmétiques", name_en: "Cosmetics", icon: "💄", sort_order: 3 },
    { name_fr: "Bébé", name_en: "Baby", icon: "👶", sort_order: 4 },
  ],
  other: [
    { name_fr: "Produits", name_en: "Products", icon: "📦", sort_order: 1 },
  ],
};

export async function listBranches(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.role === "superadmin"
      ? (req.query.brand_id as string | undefined)
      : req.user!.brand_id;

    let query = supabase
      .from("branches")
      .select("*, brands(id, name, logo_url), branch_verticals(*)")
      .order("created_at", { ascending: false });

    if (brand_id) query = query.eq("brand_id", brand_id);

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

/** Haversine distance in km between two lat/lng points */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function getNearbyBranches(req: Request, res: Response, next: NextFunction) {
  try {
    const { lat, lng, radius_km = "50", brand_id } = req.query;

    let query = supabase
      .from("branches")
      .select("*, brands(id, name, logo_url), branch_verticals(*)")
      .eq("is_active", true);

    if (brand_id) query = query.eq("brand_id", brand_id);

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    let branches = data ?? [];

    // Sort by distance if GPS coordinates are provided and branches have lat/lng
    if (lat && lng) {
      const userLat = parseFloat(String(lat));
      const userLng = parseFloat(String(lng));
      const maxKm = parseFloat(String(radius_km));

      if (!isNaN(userLat) && !isNaN(userLng)) {
        // Add distance_km to each branch (if it has coordinates)
        const withDistance = branches.map((b: any) => {
          const bLat = b.lat ?? b.latitude;
          const bLng = b.lng ?? b.longitude;
          const distance_km = (bLat != null && bLng != null)
            ? haversineKm(userLat, userLng, bLat, bLng)
            : null;
          return { ...b, distance_km };
        });

        // Filter by radius if branches have coordinates; keep those without coords too
        const filtered = withDistance.filter((b: any) =>
          b.distance_km === null || b.distance_km <= maxKm
        );

        // Sort: branches with coords first (nearest first), then those without
        filtered.sort((a: any, b: any) => {
          if (a.distance_km === null && b.distance_km === null) return 0;
          if (a.distance_km === null) return 1;
          if (b.distance_km === null) return -1;
          return a.distance_km - b.distance_km;
        });

        branches = filtered;
      }
    }

    sendSuccess(res, branches);
  } catch (err) {
    next(err);
  }
}

export async function getBranch(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branches")
      .select("*, brands(id, name, logo_url), branch_verticals(*)")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Agence introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function createBranch(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.role === "superadmin"
      ? req.body.brand_id
      : req.user!.brand_id;

    const branchType: BranchType = req.body.type ?? "other";

    // Si vertical_id n'est pas fourni explicitement, le résoudre depuis `type`
    // (garde le comportement existant du frontend qui n'envoie que `type`).
    let vertical_id = req.body.vertical_id as string | undefined;
    if (!vertical_id) {
      const { data: vertical } = await supabase
        .from("branch_verticals")
        .select("id")
        .eq("key", branchType)
        .maybeSingle();
      vertical_id = vertical?.id;
    }

    const { data, error } = await supabase
      .from("branches")
      .insert({ ...req.body, brand_id, vertical_id, status: "draft" })
      .select()
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création");

    // Créer les catégories par défaut selon le type d'établissement
    const defaultCats = DEFAULT_CATEGORIES[branchType] ?? DEFAULT_CATEGORIES.other;
    if (defaultCats.length > 0) {
      await supabase.from("categories").insert(
        defaultCats.map((c) => ({ ...c, branch_id: data.id }))
      );
    }

    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

export async function updateBranch(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branches")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Agence introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function deleteBranch(req: Request, res: Response, next: NextFunction) {
  try {
    await supabase
      .from("branches")
      .update({ is_active: false })
      .eq("id", req.params.id);

    sendSuccess(res, null, "Agence désactivée");
  } catch (err) {
    next(err);
  }
}

export async function getTimeSlots(req: Request, res: Response, next: NextFunction) {
  try {
    const { date } = req.query;
    let query = supabase
      .from("time_slots")
      .select("*")
      .eq("branch_id", req.params.id)
      .filter("booked", "lt", "capacity"); // créneaux non complets

    if (date) query = query.eq("date", date);

    const { data, error } = await query.order("start_time");
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function createTimeSlot(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("time_slots")
      .insert({ ...req.body, booked: 0 })
      .select()
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création");
    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

export async function createDeliveryZone(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("delivery_zones")
      .insert(req.body)
      .select()
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création");
    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

export async function getDeliveryZones(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("delivery_zones")
      .select("*")
      .eq("branch_id", req.params.id)
      .eq("is_active", true);

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Upload image agence ───────────────────────────────────────────────────────
export async function uploadBranchImage(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError(400, "NO_FILE", "Aucun fichier reçu");

    const { id } = req.params;
    const ext = req.file.originalname.split(".").pop()?.toLowerCase() ?? "jpg";
    const filename = `branches/${id}/cover.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from(env.STORAGE_BUCKET_PRODUCTS ?? "product-images")
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: true });

    if (uploadErr) throw new AppError(500, "UPLOAD_ERROR", "Erreur upload image");

    const { data: urlData } = supabase.storage
      .from(env.STORAGE_BUCKET_PRODUCTS ?? "product-images")
      .getPublicUrl(filename);

    await supabase.from("branches").update({ image_url: urlData.publicUrl }).eq("id", id);
    sendSuccess(res, { image_url: urlData.publicUrl });
  } catch (err) {
    next(err);
  }
}

// ─── Demande de mise en ligne ──────────────────────────────────────────────────
export async function requestLive(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;

    const { data: branch, error: bErr } = await supabase
      .from("branches")
      .select("*, brands(id, name, admins(email, username))")
      .eq("id", id)
      .single();

    if (bErr || !branch) throw new AppError(404, "NOT_FOUND", "Agence introuvable");
    if (branch.status === "live") throw new AppError(400, "ALREADY_LIVE", "L'agence est déjà en ligne");
    if (branch.status === "pending_approval") throw new AppError(400, "PENDING", "Demande déjà en cours");

    await supabase.from("branches")
      .update({ status: "pending_approval", go_live_requested_at: new Date().toISOString() })
      .eq("id", id);

    // Notifier l'admin par email
    const brand = branch.brands as any;
    const adminList = Array.isArray(brand?.admins) ? brand.admins : [brand?.admins].filter(Boolean);
    for (const admin of adminList) {
      if (admin?.email) {
        await sendBranchLiveRequestEmail({
          adminEmail: admin.email,
          adminName: admin.username ?? "Admin",
          branchName: branch.name,
          branchEmail: branch.email ?? "—",
        });
      }
    }

    sendSuccess(res, { status: "pending_approval" }, "Demande de mise en ligne envoyée");
  } catch (err) {
    next(err);
  }
}

// ─── Approuver / Rejeter la mise en ligne ─────────────────────────────────────
export async function reviewLiveRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { approved, reason } = req.body as { approved: boolean; reason?: string };

    const { data: branch, error: bErr } = await supabase
      .from("branches")
      .select("name, email, status")
      .eq("id", id)
      .single();

    if (bErr || !branch) throw new AppError(404, "NOT_FOUND", "Agence introuvable");
    if (branch.status !== "pending_approval") throw new AppError(400, "NOT_PENDING", "Aucune demande en attente");

    const newStatus = approved ? "live" : "draft";
    await supabase.from("branches")
      .update({
        status: newStatus,
        approved_at: approved ? new Date().toISOString() : null,
        approved_by: req.user!.id,
      })
      .eq("id", id);

    if (branch.email) {
      await sendBranchLiveDecisionEmail({
        to: branch.email,
        branchName: branch.name,
        approved,
        reason,
      });
    }

    sendSuccess(res, { status: newStatus }, approved ? "Agence mise en ligne" : "Demande refusée");
  } catch (err) {
    next(err);
  }
}
