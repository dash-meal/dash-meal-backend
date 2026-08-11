import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";

// ─── Lire le panier de l'utilisateur ─────────────────────────────────────────
export async function getCart(req: Request, res: Response, next: NextFunction) {
  try {
    const { data } = await supabase
      .from("carts")
      .select(`
        *,
        cart_items(
          *,
          products(name_fr, name_en, price, product_images(url, is_primary)),
          product_variants(name_fr, name_en, price_modifier)
        )
      `)
      .eq("user_id", req.user!.id)
      .single();

    sendSuccess(res, data ?? { items: [] });
  } catch (err) {
    next(err);
  }
}

// ─── Ajouter un produit au panier ─────────────────────────────────────────────
export async function addToCart(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id, product_id, variant_id, quantity } = req.body as {
      branch_id: string;
      product_id: string;
      variant_id?: string;
      quantity: number;
    };
    const user_id = req.user!.id;

    // Récupérer ou créer le panier pour cette agence
    const { data: existingCart } = await supabase
      .from("carts")
      .select("id")
      .eq("user_id", user_id)
      .eq("branch_id", branch_id)
      .single();

    let cartId: string;

    if (existingCart) {
      cartId = existingCart.id as string;
    } else {
      const { data: newCart, error } = await supabase
        .from("carts")
        .insert({ user_id, branch_id })
        .select("id")
        .single();

      if (error || !newCart) throw new AppError(500, "CART_CREATE_ERROR", "Impossible de créer le panier");
      cartId = newCart.id as string;
    }

    // Si le produit est déjà dans le panier → incrémenter la quantité
    const { data: existing } = await supabase
      .from("cart_items")
      .select("id, quantity")
      .eq("cart_id", cartId)
      .eq("product_id", product_id)
      .eq("variant_id", variant_id ?? null)
      .single();

    if (existing) {
      await supabase
        .from("cart_items")
        .update({ quantity: existing.quantity + quantity })
        .eq("id", existing.id);
    } else {
      await supabase.from("cart_items").insert({
        cart_id: cartId,
        product_id,
        variant_id: variant_id ?? null,
        quantity,
      });
    }

    sendSuccess(res, { cart_id: cartId }, "Produit ajouté au panier");
  } catch (err) {
    next(err);
  }
}

// ─── Modifier la quantité d'un article (0 = supprimer) ───────────────────────
export async function updateCartItem(req: Request, res: Response, next: NextFunction) {
  try {
    const { quantity } = req.body as { quantity: number };

    // Vérifier que l'article appartient bien à l'utilisateur
    const { data: item } = await supabase
      .from("cart_items")
      .select("id, cart_id, carts!inner(user_id)")
      .eq("id", req.params.itemId)
      .single();

    if (!item) throw new AppError(404, "NOT_FOUND", "Article introuvable");
    const cartOwner = (item.carts as unknown as { user_id: string }[])[0];
    if (!cartOwner || cartOwner.user_id !== req.user!.id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    if (quantity === 0) {
      await supabase.from("cart_items").delete().eq("id", req.params.itemId);
      sendSuccess(res, null, "Article supprimé du panier");
    } else {
      await supabase.from("cart_items").update({ quantity }).eq("id", req.params.itemId);
      sendSuccess(res, null, "Quantité mise à jour");
    }
  } catch (err) {
    next(err);
  }
}

// ─── Vider le panier ──────────────────────────────────────────────────────────
export async function clearCart(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id } = req.query as { branch_id?: string };

    let query = supabase.from("carts").select("id").eq("user_id", req.user!.id);
    if (branch_id) query = query.eq("branch_id", branch_id);

    const { data: carts } = await query;

    if (carts && carts.length > 0) {
      const cartIds = carts.map((c) => c.id as string);
      await supabase.from("cart_items").delete().in("cart_id", cartIds);
    }

    sendSuccess(res, null, "Panier vidé");
  } catch (err) {
    next(err);
  }
}

// ─── Supprimer un article spécifique ─────────────────────────────────────────
export async function removeCartItem(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: item } = await supabase
      .from("cart_items")
      .select("id, carts!inner(user_id)")
      .eq("id", req.params.itemId)
      .single();

    if (!item) throw new AppError(404, "NOT_FOUND", "Article introuvable");
    const owner = (item.carts as unknown as { user_id: string }[])[0];
    if (!owner || owner.user_id !== req.user!.id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    await supabase.from("cart_items").delete().eq("id", req.params.itemId);
    sendSuccess(res, null, "Article supprimé");
  } catch (err) {
    next(err);
  }
}
