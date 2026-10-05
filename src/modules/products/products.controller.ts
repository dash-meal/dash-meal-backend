import type { Request, Response, NextFunction } from "express";
import path from "path";
import { randomUUID } from "crypto";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated, sendPaginated } from "../../utils/response.js";
import { env } from "../../config/env.js";

export async function uploadImage(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError(400, "NO_FILE", "Aucun fichier reçu");

    const ext = path.extname(req.file.originalname).toLowerCase() || ".jpg";
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    if (!allowed.includes(ext)) throw new AppError(400, "INVALID_TYPE", "Type de fichier non supporté (jpg/png/webp)");

    const brand_id = req.user!.brand_id ?? "superadmin";
    const filename = `${brand_id}/${randomUUID()}${ext}`;
    const bucket = env.STORAGE_BUCKET_PRODUCTS ?? "product-images";

    const { error } = await supabase.storage
      .from(bucket)
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (error) throw new AppError(500, "UPLOAD_ERROR", "Échec de l'upload : " + error.message);

    const { data } = supabase.storage.from(bucket).getPublicUrl(filename);
    sendSuccess(res, { url: data.publicUrl });
  } catch (err) {
    next(err);
  }
}

export async function searchProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const { q, category_id, branch_id, min_price, max_price, in_stock, page = 1, limit = 20 } = req.query as Record<string, string>;

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;

    let query = supabase
      .from("products")
      .select(`
        *,
        product_images(url, is_primary),
        product_variants(*),
        branch_stock!inner(stock_qty)
      `, { count: "exact" })
      .eq("is_active", true)
      .eq("branch_stock.branch_id", branch_id)
      .range(offset, offset + limitNum - 1);

    if (q) query = query.ilike("name_fr", `%${q}%`);
    if (category_id) query = query.eq("category_id", category_id);
    if (min_price) query = query.gte("price", Number(min_price));
    if (max_price) query = query.lte("price", Number(max_price));
    if (in_stock === "true") query = query.gt("branch_stock.stock_qty", 0);

    const { data, count, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la recherche");

    sendPaginated(res, data ?? [], count ?? 0, pageNum, limitNum);
  } catch (err) {
    next(err);
  }
}

export async function getProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("*, product_images(*), product_variants(*), categories(name_fr, name_en)")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Produit introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function listByBranch(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id } = req.params;
    const isAdmin = req.user?.role === "admin" || req.user?.role === "superadmin";

    // Les admins vérifient l'accès à leur agence
    if (req.user?.role === "admin") {
      const { data: branch } = await supabase
        .from("branches")
        .select("brand_id")
        .eq("id", branch_id)
        .single();
      if (!branch || branch.brand_id !== req.user.brand_id) {
        throw new AppError(403, "FORBIDDEN", "Accès refusé à cette agence");
      }
    }

    let query = supabase
      .from("products")
      .select("*, categories(name_fr, name_en), product_images(url, is_primary)")
      .eq("branch_id", branch_id)
      .order("created_at", { ascending: false });

    // Utilisateurs mobiles et non-authentifiés : seulement les produits visibles
    if (!isAdmin) {
      query = query.eq("is_hidden", false).eq("is_active", true);
    }

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

export async function createProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.role === "superadmin" ? req.body.brand_id : req.user!.brand_id;

    // Vérifier que l'agence appartient à la marque de l'admin
    if (req.user!.role === "admin" && req.body.branch_id) {
      const { data: branch } = await supabase
        .from("branches")
        .select("brand_id")
        .eq("id", req.body.branch_id)
        .single();
      if (!branch || branch.brand_id !== brand_id) {
        throw new AppError(403, "FORBIDDEN", "Cette agence n'appartient pas à votre marque");
      }
    }

    const { data, error } = await supabase
      .from("products")
      .insert({ ...req.body, brand_id })
      .select()
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", error?.message ?? "Échec de création");
    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

export async function toggleHidden(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: product } = await supabase
      .from("products")
      .select("is_hidden, brand_id")
      .eq("id", req.params.id)
      .single();

    if (!product) throw new AppError(404, "NOT_FOUND", "Produit introuvable");
    if (req.user!.role === "admin" && product.brand_id !== req.user!.brand_id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    const { data, error } = await supabase
      .from("products")
      .update({ is_hidden: !product.is_hidden })
      .eq("id", req.params.id)
      .select("id, is_hidden")
      .single();

    if (error || !data) throw new AppError(500, "UPDATE_ERROR", "Échec de mise à jour");
    sendSuccess(res, data, `Produit ${data.is_hidden ? "masqué" : "visible"}`);
  } catch (err) {
    next(err);
  }
}

export async function setPromo(req: Request, res: Response, next: NextFunction) {
  try {
    const { promo_price, promo_ends_at } = req.body;

    const { data: product } = await supabase
      .from("products")
      .select("brand_id")
      .eq("id", req.params.id)
      .single();

    if (!product) throw new AppError(404, "NOT_FOUND", "Produit introuvable");
    if (req.user!.role === "admin" && product.brand_id !== req.user!.brand_id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    const { data, error } = await supabase
      .from("products")
      .update({ promo_price: promo_price ?? null, promo_ends_at: promo_ends_at ?? null })
      .eq("id", req.params.id)
      .select("id, price, promo_price, promo_ends_at")
      .single();

    if (error || !data) throw new AppError(500, "UPDATE_ERROR", "Échec de mise à jour");
    sendSuccess(res, data, promo_price ? "Promo activée" : "Promo retirée");
  } catch (err) {
    next(err);
  }
}

export async function updateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("products")
      .update(req.body)
      .eq("id", req.params.id)
      .select()
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Produit introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function deleteProduct(req: Request, res: Response, next: NextFunction) {
  try {
    await supabase.from("products").update({ is_active: false }).eq("id", req.params.id);
    sendSuccess(res, null, "Produit désactivé");
  } catch (err) {
    next(err);
  }
}

export async function createVariant(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("product_variants")
      .insert({ ...req.body, product_id: req.params.id })
      .select()
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création");
    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

export async function updateStock(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id, product_id, variant_id, stock_qty } = req.body;

    const { data, error } = await supabase
      .from("branch_stock")
      .upsert({ branch_id, product_id, variant_id: variant_id ?? null, stock_qty, updated_at: new Date().toISOString() })
      .select()
      .single();

    if (error || !data) throw new AppError(500, "STOCK_UPDATE_ERROR", "Échec mise à jour stock");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function getStockByBranch(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("branch_stock")
      .select("*, branches(name)")
      .eq("product_id", req.params.id);

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function listCategories(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id } = req.query;
    let query = supabase.from("categories").select("*").order("sort_order");

    if (branch_id) {
      // Catégories de l'agence + catégories globales (branch_id null)
      query = query.or(`branch_id.eq.${branch_id},branch_id.is.null`);
    }

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function createCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("categories")
      .insert(req.body)
      .select()
      .single();

    if (error || !data) throw new AppError(500, "CREATE_ERROR", "Échec de création");
    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

export async function deleteCategory(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: cat } = await supabase
      .from("categories")
      .select("branch_id")
      .eq("id", req.params.id)
      .single();

    if (!cat) throw new AppError(404, "NOT_FOUND", "Catégorie introuvable");
    if (!cat.branch_id) throw new AppError(403, "FORBIDDEN", "Impossible de supprimer une catégorie globale");

    await supabase.from("categories").delete().eq("id", req.params.id);
    sendSuccess(res, null, "Catégorie supprimée");
  } catch (err) {
    next(err);
  }
}

// ─── Public mobile : liste des produits visibles ──────────────────────────────
export async function listPublicProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const { promo, flash, limit = "12", category, branch_id, search, sort } = req.query as Record<string, string>;

    let query = supabase
      .from("products")
      .select(`
        id, name, name_fr, name_en, price, original_price, image_url,
        discount_pct, unit, is_hidden, avg_rating, ratings_count,
        branches!inner ( id, name, category, is_active ),
        product_images ( url, is_primary )
      `)
      .eq("is_hidden", false)
      .eq("branches.is_active", true)
      .limit(Number(limit));

    if (sort === "rating") {
      query = query.order("avg_rating", { ascending: false });
    } else {
      query = query.order("created_at", { ascending: false });
    }

    if (promo === "true") query = query.not("original_price", "is", null);
    if (flash === "true") query = query.eq("is_flash", true);
    if (branch_id)        query = query.eq("branch_id", branch_id);
    if (category)         query = query.eq("branches.category", category);
    if (search)           query = query.ilike("name", `%${search}%`);

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", error.message);
    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

// ─── Public mobile : noter un produit (upsert) ────────────────────────────────
export async function rateProduct(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const user_id = req.user!.id;
    const rating = Number(req.body.rating);

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new AppError(400, "INVALID_RATING", "La note doit être entre 1 et 5");
    }

    const { data, error } = await supabase
      .from("product_ratings")
      .upsert(
        { product_id: id, user_id, rating, updated_at: new Date().toISOString() },
        { onConflict: "product_id,user_id" }
      )
      .select()
      .single();

    if (error) throw new AppError(500, "RATE_ERROR", error.message);
    sendSuccess(res, data, "Note enregistrée");
  } catch (err) {
    next(err);
  }
}

// ─── Public mobile : note de l'utilisateur connecté pour un produit ───────────
export async function getUserProductRating(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const user_id = req.user!.id;

    const { data } = await supabase
      .from("product_ratings")
      .select("rating")
      .eq("product_id", id)
      .eq("user_id", user_id)
      .maybeSingle();

    sendSuccess(res, { rating: data?.rating ?? null });
  } catch (err) {
    next(err);
  }
}

// ─── Public mobile : top 5 produits les plus vendus par catégorie ─────────────
export async function listBestSellers(req: Request, res: Response, next: NextFunction) {
  try {
    const { category, limit = "5" } = req.query as Record<string, string>;

    // Jointure order_items → products → branches pour compter les ventes
    const { data, error } = await supabase.rpc("get_best_sellers", {
      p_category: category ?? null,
      p_limit: Number(limit),
    });

    if (error) {
      // Fallback si la RPC n'existe pas encore : retourne les produits récents
      let q = supabase
        .from("products")
        .select(`
          id, name, name_fr, name_en, price, original_price, image_url,
          unit, is_hidden,
          branches!inner ( id, name, category, is_active ),
          product_images ( url, is_primary )
        `)
        .eq("is_hidden", false)
        .eq("branches.is_active", true)
        .order("created_at", { ascending: false })
        .limit(Number(limit));

      if (category) q = q.eq("branches.category", category);
      const { data: fallback } = await q;
      return sendSuccess(res, fallback ?? []);
    }

    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}
