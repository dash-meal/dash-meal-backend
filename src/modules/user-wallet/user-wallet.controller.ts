import type { Request, Response, NextFunction } from "express";
import * as svc from "./user-wallet.service.js";

// ── GET /user-wallet ──────────────────────────────────────────────────────────
export async function getMyWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const wallet = await svc.getWallet(req.user!.id);
    res.json({ success: true, data: wallet });
  } catch (err) { next(err); }
}

// ── GET /user-wallet/card-numbers ─────────────────────────────────────────────
export async function generateCardNumbers(req: Request, res: Response, next: NextFunction) {
  try {
    const numbers = await svc.generateUniqueCardNumbers();
    res.json({ success: true, data: numbers });
  } catch (err) { next(err); }
}

// ── POST /user-wallet/activate ────────────────────────────────────────────────
export async function activateWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const { card_number, pin, payment_phone, payment_method, initial_amount } = req.body;
    const { data: user } = await import("../../config/supabase.js").then(m =>
      m.supabase.from("users").select("name").eq("id", req.user!.id).single()
    );
    const result = await svc.initiateActivation({
      userId: req.user!.id,
      cardName: user?.name ?? req.user!.id,
      cardNumber: card_number,
      pin,
      paymentPhone: payment_phone,
      paymentMethod: payment_method,
      initialAmount: initial_amount,
    });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ── POST /user-wallet/topup ───────────────────────────────────────────────────
export async function topUpWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const wallet = await svc.getWallet(req.user!.id);
    if (!wallet) {
      res.status(404).json({ success: false, error: { code: "NO_WALLET", message: "Activez votre wallet d'abord" } });
      return;
    }
    const { amount, phone, payment_method } = req.body;
    const result = await svc.initiateTopUp({ walletId: wallet.id, amount, phone, paymentMethod: payment_method });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ── POST /user-wallet/verify-pin ──────────────────────────────────────────────
export async function verifyPinHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const wallet = await svc.getWallet(req.user!.id);
    if (!wallet) { res.status(404).json({ success: false, error: { code: "NO_WALLET", message: "Wallet introuvable" } }); return; }
    const ok = await svc.verifyPin(wallet.id, req.body.pin);
    res.json({ success: true, data: { valid: ok } });
  } catch (err) { next(err); }
}

// ── POST /user-wallet/transfer ────────────────────────────────────────────────
export async function transferHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const wallet = await svc.getWallet(req.user!.id);
    if (!wallet) { res.status(404).json({ success: false, error: { code: "NO_WALLET", message: "Wallet introuvable" } }); return; }
    const { identifier, amount } = req.body;
    const result = await svc.transferWallet({ fromWalletId: wallet.id, identifier, amount });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ── POST /user-wallet/withdraw ────────────────────────────────────────────────
export async function withdrawHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const wallet = await svc.getWallet(req.user!.id);
    if (!wallet) { res.status(404).json({ success: false, error: { code: "NO_WALLET", message: "Wallet introuvable" } }); return; }
    const { amount, phone, phone_confirm } = req.body;
    const result = await svc.initiateWithdrawal({ walletId: wallet.id, amount, phone, phoneConfirm: phone_confirm });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ── GET /user-wallet/payment-status/:reference ───────────────────────────────
// Vérifie le statut en DB — si toujours pending, interroge Campay directement
// et confirme la transaction sans attendre le webhook.
export async function getPaymentStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const reference = String(req.params.reference);
    const { supabase } = await import("../../config/supabase.js");
    const { campayTransactionStatus } = await import("../../services/campay.js");
    const svc = await import("./user-wallet.service.js");

    const { data: tx } = await supabase
      .from("user_wallet_transactions")
      .select("status, type, amount, user_id")
      .eq("reference", reference)
      .eq("user_id", req.user!.id)
      .maybeSingle();

    if (!tx) {
      console.log(`[getPaymentStatus] ❌ NOT_FOUND reference="${reference}" user="${req.user!.id}"`);
      res.status(404).json({ success: false, error: { code: "NOT_FOUND" } }); return;
    }

    console.log(`[getPaymentStatus] reference="${reference}" status="${tx.status}" type="${tx.type}"`);

    // Déjà résolu
    if (tx.status !== "pending") {
      console.log(`[getPaymentStatus] déjà résolu → status="${tx.status}"`);
      res.json({ success: true, data: { status: tx.status, type: tx.type, amount: tx.amount } });
      return;
    }

    // Interroger Campay directement pour ne pas dépendre du webhook
    try {
      console.log(`[getPaymentStatus] interrogation Campay pour reference="${reference}"...`);
      const campay = await campayTransactionStatus(reference);
      console.log(`[getPaymentStatus] Campay réponse: status="${campay.status}" amount=${campay.amount} raw=`, JSON.stringify(campay));

      if (campay.status === "SUCCESSFUL") {
        let confirmed = false;
        try {
          if (tx.type === "activation") {
            console.log(`[getPaymentStatus] appel confirmActivation reference="${reference}" amount=${campay.amount}`);
            confirmed = await svc.confirmActivation(reference, campay.amount);
            console.log(`[getPaymentStatus] confirmActivation retourne confirmed=${confirmed}`);
          } else if (tx.type === "topup") {
            console.log(`[getPaymentStatus] appel confirmTopUp reference="${reference}" amount=${campay.amount}`);
            await svc.confirmTopUp(reference, campay.amount);
            confirmed = true;
          }
        } catch (confirmErr: any) {
          console.error("[getPaymentStatus] ❌ confirmActivation a lancé une erreur:", confirmErr?.message, confirmErr?.code);
          res.json({ success: true, data: { status: "pending", type: tx.type, amount: tx.amount } });
          return;
        }
        if (confirmed) {
          console.log(`[getPaymentStatus] ✅ activation confirmée → status=completed`);
          res.json({ success: true, data: { status: "completed", type: tx.type, amount: campay.amount } });
        } else {
          // Already processed (false) — re-read actual DB status
          const { data: txFresh } = await supabase
            .from("user_wallet_transactions")
            .select("status, amount")
            .eq("reference", reference)
            .maybeSingle();
          console.log(`[getPaymentStatus] déjà traité → DB status="${txFresh?.status}"`);
          res.json({ success: true, data: { status: txFresh?.status ?? "completed", type: tx.type, amount: txFresh?.amount ?? campay.amount } });
        }
        return;
      }
      if (campay.status === "FAILED") {
        console.log(`[getPaymentStatus] ❌ Campay FAILED → marquer transaction failed`);
        await supabase.from("user_wallet_transactions").update({ status: "failed" }).eq("reference", reference);
        res.json({ success: true, data: { status: "failed", type: tx.type, amount: tx.amount } });
        return;
      }
      console.log(`[getPaymentStatus] Campay status="${campay.status}" — toujours pending`);
    } catch (campayErr: any) {
      console.warn(`[getPaymentStatus] Campay injoignable:`, campayErr?.message ?? campayErr);
      // Campay injoignable → renvoyer le statut DB actuel
    }

    res.json({ success: true, data: { status: tx.status, type: tx.type, amount: tx.amount } });
  } catch (err) { next(err); }
}

// ── GET /user-wallet/transactions ─────────────────────────────────────────────
export async function getMyTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const wallet = await svc.getWallet(req.user!.id);
    if (!wallet) { res.json({ success: true, data: { transactions: [], pagination: { page:1, limit:20, total:0, total_pages:0 } } }); return; }
    const page  = Number(req.query.page)  || 1;
    const limit = Number(req.query.limit) || 20;
    const result = await svc.getTransactions(wallet.id, page, limit);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
}

// ── POST /user-wallet/shared-cart ─────────────────────────────────────────────
export async function createSharedCartHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { data: user } = await import("../../config/supabase.js").then(m =>
      m.supabase.from("users").select("name").eq("id", req.user!.id).single()
    );
    const { data: branch } = await import("../../config/supabase.js").then(m =>
      m.supabase.from("branches").select("name").eq("id", req.body.branch_id).single()
    );
    const result = await svc.createSharedCart({
      ownerId: req.user!.id,
      ownerName: user?.name ?? "Utilisateur",
      branchId: req.body.branch_id,
      branchName: branch?.name ?? "Agence",
      items: req.body.items,
      orderType: req.body.order_type ?? "collect",
      promoId: req.body.promo_id,
      promoCode: req.body.promo_code,
      promoPct: req.body.promo_pct,
      subtotal: req.body.subtotal,
      discountAmount: req.body.discount_amount ?? 0,
      totalAmount: req.body.total_amount,
    });
    res.status(201).json({ success: true, data: result });
  } catch (err) { next(err); }
}

// ── GET /user-wallet/shared-cart/:token (public) ──────────────────────────────
export async function getSharedCartHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const cart = await svc.getSharedCart(String(req.params.token));
    res.json({ success: true, data: cart });
  } catch (err) { next(err); }
}

// ── Superadmin ────────────────────────────────────────────────────────────────

export async function getCommissionWallet(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await svc.getCommissionWallet();
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

export async function getAllTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = Number(req.query.page)  || 1;
    const limit = Number(req.query.limit) || 50;
    const type  = req.query.type as string | undefined;
    const result = await svc.getAllUserTransactions(page, limit, type);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
}

export async function getCommissionTransactions(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = Number(req.query.page)  || 1;
    const limit = Number(req.query.limit) || 50;
    const result = await svc.getCommissionTransactions(page, limit);
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
}
