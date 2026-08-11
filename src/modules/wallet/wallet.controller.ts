import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";
import { campayWithdraw, campayGetSubscriberName } from "../../services/campay.js";

const PLATFORM_FEE_RATE = 0.015; // 1.5%

// ─── GET /wallet ──────────────────────────────────────────────────────────────
// Solde total (somme des agences) + détail par agence

export async function getWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.brand_id;
    if (!brand_id) throw new AppError(403, "FORBIDDEN", "Accès réservé aux admins de marque");

    const { data: wallets, error } = await supabase
      .from("branch_wallets")
      .select("*, branches(id, name)")
      .eq("brand_id", brand_id)
      .order("updated_at", { ascending: false });

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    const rows = wallets ?? [];
    const total_balance   = rows.reduce((s, w) => s + Number(w.balance),         0);
    const total_credited  = rows.reduce((s, w) => s + Number(w.total_credited),  0);
    const total_withdrawn = rows.reduce((s, w) => s + Number(w.total_withdrawn), 0);

    sendSuccess(res, {
      total_balance,
      total_credited,
      total_withdrawn,
      branches: rows.map((w) => ({
        wallet_id:       w.id,
        branch_id:       w.branch_id,
        branch_name:     (w.branches as any)?.name ?? "Agence",
        balance:         Number(w.balance),
        total_credited:  Number(w.total_credited),
        total_withdrawn: Number(w.total_withdrawn),
        updated_at:      w.updated_at,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /wallet/transactions ─────────────────────────────────────────────────
// Historique paginé — toutes agences ou filtré par agence

export async function getWalletTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.brand_id;
    if (!brand_id) throw new AppError(403, "FORBIDDEN", "Accès réservé aux admins de marque");

    const page      = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit     = Math.min(50, parseInt(req.query.limit as string) || 20);
    const type      = req.query.type      as string | undefined;
    const branch_id = req.query.branch_id as string | undefined;
    const date_from = req.query.date_from as string | undefined;
    const date_to   = req.query.date_to   as string | undefined;
    const from      = (page - 1) * limit;

    let query = supabase
      .from("branch_wallet_transactions")
      .select("*, branches(name), orders(id)", { count: "exact" })
      .eq("brand_id", brand_id)
      .order("created_at", { ascending: false })
      .range(from, from + limit - 1);

    if (type && type !== "all")   query = query.eq("type", type);
    if (branch_id)                query = query.eq("branch_id", branch_id);
    if (date_from)                query = query.gte("created_at", date_from);
    if (date_to)                  query = query.lte("created_at", date_to);

    const { data, count, error } = await query;
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    res.json({
      success: true,
      data: data ?? [],
      pagination: {
        page, limit,
        total: count ?? 0,
        total_pages: Math.ceil((count ?? 0) / limit),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /wallet/withdraw ────────────────────────────────────────────────────
// Retrait depuis le wallet d'une agence spécifique

export async function requestWithdrawal(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.brand_id;
    if (!brand_id) throw new AppError(403, "FORBIDDEN", "Accès réservé aux admins de marque");

    const { amount, phone, branch_id } = req.body;
    const amountNum = Number(amount);

    if (!amountNum || amountNum <= 0) throw new AppError(400, "INVALID_AMOUNT", "Montant invalide");
    if (!phone)     throw new AppError(400, "PHONE_REQUIRED", "Numéro de téléphone requis");
    if (!branch_id) throw new AppError(400, "BRANCH_REQUIRED", "Agence requise pour le retrait");

    // Vérifier que l'agence appartient à la marque
    const { data: wallet, error: wErr } = await supabase
      .from("branch_wallets")
      .select("*")
      .eq("branch_id", branch_id)
      .eq("brand_id", brand_id)
      .single();

    if (wErr || !wallet) throw new AppError(404, "WALLET_NOT_FOUND", "Wallet de cette agence introuvable");
    if (wallet.balance < amountNum) throw new AppError(422, "INSUFFICIENT_BALANCE", "Solde insuffisant");

    const platform_fee = Math.round(amountNum * PLATFORM_FEE_RATE);
    const net_payout   = amountNum - platform_fee;

    const { data: branch } = await supabase
      .from("branches").select("name").eq("id", branch_id).single();
    const description = `Retrait ${branch?.name ?? branch_id.slice(0, 8)} — ${amountNum.toLocaleString("fr-FR")} FCFA`;

    let campayRef: string;
    try {
      const campayRes = await campayWithdraw({
        amount: net_payout,
        phone,
        description,
        externalReference: `withdrawal_${wallet.id}_${Date.now()}`,
      });
      campayRef = campayRes.reference;
    } catch (campayErr: any) {
      if (campayErr instanceof AppError) throw campayErr;
      throw new AppError(502, "CAMPAY_ERROR", campayErr?.message ?? "Échec du virement Campay");
    }

    const { data: txnId, error: rpcErr } = await supabase.rpc("process_branch_withdrawal", {
      p_branch_id:        branch_id,
      p_brand_id:         brand_id,
      p_amount:           amountNum,
      p_platform_fee:     platform_fee,
      p_net_payout:       net_payout,
      p_description:      description,
      p_campay_reference: campayRef,
    });

    if (rpcErr) {
      if (rpcErr.message.includes("INSUFFICIENT_BALANCE"))
        throw new AppError(422, "INSUFFICIENT_BALANCE", "Solde insuffisant");
      throw new AppError(500, "DB_ERROR", rpcErr.message);
    }

    sendSuccess(res, {
      transaction_id: txnId,
      branch_id,
      amount:         amountNum,
      platform_fee,
      net_payout,
      campay_reference: campayRef,
    }, "Retrait effectué avec succès");
  } catch (err) {
    next(err);
  }
}

// ─── POST /wallet/verify-phone ───────────────────────────────────────────────
// Vérifie le nom du titulaire (Campay) — gardé pour usage futur

export async function verifyWithdrawPhone(req: Request, res: Response, next: NextFunction) {
  try {
    const { phone } = req.body;
    if (!phone) throw new AppError(400, "PHONE_REQUIRED", "Numéro de téléphone requis");

    const result = await campayGetSubscriberName(phone);
    if (!result) return sendSuccess(res, { verified: false, name: null, operator: null });

    sendSuccess(res, { verified: true, name: result.name, operator: result.operator });
  } catch (err) {
    next(err);
  }
}

// ─── GET /wallet/platform ─────────────────────────────────────────────────────

export async function getPlatformWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase.from("platform_wallet").select("*").single();
    if (error || !data) throw new AppError(500, "DB_ERROR", "Wallet plateforme introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── POST /wallet/platform/withdraw ──────────────────────────────────────────

export async function platformWithdraw(req: Request, res: Response, next: NextFunction) {
  try {
    const { amount, phone } = req.body;
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) throw new AppError(400, "INVALID_AMOUNT", "Montant invalide");
    if (!phone) throw new AppError(400, "PHONE_REQUIRED", "Numéro de téléphone requis");

    const { data: wallet } = await supabase.from("platform_wallet").select("balance").single();
    if (!wallet || wallet.balance < amountNum) throw new AppError(422, "INSUFFICIENT_BALANCE", "Solde insuffisant");

    const description = `Retrait superadmin — ${amountNum.toLocaleString("fr-FR")} FCFA`;

    let campayRef: string;
    try {
      const campayRes = await campayWithdraw({ amount: amountNum, phone, description, externalReference: `platform_wd_${Date.now()}` });
      campayRef = campayRes.reference;
    } catch (campayErr: any) {
      if (campayErr instanceof AppError) throw campayErr;
      throw new AppError(502, "CAMPAY_ERROR", campayErr?.message ?? "Échec du virement Campay");
    }

    const { error } = await supabase.rpc("process_platform_withdrawal", {
      p_amount: amountNum,
      p_campay_reference: campayRef,
      p_description: description,
    });
    if (error) {
      if (error.message.includes("INSUFFICIENT_BALANCE")) throw new AppError(422, "INSUFFICIENT_BALANCE", "Solde insuffisant");
      throw new AppError(500, "DB_ERROR", error.message);
    }

    sendSuccess(res, { campay_reference: campayRef, amount: amountNum }, "Retrait effectué");
  } catch (err) {
    next(err);
  }
}

// ─── GET /wallet/platform/transactions ───────────────────────────────────────

export async function getPlatformTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const page      = Math.max(1, parseInt(req.query.page  as string) || 1);
    const limit     = Math.min(50, parseInt(req.query.limit as string) || 20);
    const date_from = req.query.date_from as string | undefined;
    const date_to   = req.query.date_to   as string | undefined;
    const type      = req.query.type      as string | undefined;
    const from      = (page - 1) * limit;

    let txQuery = supabase
      .from("platform_wallet_transactions")
      .select("*, brands(name)", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, from + limit - 1);

    if (type && type !== "all") txQuery = txQuery.eq("type", type);
    if (date_from)              txQuery = txQuery.gte("created_at", date_from);
    if (date_to)                txQuery = txQuery.lte("created_at", date_to);

    const { data, count, error } = await txQuery;

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    res.json({
      success: true,
      data: data ?? [],
      pagination: {
        page, limit,
        total: count ?? 0,
        total_pages: Math.ceil((count ?? 0) / limit),
      },
    });
  } catch (err) {
    next(err);
  }
}
