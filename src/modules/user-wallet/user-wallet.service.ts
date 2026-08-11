import bcrypt from "bcryptjs";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { campayCollect, campayWithdraw } from "../../services/campay.js";

const TOPUP_CALLBACK = process.env.CAMPAY_CALLBACK_URL?.replace("/payments/", "/user-wallet/") ?? "";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserWallet {
  id: string;
  user_id: string;
  card_number: string;
  card_name: string;
  balance: number;
  biometric_enabled: boolean;
  is_active: boolean;
  created_at: string;
}

// ─── Wallet retrieval ──────────────────────────────────────────────────────────

export async function getWallet(userId: string): Promise<UserWallet | null> {
  const { data } = await supabase
    .from("user_wallets")
    .select("id, user_id, card_number, card_name, balance, biometric_enabled, is_active, created_at")
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

// ─── Card number generation ────────────────────────────────────────────────────

export async function generateUniqueCardNumbers(): Promise<string[]> {
  // Générer 12 candidats d'un coup, vérifier en une seule requête batch
  const make = () => String(Math.floor(10000000 + Math.random() * 90000000));

  const candidates = Array.from(new Set(Array.from({ length: 12 }, make)));

  const { data: taken } = await supabase
    .from("user_wallets")
    .select("card_number")
    .in("card_number", candidates);

  const takenSet = new Set((taken ?? []).map((r: any) => r.card_number));
  const available = candidates.filter((c) => !takenSet.has(c));

  if (available.length < 3) throw new AppError(500, "CARD_GEN_ERROR", "Impossible de générer les numéros de carte");
  return available.slice(0, 3);
}

// ─── Wallet activation ─────────────────────────────────────────────────────────
// Flow identique au paiement de commande :
//  1. Insérer la transaction pending EN PREMIER (obtenir un UUID unique)
//  2. Appeler Campay avec cet UUID comme external_reference (évite les doublons)
//  3. Si Campay échoue → supprimer la transaction (pas de ghost pending)
//  4. Mettre à jour avec la vraie référence Campay

export async function initiateActivation(input: {
  userId: string;
  cardName: string;
  cardNumber: string;
  pin: string;
  paymentPhone: string;
  paymentMethod: "orange_money" | "mtn_mobile_money";
  initialAmount: number; // minimum 10 FCFA
}) {
  if (input.initialAmount < 10) throw new AppError(400, "MIN_DEPOSIT", "Le dépôt initial minimum est de 10 FCFA");

  // Vérifier que le numéro de carte n'est pas déjà pris
  const { data: existing } = await supabase
    .from("user_wallets")
    .select("id")
    .eq("card_number", input.cardNumber)
    .maybeSingle();
  if (existing) throw new AppError(409, "CARD_TAKEN", "Ce numéro de carte est déjà utilisé");

  // Vérifier qu'il n'a pas déjà un wallet
  const { data: existingWallet } = await supabase
    .from("user_wallets")
    .select("id")
    .eq("user_id", input.userId)
    .maybeSingle();
  if (existingWallet) throw new AppError(409, "WALLET_EXISTS", "Vous avez déjà un wallet actif");

  const pinHash = await bcrypt.hash(input.pin, 10);
  const pendingMeta = { cardNumber: input.cardNumber, cardName: input.cardName, pinHash, phone: input.paymentPhone };

  // ── 1. Sauvegarder EN PREMIER pour obtenir un UUID unique (external_reference Campay)
  const { data: tx, error: txErr } = await supabase
    .from("user_wallet_transactions")
    .insert({
      wallet_id: null,
      user_id: input.userId,
      type: "activation",
      amount: input.initialAmount,
      fee_amount: 0,
      balance_before: 0,
      balance_after: input.initialAmount,
      reference: `pending_${input.userId.slice(0, 8)}_${Date.now()}`,
      description: "Activation wallet — en attente",
      status: "pending",
      metadata: pendingMeta,
    } as any)
    .select("id")
    .single();

  if (txErr || !tx) {
    console.error("[wallet/activate] DB insert error:", txErr?.message, txErr?.details, txErr?.hint);
    throw new AppError(500, "INTENT_ERROR", "Impossible de préparer l'activation. Réessayez.");
  }

  // ── 2. Appeler Campay avec l'UUID de la transaction (jamais dupliqué)
  let campayData;
  try {
    campayData = await campayCollect({
      amount: input.initialAmount,
      phone: input.paymentPhone,
      description: "Activation Wallet Dash Meal",
      externalReference: tx.id,
      paymentMethod: input.paymentMethod,
    });
  } catch (campayErr) {
    // Campay a échoué → supprimer la transaction pour ne pas bloquer l'utilisateur
    await supabase.from("user_wallet_transactions").delete().eq("id", tx.id);
    throw campayErr;
  }

  // ── 3. Mettre à jour avec la vraie référence Campay
  await supabase.from("user_wallet_transactions")
    .update({ reference: campayData.reference })
    .eq("id", tx.id);

  console.log(`[initiateActivation] ✅ Campay OK — reference="${campayData.reference}" ussd="${campayData.ussd_code}" operator="${campayData.operator}"`);

  return {
    reference: campayData.reference,
    ussd_code: campayData.ussd_code ?? null,
    operator: campayData.operator ?? null,
  };
}

// ─── Confirm activation (appelé par polling ou webhook Campay) ────────────────
// Returns true  → wallet created + transaction completed
// Returns false → already processed (idempotent, transaction was not pending)
// Throws        → wallet insert failed (caller should NOT return "completed")

export async function confirmActivation(reference: string, amount: number): Promise<boolean> {
  console.log(`[confirmActivation] cherche tx pending reference="${reference}" amount=${amount}`);

  const { data: pending, error: fetchErr } = await supabase
    .from("user_wallet_transactions")
    .select("*")
    .eq("reference", reference)
    .eq("type", "activation")
    .eq("status", "pending")
    .maybeSingle();

  if (fetchErr) console.error("[confirmActivation] erreur fetch DB:", fetchErr.message, fetchErr.details);

  if (!pending) {
    console.log(`[confirmActivation] aucun tx pending trouvé pour reference="${reference}" → retourne false`);
    return false; // déjà traité
  }
  console.log(`[confirmActivation] tx trouvé: id="${pending.id}" user="${pending.user_id}"`);

  const { cardNumber, cardName, pinHash } = pending.metadata as { cardNumber: string; cardName: string; pinHash: string };

  const { data: wallet, error } = await supabase
    .from("user_wallets")
    .insert({
      user_id: pending.user_id,
      card_number: cardNumber,
      card_name: cardName,
      balance: amount,
      pin_hash: pinHash,
    })
    .select("id")
    .single();

  if (error || !wallet) {
    console.error("[confirmActivation] ❌ wallet insert failed:", error?.message, error?.details, error?.hint, error?.code);
    throw new AppError(500, "WALLET_CREATE_ERROR", "Impossible de créer le wallet. Réessayez dans quelques secondes.");
  }

  console.log(`[confirmActivation] ✅ wallet créé id="${wallet.id}" — mise à jour transaction...`);

  const { error: updateErr } = await supabase
    .from("user_wallet_transactions")
    .update({
      wallet_id: wallet.id,
      status: "completed",
      balance_after: amount,
      description: "Activation wallet — confirmé",
    })
    .eq("reference", reference);

  if (updateErr) console.error("[confirmActivation] erreur update transaction:", updateErr.message);
  else console.log(`[confirmActivation] ✅ transaction marquée completed`);

  return true;
}

// ─── Top-up (recharge via Mobile Money) ───────────────────────────────────────

export async function initiateTopUp(input: {
  walletId: string;
  amount: number;
  phone: string;
  paymentMethod?: "orange_money" | "mtn_mobile_money";
}) {
  if (input.amount < 10) throw new AppError(400, "MIN_TOPUP", "Le montant minimum de recharge est de 10 FCFA");

  const { data: wallet } = await supabase
    .from("user_wallets")
    .select("id, user_id, balance")
    .eq("id", input.walletId)
    .single();
  if (!wallet) throw new AppError(404, "WALLET_NOT_FOUND", "Wallet introuvable");

  // ── 1. Sauvegarder EN PREMIER (même pattern que le paiement de commande)
  const { data: tx, error: txErr } = await supabase
    .from("user_wallet_transactions")
    .insert({
      wallet_id: input.walletId,
      user_id: wallet.user_id,
      type: "topup",
      amount: input.amount,
      fee_amount: 0,
      balance_before: wallet.balance,
      balance_after: wallet.balance + input.amount,
      reference: `pending_topup_${input.walletId.slice(0, 8)}_${Date.now()}`,
      description: "Recharge Mobile Money",
      status: "pending",
      metadata: { phone: input.phone },
    } as any)
    .select("id")
    .single();

  if (txErr || !tx) {
    throw new AppError(500, "INTENT_ERROR", "Impossible de préparer la recharge. Réessayez.");
  }

  // ── 2. Appeler Campay avec l'UUID (external_reference unique)
  let campayData;
  try {
    campayData = await campayCollect({
      amount: input.amount,
      phone: input.phone,
      description: "Recharge Wallet Dash Meal",
      externalReference: tx.id,
      paymentMethod: input.paymentMethod,
    });
  } catch (campayErr) {
    await supabase.from("user_wallet_transactions").delete().eq("id", tx.id);
    throw campayErr;
  }

  // ── 3. Mettre à jour avec la vraie référence Campay
  await supabase.from("user_wallet_transactions")
    .update({ reference: campayData.reference })
    .eq("id", tx.id);

  return {
    reference: campayData.reference,
    ussd_code: campayData.ussd_code ?? null,
    operator: campayData.operator ?? null,
  };
}

// ─── Confirm top-up (appelé par webhook) ──────────────────────────────────────

export async function confirmTopUp(reference: string, amount: number) {
  const { data: tx } = await supabase
    .from("user_wallet_transactions")
    .select("*")
    .eq("reference", reference)
    .eq("type", "topup")
    .eq("status", "pending")
    .maybeSingle();
  if (!tx) return;

  await supabase.from("user_wallets")
    .update({ balance: supabase.rpc as any, updated_at: new Date().toISOString() });

  // Créditer directement
  await supabase.rpc("user_wallet_topup_confirm" as any, {
    p_wallet_id: tx.wallet_id,
    p_amount: amount,
    p_reference: reference,
  }).maybeSingle();

  // Fallback direct update si RPC absent
  await supabase
    .from("user_wallets")
    .update({ balance: tx.balance_before + amount, updated_at: new Date().toISOString() })
    .eq("id", tx.wallet_id);

  await supabase
    .from("user_wallet_transactions")
    .update({ status: "completed" })
    .eq("reference", reference);
}

// ─── Transfer wallet-à-wallet ─────────────────────────────────────────────────

export async function transferWallet(input: {
  fromWalletId: string;
  identifier: string; // card_number (8 chiffres) ou email
  amount: number;
}) {
  if (input.amount < 100) throw new AppError(400, "MIN_TRANSFER", "Montant minimum de transfert : 100 FCFA");

  // Trouver le wallet destinataire
  let toWalletQuery = supabase.from("user_wallets").select("id, user_id, card_name");

  if (/^\d{8}$/.test(input.identifier)) {
    toWalletQuery = toWalletQuery.eq("card_number", input.identifier);
  } else {
    // Chercher par email de l'utilisateur
    const { data: user } = await supabase
      .from("users")
      .select("id")
      .eq("email", input.identifier.toLowerCase())
      .maybeSingle();
    if (!user) throw new AppError(404, "RECIPIENT_NOT_FOUND", "Aucun compte trouvé avec cet identifiant");
    toWalletQuery = toWalletQuery.eq("user_id", user.id);
  }

  const { data: toWallet } = await toWalletQuery.maybeSingle();
  if (!toWallet) throw new AppError(404, "RECIPIENT_NOT_FOUND", "Aucun wallet trouvé pour ce destinataire");
  if (toWallet.id === input.fromWalletId) throw new AppError(400, "SELF_TRANSFER", "Vous ne pouvez pas vous transférer à vous-même");

  const { data: result } = await supabase.rpc("user_wallet_transfer", {
    p_from_wallet_id: input.fromWalletId,
    p_to_wallet_id: toWallet.id,
    p_amount: input.amount,
  });

  if (!result?.success) {
    if (result?.error === "INSUFFICIENT_BALANCE") {
      throw new AppError(400, "INSUFFICIENT_BALANCE", `Solde insuffisant. Il vous manque ${result.required - result.available} FCFA`);
    }
    throw new AppError(500, "TRANSFER_ERROR", "Échec du transfert");
  }

  return {
    recipient_name: toWallet.card_name,
    amount: input.amount,
    fee: result.fee,
    new_balance: result.new_balance,
  };
}

// ─── Withdrawal ───────────────────────────────────────────────────────────────

export async function initiateWithdrawal(input: {
  walletId: string;
  amount: number;
  phone: string;
  phoneConfirm: string;
}) {
  if (input.phone !== input.phoneConfirm) {
    throw new AppError(400, "PHONE_MISMATCH", "Les numéros de téléphone ne correspondent pas");
  }
  if (input.amount < 500) throw new AppError(400, "MIN_WITHDRAW", "Le retrait minimum est de 500 FCFA");

  const { data: wallet } = await supabase
    .from("user_wallets")
    .select("id, user_id, balance")
    .eq("id", input.walletId)
    .single();
  if (!wallet) throw new AppError(404, "WALLET_NOT_FOUND", "Wallet introuvable");

  const fee = Math.max(Math.round(input.amount * 0.02), 1);
  const netAmount = input.amount - fee;

  if (wallet.balance < input.amount) {
    throw new AppError(400, "INSUFFICIENT_BALANCE", `Solde insuffisant. Il vous manque ${input.amount - wallet.balance} FCFA`);
  }

  // Débiter via SQL atomique
  const { data: result } = await supabase.rpc("user_wallet_withdraw", {
    p_wallet_id: input.walletId,
    p_amount: input.amount,
    p_phone: input.phone,
    p_reference: `wdraw-${Date.now()}`,
  });

  if (!result?.success) {
    throw new AppError(400, result?.error ?? "WITHDRAW_ERROR", "Échec du retrait");
  }

  // Déclencher le virement Campay vers le client
  try {
    await campayWithdraw({
      amount: netAmount,
      phone: input.phone,
      description: "Retrait Wallet Dash Meal",
      externalReference: `wdraw-${input.walletId}-${Date.now()}`,
    });
  } catch {
    // Si Campay échoue, le wallet a déjà été débité → on log mais on ne re-créditera pas ici
    // Un processus de réconciliation doit gérer ce cas en production
  }

  return {
    amount: input.amount,
    fee,
    net_sent: netAmount,
    new_balance: result.new_balance,
    phone: input.phone,
  };
}

// ─── Pay order with wallet ────────────────────────────────────────────────────

export async function payOrderWithWallet(input: {
  userId: string;
  orderId: string;
  amount: number;
}) {
  const { data: wallet } = await supabase
    .from("user_wallets")
    .select("id, balance")
    .eq("user_id", input.userId)
    .maybeSingle();

  if (!wallet) throw new AppError(404, "WALLET_NOT_FOUND", "Vous n'avez pas de wallet actif");

  const { data: result } = await supabase.rpc("user_wallet_pay_order", {
    p_wallet_id: wallet.id,
    p_amount: input.amount,
    p_order_id: input.orderId,
  });

  if (!result?.success) {
    if (result?.error === "INSUFFICIENT_BALANCE") {
      throw new AppError(400, "INSUFFICIENT_BALANCE",
        `Solde insuffisant. Veuillez ajouter ${Math.ceil(result.missing)} FCFA pour valider ce panier.`);
    }
    throw new AppError(500, "PAYMENT_ERROR", "Échec du paiement");
  }

  return result;
}

// ─── Verify PIN ───────────────────────────────────────────────────────────────

export async function verifyPin(walletId: string, pin: string): Promise<boolean> {
  const { data } = await supabase
    .from("user_wallets")
    .select("pin_hash")
    .eq("id", walletId)
    .single();
  if (!data) return false;
  return bcrypt.compare(pin, data.pin_hash);
}

// ─── Transaction history ──────────────────────────────────────────────────────

export async function getTransactions(walletId: string, page = 1, limit = 20) {
  const from = (page - 1) * limit;
  const { data, count } = await supabase
    .from("user_wallet_transactions")
    .select("*", { count: "exact" })
    .eq("wallet_id", walletId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  return {
    transactions: data ?? [],
    pagination: {
      page, limit,
      total: count ?? 0,
      total_pages: Math.ceil((count ?? 0) / limit),
    },
  };
}

// ─── Shared cart ──────────────────────────────────────────────────────────────

export async function createSharedCart(input: {
  ownerId: string;
  ownerName: string;
  branchId: string;
  branchName: string;
  items: Array<{ product_id: string; product_name: string; unit_price: number; quantity: number }>;
  orderType: "collect" | "delivery";
  promoId?: string | null;
  promoCode?: string | null;
  promoPct?: number | null;
  subtotal: number;
  discountAmount: number;
  totalAmount: number;
}) {
  const { data, error } = await supabase
    .from("shared_carts")
    .insert({
      owner_id: input.ownerId,
      owner_name: input.ownerName,
      branch_id: input.branchId,
      branch_name: input.branchName,
      items: input.items,
      order_type: input.orderType,
      promo_id: input.promoId ?? null,
      promo_code: input.promoCode ?? null,
      promo_pct: input.promoPct ?? null,
      subtotal: input.subtotal,
      discount_amount: input.discountAmount,
      total_amount: input.totalAmount,
    })
    .select("token, expires_at")
    .single();

  if (error || !data) throw new AppError(500, "SHARED_CART_ERROR", "Impossible de créer le lien de partage");
  return data;
}

export async function getSharedCart(token: string) {
  const { data } = await supabase
    .from("shared_carts")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (!data) throw new AppError(404, "NOT_FOUND", "Ce lien de panier est invalide ou a expiré");
  if (data.status !== "pending") throw new AppError(410, "CART_PAID", "Ce panier a déjà été payé");
  if (new Date(data.expires_at) < new Date()) {
    await supabase.from("shared_carts").update({ status: "expired" }).eq("id", data.id);
    throw new AppError(410, "CART_EXPIRED", "Ce lien de panier a expiré");
  }
  return data;
}

// ─── Commission wallet (superadmin) ──────────────────────────────────────────

export async function getCommissionWallet() {
  const { data } = await supabase.from("commission_wallet").select("*").single();
  return data;
}

export async function getCommissionTransactions(page = 1, limit = 50) {
  const from = (page - 1) * limit;
  const { data, count } = await supabase
    .from("user_wallet_transactions")
    .select("*, user:user_id(name, email)", { count: "exact" })
    .in("type", ["withdrawal", "transfer_out"])
    .gt("fee_amount", 0)
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  return {
    transactions: data ?? [],
    pagination: { page, limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limit) },
  };
}

export async function getAllUserTransactions(page = 1, limit = 50, type?: string) {
  const from = (page - 1) * limit;
  let query = supabase
    .from("user_wallet_transactions")
    .select("*, wallet:wallet_id(card_number, card_name), user:user_id(name, email)", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + limit - 1);

  if (type) query = query.eq("type", type);

  const { data, count } = await query;
  return {
    transactions: data ?? [],
    pagination: { page, limit, total: count ?? 0, total_pages: Math.ceil((count ?? 0) / limit) },
  };
}
