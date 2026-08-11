import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { campayWithdraw } from "../../services/campay.js";

export const DRIVER_SHARE      = 0.70; // 70% livreur
export const ADMIN_SHARE       = 0.20; // 20% admin de marque
export const SUPERADMIN_SHARE  = 0.10; // 10% superadmin plateforme

// ─── GET /driver-wallet/me — solde + stats du livreur connecté ────────────────
export async function getMyWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("driver_wallets")
      .select("*")
      .eq("driver_id", req.user!.id)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Wallet introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── GET /driver-wallet/me/transactions ──────────────────────────────────────
export async function getMyTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 20);
    const from  = (page - 1) * limit;

    const { data, count, error } = await supabase
      .from("driver_wallet_transactions")
      .select("*", { count: "exact" })
      .eq("driver_id", req.user!.id)
      .order("created_at", { ascending: false })
      .range(from, from + limit - 1);

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    res.json({
      success: true,
      data: data ?? [],
      pagination: { page, limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limit) },
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /driver-wallet/me/withdraw ─────────────────────────────────────────
export async function requestDriverWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    const { amount, phone } = req.body as { amount: number; phone: string };
    const driver_id = req.user!.id;
    const brand_id  = req.user!.brand_id!;

    if (amount < 500) throw new AppError(400, "MIN_AMOUNT", "Montant minimum : 500 FCFA");

    const { data: wallet } = await supabase
      .from("driver_wallets")
      .select("id, balance, total_withdrawn")
      .eq("driver_id", driver_id)
      .single();

    if (!wallet)              throw new AppError(404, "NOT_FOUND",       "Wallet introuvable");
    if (wallet.balance < amount) throw new AppError(400, "INSUFFICIENT_BALANCE", "Solde insuffisant");

    const txId = crypto.randomUUID();
    const campayRef = await campayWithdraw({
      amount,
      phone,
      description: `Retrait livreur ${driver_id.slice(0, 8)}`,
      externalReference: txId,
    });

    const newBalance = Number(wallet.balance) - amount;
    const newWithdrawn = Number(wallet.total_withdrawn ?? 0) + amount;

    await supabase.from("driver_wallets")
      .update({ balance: newBalance, total_withdrawn: newWithdrawn, updated_at: new Date().toISOString() })
      .eq("driver_id", driver_id);

    await supabase.from("driver_wallet_transactions").insert({
      driver_id,
      brand_id,
      type: "withdrawal",
      amount,
      balance_after: newBalance,
      description:   `Retrait vers ${phone}`,
      campay_reference: campayRef?.reference ?? null,
      status: "completed",
    });

    sendSuccess(res, { net_payout: amount, new_balance: newBalance }, "Retrait initié");
  } catch (err) {
    next(err);
  }
}

// ─── GET /driver-wallet/:driver_id — admin voit le wallet d'un livreur ────────
export async function getDriverWalletById(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: driver } = await supabase
      .from("drivers")
      .select("brand_id")
      .eq("id", req.params.driver_id)
      .single();

    if (!driver) throw new AppError(404, "NOT_FOUND", "Livreur introuvable");
    if (req.user!.role === "admin" && driver.brand_id !== req.user!.brand_id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé");
    }

    const { data: wallet } = await supabase
      .from("driver_wallets")
      .select("*")
      .eq("driver_id", req.params.driver_id)
      .single();

    sendSuccess(res, wallet ?? { driver_id: req.params.driver_id, balance: 0, total_earned: 0, total_withdrawn: 0 });
  } catch (err) {
    next(err);
  }
}

// ─── Fonction interne : créditer le wallet du livreur lors d'une livraison ───
// Appelée depuis delivery.controller après status "delivered"
export async function creditDriverEarning(
  driverId: string,
  brandId: string,
  orderId: string,
  deliveryFee: number
): Promise<void> {
  if (!deliveryFee || deliveryFee <= 0) return;

  const driverAmount = Math.round(deliveryFee * DRIVER_SHARE);

  // Créer le wallet si absent
  await supabase.from("driver_wallets")
    .upsert({ driver_id: driverId, brand_id: brandId, balance: 0, total_earned: 0, total_withdrawn: 0 }, { onConflict: "driver_id", ignoreDuplicates: true });

  // Lire solde actuel
  const { data: wallet } = await supabase
    .from("driver_wallets").select("balance, total_earned").eq("driver_id", driverId).single();

  const newBalance = (Number(wallet?.balance ?? 0)) + driverAmount;
  const newEarned  = (Number(wallet?.total_earned ?? 0)) + driverAmount;

  await supabase.from("driver_wallets")
    .update({ balance: newBalance, total_earned: newEarned, updated_at: new Date().toISOString() })
    .eq("driver_id", driverId);

  await supabase.from("driver_wallet_transactions").insert({
    driver_id:    driverId,
    brand_id:     brandId,
    type:         "earning",
    amount:       driverAmount,
    balance_after: newBalance,
    description:  `Livraison #${orderId.slice(0, 8).toUpperCase()}`,
    order_id:     orderId,
    status:       "completed",
  });

  // Marquer les frais comme distribués
  await supabase.from("orders")
    .update({ driver_fee_paid: true })
    .eq("id", orderId);
}
