import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import { generateQrCode, generateQrCodeImage, numericCode } from "../../utils/qrcode.js";
import { campayCollect } from "../../services/campay.js";
import { notifyOrderStatus, notifyDriversNewDelivery } from "../../utils/push.js";
import { sendCollectQrEmail } from "../../utils/email.js";

// ─── Création unifiée avec items + paiement Campay ───────────────────────────
export async function createOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      branch_id, type, items,
      slot_id, delivery_address, delivery_lat, delivery_lng, delivery_phone,
      payment_method, payment_phone, notes,
    } = req.body;

    const user_id = req.user!.id;

    // ── Calculer le total depuis les produits ─────────────────────────────────
    let subtotal = 0;
    const orderItems: Array<{ product_id: string; variant_id: string | null; quantity: number; unit_price: number; subtotal: number }> = [];

    for (const item of items as Array<{ product_id: string; quantity: number; variant_id?: string }>) {
      const { data: product } = await supabase
        .from("products")
        .select("price")
        .eq("id", item.product_id)
        .single();

      if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", `Produit introuvable: ${item.product_id}`);

      const unit_price = product.price;
      const sub = unit_price * item.quantity;
      subtotal += sub;
      orderItems.push({ product_id: item.product_id, variant_id: item.variant_id ?? null, quantity: item.quantity, unit_price, subtotal: sub });
    }

    const delivery_fee = type === "delivery" ? 5 : 0;
    const total = subtotal + delivery_fee;

    // ── Créer la commande ─────────────────────────────────────────────────────
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert({ user_id, branch_id, type, status: "pending", subtotal, delivery_fee, total, notes: notes ?? null })
      .select()
      .single();

    if (orderErr || !order) throw new AppError(500, "CREATE_ORDER_ERROR", "Échec création commande");

    // ── Insérer les articles ──────────────────────────────────────────────────
    await supabase.from("order_items").insert(orderItems.map((i) => ({ ...i, order_id: order.id })));

    // ── Enregistrements type-spécifiques ─────────────────────────────────────
    if (type === "collect" && slot_id) {
      const qr_code = await generateQrCode(order.id);
      await supabase.rpc("increment_slot_booking", { slot_id });
      await supabase.from("collect_orders").insert({ order_id: order.id, slot_id, qr_code, pickup_status: "waiting" });

      // Envoyer l'email QR au client (fire-and-forget)
      void (async () => {
        try {
          const { data: user } = await supabase.from("users").select("name, email").eq("id", user_id).single();
          const { data: slot } = await supabase.from("time_slots").select("date, start_time, end_time, branches(name)").eq("id", slot_id).single();
          if (user?.email && slot) {
            const qrImage = await generateQrCodeImage(qr_code);
            const branch = (slot as any).branches;
            await sendCollectQrEmail({
              to: user.email,
              customerName: user.name ?? "Client",
              orderId: order.id,
              qrToken: qr_code,
              qrImageDataUrl: qrImage,
              numericCode: numericCode(qr_code),
              branchName: branch?.name ?? "Agence",
              slotDate: (slot as any).date,
              slotTime: `${(slot as any).start_time} – ${(slot as any).end_time}`,
              total,
            });
          }
        } catch (e) { console.error("[QR email] erreur:", e); }
      })();
    } else if (type === "delivery") {
      const { data: branch } = await supabase.from("branches").select("brand_id").eq("id", branch_id).single();
      const { error: deliveryErr } = await supabase.from("deliveries").insert({
        order_id: order.id,
        address: delivery_address,
        lat: delivery_lat ?? null,
        lng: delivery_lng ?? null,
        phone: delivery_phone ?? null,
        status: "pending",
        brand_id: branch?.brand_id ?? null,
      });
      if (deliveryErr) console.error("[createOrder] delivery insert failed:", deliveryErr.message);
    }

    // ── Initier le paiement Campay ────────────────────────────────────────────
    let payment_reference: string | null = null;
    let ussd_code: string | null = null;
    let operator: string | null = null;

    try {
      const campayData = await campayCollect({
        amount: total,
        phone: payment_phone,
        description: `DashMeal #${order.id.slice(0, 8)}`,
        externalReference: order.id,
        paymentMethod: payment_method,
      });

      payment_reference = campayData.reference;
      ussd_code = campayData.ussd_code ?? null;
      operator = campayData.operator ?? null;

      await supabase.from("payments").insert({
        order_id: order.id,
        method: payment_method,
        amount: total,
        status: "pending",
        provider_ref: payment_reference,
        provider: "campay",
        operator,
      });
    } catch (campayErr) {
      console.error("Campay initiation failed:", campayErr);
      // Commande créée même si Campay échoue — l'utilisateur peut réessayer
    }

    sendCreated(res, { order_id: order.id, total, payment_reference, ussd_code, operator });
  } catch (err) {
    next(err);
  }
}

export async function createCollectOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id, slot_id, notes, promotion_code } = req.body;
    const user_id = req.user!.id;

    const order = await buildAndCreateOrder(user_id, branch_id, "collect", notes, promotion_code);

    // Réserver le créneau
    await supabase.rpc("increment_slot_booking", { slot_id });

    // Générer QR code
    const qr_code = await generateQrCode(order.id);

    await supabase.from("collect_orders").insert({
      order_id: order.id,
      slot_id,
      qr_code,
      pickup_status: "waiting",
    });

    sendCreated(res, { ...order, qr_code });
  } catch (err) {
    next(err);
  }
}

export async function createDeliveryOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id, delivery_address, delivery_lat, delivery_lng, notes, promotion_code } = req.body;
    const user_id = req.user!.id;

    const order = await buildAndCreateOrder(user_id, branch_id, "delivery", notes, promotion_code);

    const { data: branch } = await supabase.from("branches").select("brand_id").eq("id", branch_id).single();
    const { error: deliveryErr } = await supabase.from("deliveries").insert({
      order_id: order.id,
      address: delivery_address,
      lat: delivery_lat ?? null,
      lng: delivery_lng ?? null,
      status: "pending",
      brand_id: branch?.brand_id ?? null,
    });
    if (deliveryErr) console.error("[createDeliveryOrder] delivery insert failed:", deliveryErr.message);

    sendCreated(res, order);
  } catch (err) {
    next(err);
  }
}

export async function listOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, branch_id, search, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;

    // Resolve allowed branch IDs for brand-scoped admins and branch managers
    let allowedBranchIds: string[] | null = null;
    if (req.user?.role === "branch_manager" && req.user.branch_id) {
      // Branch manager voit uniquement sa propre agence
      allowedBranchIds = [req.user.branch_id];
    } else if (req.user?.role === "admin" && req.user.brand_id) {
      const { data: branches } = await supabase
        .from("branches")
        .select("id")
        .eq("brand_id", req.user.brand_id);
      allowedBranchIds = (branches ?? []).map((b) => b.id);
      if (!allowedBranchIds.length) {
        return res.json({ success: true, data: [], pagination: { page: pageNum, limit: limitNum, total: 0, total_pages: 0 } });
      }
    }

    // If searching, resolve matching order IDs upfront (avoids unreliable nested filters)
    let searchFilterIds: string[] | null = null;
    if (search) {
      const trimmed = search.trim().replace(/^#/, "");
      const isIdSearch = /^[0-9a-f-]{4,36}$/i.test(trimmed);

      if (isIdSearch) {
        const { data: matched } = await supabase
          .from("orders")
          .select("id")
          .ilike("id", `${trimmed}%`)
          .limit(50);
        searchFilterIds = (matched ?? []).map((o) => o.id);
      } else {
        // Search by customer name — resolve user IDs first
        const { data: users } = await supabase
          .from("users")
          .select("id")
          .ilike("name", `%${trimmed}%`)
          .limit(100);
        const userIds = (users ?? []).map((u) => u.id);
        if (!userIds.length) {
          return res.json({ success: true, data: [], pagination: { page: pageNum, limit: limitNum, total: 0, total_pages: 0 } });
        }
        const { data: matched } = await supabase
          .from("orders")
          .select("id")
          .in("user_id", userIds)
          .limit(200);
        searchFilterIds = (matched ?? []).map((o) => o.id);
      }

      if (searchFilterIds !== null && !searchFilterIds.length) {
        return res.json({ success: true, data: [], pagination: { page: pageNum, limit: limitNum, total: 0, total_pages: 0 } });
      }
    }

    let query = supabase
      .from("orders")
      .select("*, users(name, phone), branches(name), order_items(*, products(name_fr))", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (allowedBranchIds) query = query.in("branch_id", allowedBranchIds);
    if (status) query = query.eq("status", status);
    if (branch_id) query = query.eq("branch_id", branch_id);
    if (searchFilterIds !== null) query = query.in("id", searchFilterIds);

    const { data, count, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    res.json({
      success: true,
      data: data ?? [],
      pagination: { page: pageNum, limit: limitNum, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limitNum) },
    });
  } catch (err) {
    next(err);
  }
}

export async function getOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*, order_items(*, products(name_fr, name_en, product_images(url, is_primary))), users(name, phone), branches(name, address)")
      .eq("id", req.params.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Commande introuvable");

    // Vérifier que l'utilisateur a accès à cette commande
    if (req.user?.role === "user" && data.user_id !== req.user.id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function getUserOrders(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*, branches(name, brands(name, logo_url)), order_items(quantity, unit_price, products(name_fr))")
      .eq("user_id", req.user!.id)
      .order("created_at", { ascending: false });

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function updateOrderStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, note } = req.body;
    const orderId = req.params.id as string;

    const { data: order } = await supabase
      .from("orders")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .select("id, user_id, type, branch_id")
      .single();

    await supabase.from("order_status_history").insert({
      order_id: orderId,
      status,
      changed_by: req.user!.id,
      changed_by_role: req.user!.role,
      note: note ?? null,
    });

    // Notification push vers l'utilisateur
    if (order?.user_id) {
      notifyOrderStatus(order.user_id, orderId, status, orderId).catch(() => {});
    }

    // Quand la commande est prête → rendre la livraison visible aux livreurs
    if (status === "ready" && order?.type === "delivery") {
      const { data: delivery } = await supabase
        .from("deliveries")
        .update({ status: "assigned" })
        .eq("order_id", orderId)
        .select("id, address, brand_id")
        .single();

      if (delivery?.brand_id) {
        notifyDriversNewDelivery(delivery.brand_id, delivery.id, delivery.address).catch(() => {});
      } else if (delivery && order.branch_id) {
        // fallback: look up brand_id from branch
        const { data: branch } = await supabase
          .from("branches")
          .select("brand_id")
          .eq("id", order.branch_id)
          .single();
        if (branch?.brand_id) {
          notifyDriversNewDelivery(branch.brand_id, delivery.id, delivery.address).catch(() => {});
        }
      }
    }

    sendSuccess(res, { status }, "Statut mis à jour");
  } catch (err) {
    next(err);
  }
}

export async function getOrderHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("order_status_history")
      .select("*")
      .eq("order_id", req.params.id)
      .order("changed_at", { ascending: true });

    if (error) throw new AppError(500, "DB_ERROR", error.message);
    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

export async function assignDriver(req: Request, res: Response, next: NextFunction) {
  try {
    await supabase
      .from("deliveries")
      .update({ driver_id: req.body.driver_id, status: "assigned" })
      .eq("order_id", req.params.id);

    sendSuccess(res, null, "Livreur assigné");
  } catch (err) {
    next(err);
  }
}

export async function cancelOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: order } = await supabase
      .from("orders")
      .select("status, user_id")
      .eq("id", req.params.id)
      .single();

    if (!order) throw new AppError(404, "NOT_FOUND", "Commande introuvable");

    if (req.user?.role === "user" && order.user_id !== req.user.id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    if (!["pending", "confirmed"].includes(order.status)) {
      throw new AppError(400, "CANNOT_CANCEL", "Cette commande ne peut plus être annulée");
    }

    await supabase
      .from("orders")
      .update({ status: "cancelled" })
      .eq("id", req.params.id);

    sendSuccess(res, null, "Commande annulée");
  } catch (err) {
    next(err);
  }
}

export async function convertToDelivery(req: Request, res: Response, next: NextFunction) {
  try {
    const orderId = req.params.id as string;
    const { delivery_address, delivery_lat, delivery_lng, payment_phone } = req.body;
    const user_id = req.user!.id;

    // ── Vérifications ─────────────────────────────────────────────────────────
    const { data: order } = await supabase
      .from("orders")
      .select("id, user_id, type, status, subtotal")
      .eq("id", orderId)
      .single();

    if (!order) throw new AppError(404, "NOT_FOUND", "Commande introuvable");
    if (order.user_id !== user_id) throw new AppError(403, "FORBIDDEN", "Accès refusé");
    if (order.type !== "collect") throw new AppError(400, "INVALID_TYPE", "Cette commande n'est pas un click & collect");
    if (!["pending", "confirmed"].includes(order.status)) {
      throw new AppError(400, "CANNOT_CONVERT", "Cette commande est déjà en préparation ou livrée — conversion impossible");
    }

    const delivery_fee = 5;

    // ── Libérer le créneau collect ────────────────────────────────────────────
    const { data: collectOrder } = await supabase
      .from("collect_orders")
      .select("id, slot_id")
      .eq("order_id", orderId)
      .single();

    if (collectOrder?.slot_id) {
      // Décrémenter le compteur (RPC optionnelle — la conversion continue si elle n'existe pas)
      try {
        await supabase.rpc("decrement_slot_booking", { slot_id: collectOrder.slot_id });
      } catch { /* ignoré */ }
    }
    await supabase.from("collect_orders").delete().eq("order_id", orderId);

    // ── Mettre à jour la commande → livraison ────────────────────────────────
    await supabase
      .from("orders")
      .update({ type: "delivery", delivery_fee, total: Number(order.subtotal) + delivery_fee })
      .eq("id", orderId);

    // ── Créer le dossier de livraison ─────────────────────────────────────────
    await supabase.from("deliveries").insert({
      order_id: orderId,
      address: delivery_address,
      lat: delivery_lat ?? null,
      lng: delivery_lng ?? null,
      status: "pending",
    });

    // ── Créer un enregistrement de paiement (pending) ─────────────────────────
    const { data: payment, error: paymentErr } = await supabase
      .from("payments")
      .insert({
        order_id: orderId,
        method: "mobile_money",
        amount: delivery_fee,
        status: "pending",
        provider: "campay",
        provider_ref: null,
      })
      .select()
      .single();

    if (paymentErr || !payment) throw new AppError(500, "PAYMENT_ERROR", "Erreur lors de la création du paiement");

    // ── Initier le paiement Campay pour les frais de livraison ───────────────
    let campayData;
    try {
      campayData = await campayCollect({
        amount: delivery_fee,
        phone: payment_phone,
        description: `DashMeal livraison #${orderId.slice(0, 8)}`,
        externalReference: orderId,
      });
    } catch (campayErr) {
      await supabase.from("payments").delete().eq("id", payment.id);
      throw campayErr;
    }

    await supabase
      .from("payments")
      .update({ provider_ref: campayData.reference, operator: campayData.operator ?? null })
      .eq("id", payment.id);

    sendSuccess(res, {
      reference: campayData.reference,
      ussd_code: campayData.ussd_code ?? null,
      operator: campayData.operator ?? null,
      delivery_fee,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Helper privé ─────────────────────────────────────────────────────────────

async function buildAndCreateOrder(
  user_id: string,
  branch_id: string,
  type: "collect" | "delivery",
  notes?: string,
  promotion_code?: string
) {
  const { data: cart } = await supabase
    .from("carts")
    .select("id, cart_items(product_id, variant_id, quantity, products(price), product_variants(price_modifier))")
    .eq("user_id", user_id)
    .eq("branch_id", branch_id)
    .single();

  if (!cart || !cart.cart_items?.length) {
    throw new AppError(400, "EMPTY_CART", "Le panier est vide");
  }

  // Calculer le total
  let subtotal = 0;
  const items: Array<{ product_id: string; variant_id: string | null; quantity: number; unit_price: number; subtotal: number }> = [];

  for (const item of cart.cart_items as Array<Record<string, unknown>>) {
    const basePrice = (item.products as Record<string, number>).price;
    const modifier = (item.product_variants as Record<string, number> | null)?.price_modifier ?? 0;
    const unit_price = basePrice + modifier;
    const sub = unit_price * (item.quantity as number);
    subtotal += sub;
    items.push({
      product_id: item.product_id as string,
      variant_id: (item.variant_id as string | null),
      quantity: item.quantity as number,
      unit_price,
      subtotal: sub,
    });
  }

  // Appliquer promotion si fournie
  // TODO: valider promotion_code

  const { data: order, error } = await supabase
    .from("orders")
    .insert({
      user_id,
      branch_id,
      type,
      status: "pending",
      subtotal,
      delivery_fee: type === "delivery" ? 5 : 0,
      total: subtotal + (type === "delivery" ? 5 : 0),
      notes: notes ?? null,
    })
    .select()
    .single();

  if (error || !order) throw new AppError(500, "CREATE_ORDER_ERROR", "Échec création commande");

  // Insérer les lignes
  await supabase.from("order_items").insert(
    items.map((item) => ({ ...item, order_id: order.id }))
  );

  // Vider le panier
  await supabase.from("cart_items").delete().eq("cart_id", cart.id);

  return order;
}

// ─── Notation d'une commande / agence ─────────────────────────────────────────

export async function rateOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const orderId = req.params.id as string;
    const { rating, comment } = req.body as { rating: number; comment?: string };

    // Vérifier que la commande appartient à l'utilisateur et est livrée/retirée
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, user_id, status, rated_at")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) throw new AppError(404, "NOT_FOUND", "Commande introuvable");
    if (order.user_id !== req.user!.id) throw new AppError(403, "FORBIDDEN", "Accès refusé");
    if (!["delivered", "ready"].includes(order.status))
      throw new AppError(400, "INVALID_STATUS", "Seules les commandes livrées ou prêtes peuvent être notées");
    if (order.rated_at) throw new AppError(409, "ALREADY_RATED", "Cette commande a déjà été notée");

    const { data, error } = await supabase
      .from("orders")
      .update({ rating, rating_comment: comment ?? null, rated_at: new Date().toISOString() })
      .eq("id", orderId)
      .select("id, rating, rating_comment, rated_at")
      .single();

    if (error || !data) throw new AppError(500, "UPDATE_ERROR", "Impossible d'enregistrer la note");
    sendSuccess(res, data, "Merci pour votre avis !");
  } catch (err) {
    next(err);
  }
}
