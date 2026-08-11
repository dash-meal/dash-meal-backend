import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";

export async function getMyFavorites(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;

    const { data, error } = await supabase
      .from("favorites")
      .select(`
        product_id,
        created_at,
        products(
          id,
          name_fr,
          name_en,
          price,
          image_url,
          avg_rating
        )
      `)
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    // Aplatir : retourner directement les infos produit
    const favorites = (data ?? []).map((fav) => {
      const prod = fav.products as unknown as Record<string, unknown>;
      return { ...prod, favorited_at: fav.created_at };
    });

    sendSuccess(res, favorites);
  } catch (err) {
    next(err);
  }
}

export async function addFavorite(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { product_id } = req.params;

    // Vérifier que le produit existe
    const { data: product, error: productErr } = await supabase
      .from("products")
      .select("id")
      .eq("id", product_id)
      .single();

    if (productErr) throw new AppError(productErr.code === "PGRST116" ? 404 : 500, productErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", productErr.code === "PGRST116" ? "Produit introuvable" : productErr.message);
    if (!product) throw new AppError(404, "NOT_FOUND", "Produit introuvable");

    // Upsert — idempotent si déjà en favoris
    const { data, error } = await supabase
      .from("favorites")
      .upsert(
        { user_id: userId, product_id },
        { onConflict: "user_id,product_id", ignoreDuplicates: true }
      )
      .select()
      .maybeSingle();

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendCreated(res, { product_id }, "Ajouté aux favoris");
  } catch (err) {
    next(err);
  }
}

export async function removeFavorite(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { product_id } = req.params;

    const { error } = await supabase
      .from("favorites")
      .delete()
      .eq("user_id", userId)
      .eq("product_id", product_id);

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, null, "Retiré des favoris");
  } catch (err) {
    next(err);
  }
}

export async function checkFavorite(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { product_id } = req.params;

    const { data, error } = await supabase
      .from("favorites")
      .select("product_id")
      .eq("user_id", userId)
      .eq("product_id", product_id)
      .maybeSingle();

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, { is_favorite: data !== null });
  } catch (err) {
    next(err);
  }
}
