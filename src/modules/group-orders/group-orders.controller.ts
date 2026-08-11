import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import { randomBytes } from "node:crypto";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateShareCode(): string {
  return randomBytes(4).toString("hex").toUpperCase(); // ex: "A3F9C2B1"
}

const CART_TTL_MINUTES = 60; // Le panier de groupe expire après 1h

function cartExpiresAt(): string {
  return new Date(Date.now() + CART_TTL_MINUTES * 60 * 1000).toISOString();
}

// ─── Créer un panier de groupe ────────────────────────────────────────────────

export async function createGroupCart(req: Request, res: Response, next: NextFunction) {
  try {
    const hostId = req.user!.id;
    const { branch_id } = req.body as { branch_id: string };

    if (!branch_id) throw new AppError(400, "MISSING_BRANCH_ID", "branch_id requis");

    // Vérifier que l'agence existe
    const { data: branch } = await supabase
      .from("branches")
      .select("id, name")
      .eq("id", branch_id)
      .single();

    if (!branch) throw new AppError(404, "BRANCH_NOT_FOUND", "Agence introuvable");

    const shareCode = generateShareCode();

    const { data, error } = await supabase
      .from("group_carts")
      .insert({
        host_id: hostId,
        branch_id,
        share_code: shareCode,
        status: "open",
        expires_at: cartExpiresAt(),
      })
      .select()
      .single();

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    // Ajouter l'hôte comme participant
    await supabase.from("group_cart_members").insert({
      group_cart_id: data.id,
      user_id: hostId,
      is_host: true,
    });

    sendCreated(res, { ...data, branch_name: branch.name }, "Panier de groupe créé");
  } catch (err) {
    next(err);
  }
}

// ─── Rejoindre un panier de groupe ────────────────────────────────────────────

export async function joinGroupCart(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { share_code } = req.body as { share_code: string };

    if (!share_code) throw new AppError(400, "MISSING_SHARE_CODE", "share_code requis");

    const now = new Date().toISOString();

    const { data: cart, error: cartErr } = await supabase
      .from("group_carts")
      .select("*, branches(name)")
      .eq("share_code", share_code.toUpperCase())
      .eq("status", "open")
      .gt("expires_at", now)
      .maybeSingle();

    if (cartErr) throw new AppError(500, "DB_ERROR", cartErr.message);
    if (!cart) throw new AppError(404, "CART_NOT_FOUND", "Panier introuvable, expiré ou fermé");

    // Vérifier si déjà membre
    const { data: existingMember } = await supabase
      .from("group_cart_members")
      .select("id")
      .eq("group_cart_id", cart.id)
      .eq("user_id", userId)
      .maybeSingle();

    if (!existingMember) {
      await supabase.from("group_cart_members").insert({
        group_cart_id: cart.id,
        user_id: userId,
        is_host: false,
      });
    }

    const branches = cart.branches as Record<string, unknown> | null;
    sendSuccess(res, {
      id: cart.id,
      branch_id: cart.branch_id,
      branch_name: branches?.name ?? null,
      share_code: cart.share_code,
      status: cart.status,
      expires_at: cart.expires_at,
      host_id: cart.host_id,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Récupérer un panier de groupe ────────────────────────────────────────────

export async function getGroupCart(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Vérifier que l'utilisateur est membre
    const { data: membership } = await supabase
      .from("group_cart_members")
      .select("id")
      .eq("group_cart_id", id)
      .eq("user_id", userId)
      .maybeSingle();

    if (!membership) throw new AppError(403, "FORBIDDEN", "Vous n'êtes pas membre de ce panier");

    const { data: cart, error: cartErr } = await supabase
      .from("group_carts")
      .select("*, branches(name, address)")
      .eq("id", id)
      .single();

    if (cartErr) throw new AppError(cartErr.code === "PGRST116" ? 404 : 500, cartErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", cartErr.code === "PGRST116" ? "Panier introuvable" : cartErr.message);
    if (!cart) throw new AppError(404, "NOT_FOUND", "Panier introuvable");

    // Récupérer les items groupés par utilisateur
    const { data: items, error: itemsErr } = await supabase
      .from("group_cart_items")
      .select(`
        id,
        user_id,
        product_id,
        quantity,
        added_at,
        products(name_fr, name_en, price, image_url),
        users(name)
      `)
      .eq("group_cart_id", id)
      .order("added_at", { ascending: true });

    if (itemsErr) throw new AppError(500, "DB_ERROR", itemsErr.message);

    // Grouper par user_id
    const byUser = new Map<string, { user_name: string; items: typeof items }>();
    for (const item of items ?? []) {
      const users = (item.users as unknown) as Record<string, unknown> | null;
      const userName = (users?.name as string) ?? item.user_id;
      const group = byUser.get(item.user_id) ?? { user_name: userName, items: [] };
      group.items.push(item);
      byUser.set(item.user_id, group);
    }

    const itemsByUser = [...byUser.entries()].map(([uid, group]) => ({
      user_id: uid,
      user_name: group.user_name,
      items: group.items,
    }));

    // Calculer total
    const total = (items ?? []).reduce((sum, item) => {
      const products = (item.products as unknown) as Record<string, unknown> | null;
      return sum + Number(products?.price ?? 0) * Number(item.quantity);
    }, 0);

    sendSuccess(res, { ...cart, items_by_user: itemsByUser, total });
  } catch (err) {
    next(err);
  }
}

// ─── Ajouter un article ────────────────────────────────────────────────────────

export async function addItem(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { product_id, quantity } = req.body as { product_id: string; quantity: number };

    if (!product_id || !quantity || quantity <= 0) {
      throw new AppError(400, "INVALID_INPUT", "product_id et quantity (> 0) requis");
    }

    // Vérifier que le panier est ouvert et que l'utilisateur est membre
    const { data: cart, error: cartErr } = await supabase
      .from("group_carts")
      .select("id, status, expires_at, branch_id")
      .eq("id", id)
      .single();

    if (cartErr) throw new AppError(cartErr.code === "PGRST116" ? 404 : 500, cartErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", cartErr.code === "PGRST116" ? "Panier introuvable" : cartErr.message);
    if (!cart) throw new AppError(404, "NOT_FOUND", "Panier introuvable");

    if (cart.status !== "open") throw new AppError(422, "CART_CLOSED", "Ce panier est fermé ou verrouillé");

    if (new Date(cart.expires_at) < new Date()) {
      throw new AppError(422, "CART_EXPIRED", "Ce panier a expiré");
    }

    const { data: membership } = await supabase
      .from("group_cart_members")
      .select("id")
      .eq("group_cart_id", id)
      .eq("user_id", userId)
      .maybeSingle();

    if (!membership) throw new AppError(403, "FORBIDDEN", "Vous n'êtes pas membre de ce panier");

    // Vérifier que le produit appartient à la bonne agence
    const { data: product, error: productErr } = await supabase
      .from("products")
      .select("id, price, branches(id)")
      .eq("id", product_id)
      .maybeSingle();

    if (productErr) throw new AppError(500, "DB_ERROR", productErr.message);
    if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", "Produit introuvable");

    const { data: item, error: insertErr } = await supabase
      .from("group_cart_items")
      .insert({
        group_cart_id: id,
        user_id: userId,
        product_id,
        quantity: Number(quantity),
        added_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertErr) throw new AppError(500, "DB_ERROR", insertErr.message);

    sendCreated(res, item, "Article ajouté au panier de groupe");
  } catch (err) {
    next(err);
  }
}

// ─── Supprimer un article ──────────────────────────────────────────────────────

export async function removeItem(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { id, product_id } = req.params;

    // L'utilisateur ne peut supprimer que ses propres articles
    const { error } = await supabase
      .from("group_cart_items")
      .delete()
      .eq("group_cart_id", id)
      .eq("product_id", product_id)
      .eq("user_id", userId);

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, null, "Article retiré du panier");
  } catch (err) {
    next(err);
  }
}

// ─── Verrouiller le panier ─────────────────────────────────────────────────────

export async function lockCart(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Seul l'hôte peut verrouiller
    const { data: cart, error: cartErr } = await supabase
      .from("group_carts")
      .select("id, host_id, status")
      .eq("id", id)
      .single();

    if (cartErr) throw new AppError(cartErr.code === "PGRST116" ? 404 : 500, cartErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", cartErr.code === "PGRST116" ? "Panier introuvable" : cartErr.message);
    if (!cart) throw new AppError(404, "NOT_FOUND", "Panier introuvable");

    if (cart.host_id !== userId) throw new AppError(403, "FORBIDDEN", "Seul l'hôte peut verrouiller le panier");
    if (cart.status !== "open") throw new AppError(422, "CART_NOT_OPEN", "Le panier n'est pas ouvert");

    const { data, error } = await supabase
      .from("group_carts")
      .update({ status: "locked", updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, data, "Panier verrouillé");
  } catch (err) {
    next(err);
  }
}

// ─── Passer la commande de groupe ─────────────────────────────────────────────

export async function placeGroupOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Seul l'hôte peut commander
    const { data: cart, error: cartErr } = await supabase
      .from("group_carts")
      .select("*, branches(brand_id)")
      .eq("id", id)
      .single();

    if (cartErr) throw new AppError(cartErr.code === "PGRST116" ? 404 : 500, cartErr.code === "PGRST116" ? "NOT_FOUND" : "DB_ERROR", cartErr.code === "PGRST116" ? "Panier introuvable" : cartErr.message);
    if (!cart) throw new AppError(404, "NOT_FOUND", "Panier introuvable");

    if (cart.host_id !== userId) throw new AppError(403, "FORBIDDEN", "Seul l'hôte peut passer la commande");
    if (!["open", "locked"].includes(cart.status)) {
      throw new AppError(422, "CART_INVALID_STATUS", "Le panier ne peut pas être commandé dans cet état");
    }

    // Récupérer tous les articles
    const { data: items, error: itemsErr } = await supabase
      .from("group_cart_items")
      .select("product_id, quantity, products(price)")
      .eq("group_cart_id", id);

    if (itemsErr) throw new AppError(500, "DB_ERROR", itemsErr.message);
    if (!items || items.length === 0) throw new AppError(400, "EMPTY_CART", "Le panier de groupe est vide");

    // Calculer le total
    let subtotal = 0;
    const orderItems: Array<{ product_id: string; quantity: number; unit_price: number; subtotal: number; variant_id: null }> = [];

    for (const item of items) {
      const products = (item.products as unknown) as Record<string, unknown> | null;
      const unit_price = Number(products?.price ?? 0);
      const sub = unit_price * Number(item.quantity);
      subtotal += sub;
      orderItems.push({
        product_id: item.product_id,
        quantity: Number(item.quantity),
        unit_price,
        subtotal: sub,
        variant_id: null,
      });
    }

    const branches = cart.branches as Record<string, unknown> | null;

    // Créer la commande
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert({
        user_id: userId,
        branch_id: cart.branch_id,
        type: "dine_in",
        status: "pending",
        subtotal,
        delivery_fee: 0,
        total: subtotal,
        notes: `Commande de groupe — panier ${cart.share_code}`,
      })
      .select()
      .single();

    if (orderErr || !order) throw new AppError(500, "CREATE_ORDER_ERROR", "Échec de la création de la commande");

    // Insérer les articles
    await supabase
      .from("order_items")
      .insert(orderItems.map((item) => ({ ...item, order_id: order.id })));

    // Marquer le panier comme commandé
    await supabase
      .from("group_carts")
      .update({ status: "ordered", order_id: order.id, updated_at: new Date().toISOString() })
      .eq("id", id);

    sendCreated(res, { order_id: order.id, total: subtotal }, "Commande de groupe passée");
  } catch (err) {
    next(err);
  }
}
