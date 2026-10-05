import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { env } from "../../config/env.js";

async function sendPushToUser(userId: string, title: string, body: string, data?: Record<string, unknown>) {
  try {
    const { data: tokens } = await supabase
      .from("push_tokens")
      .select("token, locale")
      .eq("user_id", userId);
    if (!tokens || tokens.length === 0) return;

    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (env.EXPO_ACCESS_TOKEN) headers["Authorization"] = `Bearer ${env.EXPO_ACCESS_TOKEN}`;

    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers,
      body: JSON.stringify(tokens.map((t: { token: string }) => ({
        to: t.token, title, body, data: data ?? {}, sound: "default",
      }))),
    });
  } catch {
    // push est best-effort
  }
}

export async function getSlots(req: Request, res: Response, next: NextFunction) {
  try {
    const { branchId } = req.params;
    const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);

    // Vérifier si des créneaux existent déjà pour cette date
    const { data: existing, error } = await supabase
      .from("time_slots")
      .select("id, date, start_time, end_time, capacity, booked")
      .eq("branch_id", branchId)
      .eq("date", date)
      .order("start_time");

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération des créneaux");

    if (existing && existing.length > 0) {
      return sendSuccess(res, existing);
    }

    // Aucun créneau → générer automatiquement depuis les horaires d'ouverture
    const { data: generated, error: genErr } = await supabase
      .rpc("generate_branch_slots", { p_branch_id: branchId, p_date: date });

    if (genErr) {
      // La fonction RPC n'existe pas encore ou erreur — retourner vide sans crash
      return sendSuccess(res, []);
    }

    sendSuccess(res, generated ?? []);
  } catch (err) {
    next(err);
  }
}

export async function scanQrCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { qr_code } = req.body;

    if (!qr_code) throw new AppError(400, "MISSING_QR_CODE", "QR code manquant");

    // Chercher la commande collect correspondante
    const { data: collect, error } = await supabase
      .from("collect_orders")
      .select(`
        *,
        orders(
          id, status, total, user_id,
          users(name, phone),
          order_items(quantity, unit_price, products(name_fr)),
          time_slots(date, start_time, end_time)
        )
      `)
      .eq("qr_code", qr_code)
      .single();

    if (error || !collect) {
      throw new AppError(404, "QR_NOT_FOUND", "QR code invalide ou introuvable");
    }

    const order = collect.orders as Record<string, unknown>;

    // Vérifier que la commande est prête
    if (order.status !== "ready") {
      throw new AppError(400, "ORDER_NOT_READY", `Commande non prête (statut : ${order.status})`);
    }

    // Vérifier que le QR n'a pas déjà été utilisé
    if (collect.pickup_status === "picked_up") {
      throw new AppError(400, "ALREADY_PICKED_UP", "Cette commande a déjà été récupérée");
    }

    // Marquer comme récupérée
    await supabase
      .from("collect_orders")
      .update({ pickup_status: "picked_up", picked_up_at: new Date().toISOString() })
      .eq("id", collect.id);

    // Mettre à jour le statut de la commande
    await supabase
      .from("orders")
      .update({ status: "delivered" })
      .eq("id", order.id as string);

    await supabase.from("order_status_history").insert({
      order_id: order.id as string,
      status: "delivered",
      changed_by: req.user!.id,
      changed_by_role: req.user!.role,
      note: "Retrait validé par scan QR",
    });

    // Notifier l'utilisateur que sa commande a été récupérée
    const userId = order.user_id as string | undefined;
    if (userId) {
      void sendPushToUser(
        userId,
        "Commande récupérée ✅",
        "Votre commande a été remise avec succès. Merci !",
        { order_id: order.id, screen: "order_detail" }
      );
    }

    sendSuccess(res, {
      order_id: order.id,
      customer: order.users,
      items: order.order_items,
      total: order.total,
    }, "Retrait validé avec succès");
  } catch (err) {
    next(err);
  }
}

export async function getCollectDetails(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("collect_orders")
      .select(`
        qr_code, pickup_status, picked_up_at,
        orders!inner(id, status, total, user_id),
        time_slots(date, start_time, end_time, branches(name, address))
      `)
      .eq("orders.id", req.params.orderId)
      .eq("orders.user_id", req.user!.id) // sécurité
      .single();

    if (error || !data) {
      throw new AppError(404, "NOT_FOUND", "Détails de retrait introuvables");
    }

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Côté admin : récupérer le QR code d'une commande collect ────────────────
export async function getCollectQrForAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("collect_orders")
      .select(`
        qr_code, pickup_status, picked_up_at,
        orders!inner(id, status, total),
        time_slots(date, start_time, end_time)
      `)
      .eq("order_id", req.params.orderId)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "QR code introuvable pour cette commande");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

export async function listBranchCollects(req: Request, res: Response, next: NextFunction) {
  try {
    const { branchId } = req.params;
    const { date, status } = req.query as Record<string, string>;

    let query = supabase
      .from("collect_orders")
      .select(`
        *,
        orders!inner(id, status, total, created_at, users(name, phone)),
        time_slots!inner(date, start_time, end_time, branch_id)
      `)
      .eq("time_slots.branch_id", branchId)
      .order("time_slots.start_time");

    if (date) query = query.eq("time_slots.date", date);
    if (status) query = query.eq("pickup_status", status);

    const { data, error } = await query;
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}
