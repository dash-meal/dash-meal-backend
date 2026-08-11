import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import { notifyUser, notifyOrderStatus } from "../../utils/push.js";
import { creditDriverEarning } from "../driver-wallet/driver-wallet.controller.js";

export async function getDriverProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("drivers")
      .select("id, name, phone, branch_id, brand_id, is_active, photo_url, created_at, branches(name, address)")
      .eq("id", req.user!.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Livreur introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Livraisons disponibles (pas encore acceptées) ───────────────────────────

export async function getAvailableDeliveries(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.brand_id;
    if (!brand_id) throw new AppError(403, "NO_BRAND", "Livreur non associé à une marque");

    // ── 1. Branch IDs for this brand ──────────────────────────────────────────
    const { data: branches, error: e1 } = await supabase
      .from("branches")
      .select("id, name, address")
      .eq("brand_id", brand_id);
    if (e1) throw new AppError(500, "FETCH_ERROR", e1.message);
    const branchIds = (branches ?? []).map((b) => b.id);
    if (!branchIds.length) return sendSuccess(res, []);
    const branchById = Object.fromEntries((branches ?? []).map((b) => [b.id, b]));

    // ── 2. Unassigned deliveries — no joins (direct column filters only) ───────
    const { data: deliveries, error: e2 } = await supabase
      .from("deliveries")
      .select("id, address, lat, lng, created_at, status, order_id")
      .is("driver_id", null)
      .eq("status", "assigned")
      .order("created_at", { ascending: false })
      .limit(200);
    if (e2) throw new AppError(500, "FETCH_ERROR", e2.message);
    if (!deliveries?.length) return sendSuccess(res, []);

    // ── 3. Orders for those deliveries, filtered to our branch IDs ─────────────
    const orderIds = deliveries.map((d) => d.order_id);
    const { data: orders, error: e3 } = await supabase
      .from("orders")
      .select("id, total, branch_id, users(name, phone)")
      .in("id", orderIds)
      .in("branch_id", branchIds);
    if (e3) throw new AppError(500, "FETCH_ERROR", e3.message);
    const orderMap = Object.fromEntries((orders ?? []).map((o) => [o.id, o]));

    // ── 4. Join in JS, attach branch info ──────────────────────────────────────
    const result = deliveries
      .filter((d) => orderMap[d.order_id])
      .map((d) => {
        const order = orderMap[d.order_id] as any;
        return {
          id: d.id,
          address: d.address,
          lat: d.lat,
          lng: d.lng,
          created_at: d.created_at,
          status: d.status,
          orders: {
            id: order.id,
            total: order.total,
            users: order.users,
            branches: branchById[order.branch_id] ?? null,
          },
        };
      });

    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

// ─── Accepter une livraison ──────────────────────────────────────────────────

export async function acceptDelivery(req: Request, res: Response, next: NextFunction) {
  try {
    const driverId = req.user!.id;
    const deliveryId = req.params.id;

    // Atomic accept: only succeeds if driver_id is still null
    const { data: delivery, error } = await supabase
      .from("deliveries")
      .update({ driver_id: driverId })
      .eq("id", deliveryId)
      .eq("status", "assigned")
      .is("driver_id", null)
      .select("id, order_id, address")
      .single();

    if (error || !delivery) {
      throw new AppError(409, "ALREADY_TAKEN", "Cette livraison a déjà été acceptée par un autre livreur");
    }

    // Auto-create client_driver conversation
    let conversationId: string | null = null;
    const { data: existingConv } = await supabase
      .from("conversations")
      .select("id")
      .eq("order_id", delivery.order_id)
      .eq("type", "client_driver")
      .maybeSingle();

    if (existingConv) {
      conversationId = existingConv.id;
    } else {
      const { data: newConv } = await supabase
        .from("conversations")
        .insert({ order_id: delivery.order_id, type: "client_driver" })
        .select("id")
        .single();
      conversationId = newConv?.id ?? null;
    }

    // Notify user
    const { data: order } = await supabase
      .from("orders")
      .select("user_id")
      .eq("id", delivery.order_id)
      .single();

    if (order?.user_id) {
      notifyUser(
        order.user_id,
        "Un livreur est en route 🛵",
        "Votre commande a été acceptée. Le livreur se rend à l'agence pour la récupérer.",
        { screen: "order", orderId: delivery.order_id, type: "driver_accepted" }
      ).catch(() => {});
    }

    sendSuccess(res, { delivery_id: deliveryId, conversation_id: conversationId }, "Livraison acceptée");
  } catch (err) {
    next(err);
  }
}

// ─── Mes livraisons assignées ─────────────────────────────────────────────────

export async function getMyDeliveries(req: Request, res: Response, next: NextFunction) {
  try {
    const { status } = req.query as Record<string, string>;

    let query = supabase
      .from("deliveries")
      .select(`
        id, status, address, created_at,
        orders(id, total, status, notes, users(name, phone)),
        driver_positions(lat, lng, updated_at)
      `)
      .eq("driver_id", req.user!.id)
      .order("created_at", { ascending: false });

    if (status) {
      if (status.includes(",")) {
        query = query.in("status", status.split(",") as any);
      } else {
        query = query.eq("status", status);
      }
    }

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

export async function getDeliveryDetail(req: Request, res: Response, next: NextFunction) {
  try {
    // Step 1: delivery (no joins)
    const { data: delivery, error: e1 } = await supabase
      .from("deliveries")
      .select("id, status, address, lat, lng, driver_id, created_at, order_id")
      .eq("id", req.params.id)
      .eq("driver_id", req.user!.id)
      .single();
    if (e1 || !delivery) throw new AppError(404, "NOT_FOUND", "Livraison introuvable");

    // Step 2: order details
    const { data: order, error: e2 } = await supabase
      .from("orders")
      .select("id, total, status, notes, user_id, users(name, phone), order_items(quantity, unit_price, products(name_fr, name_en))")
      .eq("id", delivery.order_id)
      .single();
    if (e2 || !order) throw new AppError(404, "NOT_FOUND", "Livraison introuvable");

    // Step 3: branch
    const { data: branch } = await supabase
      .from("branches")
      .select("name, address, lat, lng, phone")
      .eq("id", (order as any).branch_id)
      .single();

    // Step 4: conversation
    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("order_id", order.id)
      .eq("type", "client_driver")
      .maybeSingle();

    sendSuccess(res, {
      ...delivery,
      conversation_id: conv?.id ?? null,
      orders: { ...(order as any), branches: branch ?? null },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Détail livraison disponible (avant acceptation) ─────────────────────────

export async function getAvailableDeliveryDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.brand_id;

    // Step 1: delivery (no joins)
    const { data: delivery, error: e1 } = await supabase
      .from("deliveries")
      .select("id, status, address, lat, lng, driver_id, created_at, order_id")
      .eq("id", req.params.id)
      .is("driver_id", null)
      .single();
    if (e1 || !delivery) throw new AppError(404, "NOT_FOUND", "Livraison introuvable");

    // Step 2: order + branch + users + items
    const { data: order, error: e2 } = await supabase
      .from("orders")
      .select("id, total, notes, branch_id, users(name, phone), order_items(quantity, unit_price, products(name_fr))")
      .eq("id", delivery.order_id)
      .single();
    if (e2 || !order) throw new AppError(404, "NOT_FOUND", "Livraison introuvable");

    // Step 3: branch — verify brand ownership
    const { data: branch, error: e3 } = await supabase
      .from("branches")
      .select("id, name, address, lat, lng, phone, brand_id")
      .eq("id", (order as any).branch_id)
      .single();
    if (e3 || !branch) throw new AppError(404, "NOT_FOUND", "Livraison introuvable");
    if (branch.brand_id !== brand_id) throw new AppError(404, "NOT_FOUND", "Livraison introuvable");

    sendSuccess(res, {
      ...delivery,
      orders: {
        ...(order as any),
        branches: branch,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── Mettre à jour le statut de livraison ────────────────────────────────────

export async function updateDeliveryStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, note } = req.body;

    const { data: delivery } = await supabase
      .from("deliveries")
      .select("id, order_id, driver_id, status")
      .eq("id", req.params.id)
      .single();

    if (!delivery) throw new AppError(404, "NOT_FOUND", "Livraison introuvable");

    if (req.user?.role === "driver" && delivery.driver_id !== req.user.id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    const updates: Record<string, unknown> = { status };
    if (status === "picked_up") updates.started_at = new Date().toISOString();
    if (status === "delivered") updates.delivered_at = new Date().toISOString();

    await supabase.from("deliveries").update(updates).eq("id", req.params.id);

    const orderStatus = status === "delivered" ? "delivered"
      : status === "on_the_way" ? "delivering"
      : status === "failed" ? "cancelled"
      : undefined;

    if (orderStatus) {
      const { data: order } = await supabase
        .from("orders")
        .update({ status: orderStatus })
        .eq("id", delivery.order_id)
        .select("user_id, delivery_fee, branch_id")
        .single();

      await supabase.from("order_status_history").insert({
        order_id:        delivery.order_id,
        status:          orderStatus,
        changed_by:      req.user!.id,
        changed_by_role: req.user!.role,
        note:            note ?? null,
      });

      if (order?.user_id) {
        notifyOrderStatus(order.user_id, delivery.order_id, orderStatus, delivery.order_id).catch(() => {});
      }

      // Répartir les frais de livraison (70% livreur, 20% admin, 10% superadmin)
      if (orderStatus === "delivered" && delivery.driver_id && order?.delivery_fee) {
        const { data: branch } = await supabase
          .from("branches").select("brand_id").eq("id", order.branch_id).single();
        if (branch?.brand_id) {
          creditDriverEarning(delivery.driver_id, branch.brand_id, delivery.order_id, Number(order.delivery_fee)).catch(console.error);
        }
      }
    }

    // Mettre à jour les stats du livreur
    if (status === "delivered" && delivery.driver_id) {
      await supabase.from("drivers")
        .update({ total_deliveries: supabase.rpc as any }) // handled via raw increment below
        .eq("id", delivery.driver_id);
      // Incrément simple
      const { data: drv } = await supabase.from("drivers").select("total_deliveries").eq("id", delivery.driver_id).single();
      await supabase.from("drivers").update({ total_deliveries: (drv?.total_deliveries ?? 0) + 1 }).eq("id", delivery.driver_id);
    }

    // Mettre à jour la position du livreur dans drivers
    const { lat, lng } = req.body as { lat?: number; lng?: number };
    if (delivery.driver_id && lat != null && lng != null) {
      await supabase.from("drivers").update({ latitude: lat, longitude: lng, location_updated_at: new Date().toISOString() }).eq("id", delivery.driver_id);
    }

    sendSuccess(res, { status }, "Statut de livraison mis à jour");
  } catch (err) {
    next(err);
  }
}

// ─── Position GPS en temps réel ──────────────────────────────────────────────

export async function updateDriverPosition(req: Request, res: Response, next: NextFunction) {
  try {
    const { lat, lng } = req.body;

    await Promise.all([
      supabase.from("driver_positions").upsert({
        delivery_id: req.params.id,
        driver_id:   req.user!.id,
        lat, lng,
        updated_at:  new Date().toISOString(),
      }),
      // Aussi persister sur la table drivers pour le dispatch géolocalisé
      supabase.from("drivers").update({
        latitude: lat, longitude: lng,
        location_updated_at: new Date().toISOString(),
      }).eq("id", req.user!.id),
    ]);

    sendSuccess(res, { lat, lng }, "Position mise à jour");
  } catch (err) {
    next(err);
  }
}

// ─── Suivi livraison (utilisateur) ───────────────────────────────────────────

export async function trackDelivery(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: order } = await supabase
      .from("orders")
      .select("id, user_id, status")
      .eq("id", req.params.orderId)
      .single();

    if (!order || order.user_id !== req.user!.id) {
      throw new AppError(404, "NOT_FOUND", "Commande introuvable");
    }

    const { data, error } = await supabase
      .from("deliveries")
      .select(`
        id, status, address, lat, lng, started_at, delivered_at,
        drivers(name, phone),
        driver_positions(lat, lng, updated_at)
      `)
      .eq("order_id", req.params.orderId)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Livraison introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Vue admin : toutes les livraisons ───────────────────────────────────────

export async function listDeliveries(req: Request, res: Response, next: NextFunction) {
  try {
    const { status, driver_id, branch_id, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;

    // Resolve allowed branch IDs for brand-scoped admins (avoids unreliable nested PostgREST filters)
    let allowedBranchIds: string[] | null = null;
    if (req.user?.role === "admin" && req.user.brand_id) {
      const { data: branches } = await supabase
        .from("branches")
        .select("id")
        .eq("brand_id", req.user.brand_id);
      allowedBranchIds = (branches ?? []).map((b) => b.id);
      if (!allowedBranchIds.length) {
        return res.json({ success: true, data: [], pagination: { page: pageNum, limit: limitNum, total: 0, total_pages: 0 } });
      }
    }

    // Step 1: get delivery IDs filtered by branch (if needed)
    let deliveryIds: string[] | null = null;
    const effectiveBranchId = branch_id ?? null;
    if (allowedBranchIds || effectiveBranchId) {
      const orderQuery = supabase.from("orders").select("id");
      if (allowedBranchIds) {
        orderQuery.in("branch_id", allowedBranchIds);
      }
      if (effectiveBranchId) {
        orderQuery.eq("branch_id", effectiveBranchId);
      }
      const { data: orders } = await orderQuery;
      const orderIds = (orders ?? []).map((o) => o.id);
      if (!orderIds.length) {
        return res.json({ success: true, data: [], pagination: { page: pageNum, limit: limitNum, total: 0, total_pages: 0 } });
      }

      const { data: delivs } = await supabase.from("deliveries").select("id").in("order_id", orderIds);
      deliveryIds = (delivs ?? []).map((d) => d.id);
      if (!deliveryIds.length) {
        return res.json({ success: true, data: [], pagination: { page: pageNum, limit: limitNum, total: 0, total_pages: 0 } });
      }
    }

    // Step 2: main query — filter on direct columns only
    let query = supabase
      .from("deliveries")
      .select(`
        *,
        orders(id, total, status, created_at, branch_id, users(name, phone)),
        drivers(name, phone)
      `, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (deliveryIds) query = query.in("id", deliveryIds);
    if (status) query = query.eq("status", status);
    if (driver_id) query = query.eq("driver_id", driver_id);

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

// ─── Activer son compte livreur ──────────────────────────────────────────────

export async function activateDriverAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("drivers")
      .update({ is_active: true })
      .eq("id", req.user!.id)
      .select("id, is_active")
      .single();

    if (error || !data) throw new AppError(500, "ACTIVATE_ERROR", "Impossible d'activer le compte");
    sendSuccess(res, data, "Compte activé avec succès");
  } catch (err) {
    next(err);
  }
}

// ─── Enregistrer le push token du livreur ────────────────────────────────────

export async function registerDriverPushToken(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = req.body as { token?: string };
    if (!token) throw new AppError(400, "MISSING_TOKEN", "Token requis");

    await supabase.from("drivers").update({ push_token: token }).eq("id", req.user!.id);
    sendSuccess(res, null, "Token enregistré");
  } catch (err) {
    next(err);
  }
}
