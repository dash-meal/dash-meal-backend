import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";

export async function listZones(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const branchId = req.query.branch_id as string | undefined;

    let query = supabase
      .from("delivery_zones")
      .select("*")
      .order("name", { ascending: true });

    if (user.role === "branch_manager") {
      // Le branch_manager ne voit que les zones de sa propre agence
      if (!user.branch_id) throw new AppError(403, "FORBIDDEN", "Agence non associée");
      query = query.eq("branch_id", user.branch_id);
    } else if (user.role === "admin") {
      // L'admin voit uniquement les zones des agences de sa marque
      if (!user.brand_id) throw new AppError(403, "FORBIDDEN", "Marque non associée");

      if (branchId) {
        // Vérifier que cette agence appartient bien à la marque de l'admin
        const { data: branch } = await supabase
          .from("branches")
          .select("brand_id")
          .eq("id", branchId)
          .single();
        if (!branch || branch.brand_id !== user.brand_id) {
          throw new AppError(403, "FORBIDDEN", "Cette agence n'appartient pas à votre marque");
        }
        query = query.eq("branch_id", branchId);
      } else {
        // Récupérer toutes les agences de la marque
        const { data: branches } = await supabase
          .from("branches")
          .select("id")
          .eq("brand_id", user.brand_id);
        const branchIds = (branches ?? []).map((b) => b.id);
        if (!branchIds.length) {
          sendSuccess(res, []);
          return;
        }
        query = query.in("branch_id", branchIds);
      }
    } else if (branchId) {
      // superadmin peut filtrer par agence si fourni
      query = query.eq("branch_id", branchId);
    }

    const { data, error } = await query;
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

export async function getZone(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;

    const { data, error } = await supabase
      .from("delivery_zones")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error?.code === "PGRST116" || !data) throw new AppError(404, "NOT_FOUND", "Zone de livraison introuvable");
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    // Vérifier accès
    if (user.role === "branch_manager" && data.branch_id !== user.branch_id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé à cette zone");
    }

    if (user.role === "admin") {
      const { data: branch } = await supabase
        .from("branches")
        .select("brand_id")
        .eq("id", data.branch_id)
        .single();
      if (!branch || branch.brand_id !== user.brand_id) {
        throw new AppError(403, "FORBIDDEN", "Cette zone n'appartient pas à votre marque");
      }
    }

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function createZone(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const { branch_id, name, delivery_fee, min_order, estimated_min, polygon, color } = req.body as {
      branch_id: string;
      name: string;
      delivery_fee: number;
      min_order?: number;
      estimated_min?: number;
      polygon: Array<{ lat: number; lng: number }>;
      color?: string;
    };

    // Vérifier que l'admin administre bien cette agence
    if (user.role === "admin") {
      const { data: branch } = await supabase
        .from("branches")
        .select("brand_id")
        .eq("id", branch_id)
        .single();
      if (!branch || branch.brand_id !== user.brand_id) {
        throw new AppError(403, "FORBIDDEN", "Cette agence n'appartient pas à votre marque");
      }
    }

    const { data, error } = await supabase
      .from("delivery_zones")
      .insert({
        branch_id,
        name,
        delivery_fee: Number(delivery_fee),
        min_order: min_order ? Number(min_order) : null,
        estimated_min: estimated_min ? Number(estimated_min) : null,
        polygon,
        color: color ?? null,
        is_active: true,
      })
      .select()
      .single();

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendCreated(res, data, "Zone de livraison créée");
  } catch (err) {
    next(err);
  }
}

export async function updateZone(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;

    // Récupérer la zone pour vérifier l'appartenance
    const { data: existing, error: fetchErr } = await supabase
      .from("delivery_zones")
      .select("id, branch_id")
      .eq("id", req.params.id)
      .single();

    if (fetchErr) throw new AppError(fetchErr.code === "PGRST116" ? 404 : 500, fetchErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", fetchErr.code === "PGRST116" ? "Zone introuvable" : fetchErr.message);
    if (!existing) throw new AppError(404, "NOT_FOUND", "Zone introuvable");

    if (user.role === "admin") {
      const { data: branch } = await supabase
        .from("branches")
        .select("brand_id")
        .eq("id", existing.branch_id)
        .single();
      if (!branch || branch.brand_id !== user.brand_id) {
        throw new AppError(403, "FORBIDDEN", "Cette zone n'appartient pas à votre marque");
      }
    }

    const allowed = ["name", "delivery_fee", "min_order", "estimated_min", "polygon", "color", "is_active"];
    const updates: Record<string, unknown> = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updated_at = new Date().toISOString();

    const { data, error: updateErr } = await supabase
      .from("delivery_zones")
      .update(updates)
      .eq("id", req.params.id)
      .select()
      .single();

    if (updateErr) throw new AppError(500, "DB_ERROR", updateErr.message);

    sendSuccess(res, data, "Zone mise à jour");
  } catch (err) {
    next(err);
  }
}

export async function deleteZone(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;

    const { data: existing, error: fetchErr } = await supabase
      .from("delivery_zones")
      .select("id, branch_id")
      .eq("id", req.params.id)
      .single();

    if (fetchErr) throw new AppError(fetchErr.code === "PGRST116" ? 404 : 500, fetchErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", fetchErr.code === "PGRST116" ? "Zone introuvable" : fetchErr.message);
    if (!existing) throw new AppError(404, "NOT_FOUND", "Zone introuvable");

    if (user.role === "admin") {
      const { data: branch } = await supabase
        .from("branches")
        .select("brand_id")
        .eq("id", existing.branch_id)
        .single();
      if (!branch || branch.brand_id !== user.brand_id) {
        throw new AppError(403, "FORBIDDEN", "Cette zone n'appartient pas à votre marque");
      }
    }

    const { error: deleteErr } = await supabase
      .from("delivery_zones")
      .delete()
      .eq("id", req.params.id);

    if (deleteErr) throw new AppError(500, "DB_ERROR", deleteErr.message);

    sendSuccess(res, null, "Zone supprimée");
  } catch (err) {
    next(err);
  }
}

export async function getZonesPublic(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id } = req.params;

    const { data, error } = await supabase
      .from("delivery_zones")
      .select("id, name, delivery_fee, min_order, estimated_min, polygon, color")
      .eq("branch_id", branch_id)
      .eq("is_active", true)
      .order("delivery_fee", { ascending: true });

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}
