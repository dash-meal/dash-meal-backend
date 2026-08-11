import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated, sendPaginated } from "../../utils/response.js";

// 1 point = 5 FCFA de réduction
const POINT_VALUE_FCFA = 5;
// 1 point par 100 FCFA dépensés
const POINTS_PER_FCFA = 100;

export async function getMyLoyalty(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;

    // Récupérer ou créer le compte fidélité
    let { data: account, error: accErr } = await supabase
      .from("loyalty_accounts")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (accErr) throw new AppError(500, "DB_ERROR", accErr.message);

    if (!account) {
      const { data: created, error: createErr } = await supabase
        .from("loyalty_accounts")
        .insert({ user_id: userId, points: 0, total_earned: 0, total_redeemed: 0 })
        .select()
        .single();
      if (createErr) throw new AppError(500, "DB_ERROR", createErr.message);
      account = created;
    }

    // Récupérer les 20 dernières transactions
    const { data: transactions, error: txErr } = await supabase
      .from("loyalty_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (txErr) throw new AppError(500, "DB_ERROR", txErr.message);

    sendSuccess(res, { account, transactions: transactions ?? [] });
  } catch (err) {
    next(err);
  }
}

export async function earnPoints(req: Request, res: Response, next: NextFunction) {
  try {
    const { user_id, order_id, amount } = req.body as {
      user_id: string;
      order_id: string;
      amount: number;
    };

    // Un user ne peut gagner que ses propres points (sauf admin/superadmin)
    const caller = req.user!;
    const targetUserId =
      caller.role === "admin" || caller.role === "superadmin" ? user_id : caller.id;

    if (caller.role === "user" && user_id !== caller.id) {
      throw new AppError(403, "FORBIDDEN", "Vous ne pouvez gagner que vos propres points");
    }

    // Vérifier que la commande n'a pas déjà généré des points
    const { data: existingTx } = await supabase
      .from("loyalty_transactions")
      .select("id")
      .eq("order_id", order_id)
      .eq("type", "earn")
      .maybeSingle();

    if (existingTx) throw new AppError(409, "CONFLICT", "Des points ont déjà été attribués pour cette commande");

    const points = Math.floor(Number(amount) / POINTS_PER_FCFA);
    if (points <= 0) {
      sendSuccess(res, { points_earned: 0 }, "Aucun point à attribuer pour ce montant");
      return;
    }

    // Upsert compte fidélité
    const { data: existing } = await supabase
      .from("loyalty_accounts")
      .select("id, points, total_earned")
      .eq("user_id", targetUserId)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("loyalty_accounts")
        .update({
          points: existing.points + points,
          total_earned: existing.total_earned + points,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", targetUserId);
    } else {
      await supabase.from("loyalty_accounts").insert({
        user_id: targetUserId,
        points,
        total_earned: points,
        total_redeemed: 0,
      });
    }

    // Insérer transaction
    const { data: tx, error: txErr } = await supabase
      .from("loyalty_transactions")
      .insert({
        user_id: targetUserId,
        order_id,
        type: "earn",
        points,
        description: `Gains sur commande — ${amount} FCFA`,
      })
      .select()
      .single();

    if (txErr) throw new AppError(500, "DB_ERROR", txErr.message);

    sendCreated(res, { points_earned: points, transaction: tx });
  } catch (err) {
    next(err);
  }
}

export async function redeemPoints(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const { points } = req.body as { points: number };

    if (!points || points <= 0) {
      throw new AppError(400, "INVALID_POINTS", "Le nombre de points doit être supérieur à 0");
    }

    // Vérifier le solde
    const { data: account, error: accErr } = await supabase
      .from("loyalty_accounts")
      .select("id, points, total_redeemed")
      .eq("user_id", userId)
      .maybeSingle();

    if (accErr) throw new AppError(500, "DB_ERROR", accErr.message);
    if (!account) throw new AppError(404, "LOYALTY_NOT_FOUND", "Compte fidélité introuvable");
    if (account.points < points) {
      throw new AppError(422, "INSUFFICIENT_POINTS", `Solde insuffisant (${account.points} points disponibles)`);
    }

    const discount = points * POINT_VALUE_FCFA;

    // Déduire les points
    await supabase
      .from("loyalty_accounts")
      .update({
        points: account.points - points,
        total_redeemed: account.total_redeemed + points,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    // Insérer transaction
    const { data: tx, error: txErr } = await supabase
      .from("loyalty_transactions")
      .insert({
        user_id: userId,
        type: "redeem",
        points: -points,
        description: `Remboursement — ${discount} FCFA de réduction`,
      })
      .select()
      .single();

    if (txErr) throw new AppError(500, "DB_ERROR", txErr.message);

    sendSuccess(res, { points_redeemed: points, discount, transaction: tx });
  } catch (err) {
    next(err);
  }
}

export async function getLoyaltyTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, count, error } = await supabase
      .from("loyalty_transactions")
      .select("*", { count: "exact" })
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendPaginated(res, data ?? [], count ?? 0, page, limit);
  } catch (err) {
    next(err);
  }
}
