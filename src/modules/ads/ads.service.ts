import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { campayCollect, campayTransactionStatus, campayWithdraw } from "../../services/campay.js";

const PRICE_PER_UNIT = 10;
const USERS_PER_UNIT = 6;

export function calculateAdPrice(targetCount: number): number {
  return Math.ceil(targetCount / USERS_PER_UNIT) * PRICE_PER_UNIT;
}

// ─── Admin : initier le paiement d'une pub via Campay ───────────────────────
export async function initiateAdPayment(brandId: string, input: {
  title: string;
  image_url: string;
  target_count: number;
  payment_phone: string;
  payment_method: string;
}) {
  const { title, image_url, target_count, payment_phone, payment_method } = input;
  const amount = calculateAdPrice(target_count);

  // Déclencher le USSD push Campay
  let campayData;
  try {
    campayData = await campayCollect({
      amount,
      phone: payment_phone,
      description: `DashMeal Pub "${title}" — ${target_count} utilisateurs`,
      externalReference: `ad_${brandId.slice(0, 8)}_${Date.now()}`,
      paymentMethod: payment_method,
    });
  } catch (err) {
    throw err; // remonte vers le errorHandler (AppError de campayCollect)
  }

  // Stocker l'intention de paiement
  const { data, error } = await supabase
    .from("ad_payment_intents")
    .insert({
      brand_id: brandId,
      title,
      image_url,
      target_count,
      amount,
      campay_reference: campayData.reference,
      payment_phone,
    })
    .select()
    .single();

  if (error || !data) throw new AppError(500, "DB_ERROR", error?.message ?? "Erreur ad_payment_intents");

  return {
    intent_id: data.id,
    reference: campayData.reference,
    ussd_code: campayData.ussd_code ?? null,
    operator: campayData.operator ?? null,
    amount,
  };
}

// ─── Admin : vérifier le statut du paiement (polling) ───────────────────────
export async function pollAdPaymentStatus(reference: string) {
  const { data: intent } = await supabase
    .from("ad_payment_intents")
    .select("*")
    .eq("campay_reference", reference)
    .single();

  if (!intent) throw new AppError(404, "NOT_FOUND", "Référence introuvable");

  // Intent déjà traité
  if (intent.status === "paid")    return { status: "paid",    ad_id: intent.ad_id };
  if (intent.status === "failed")  return { status: "failed" };
  if (intent.status === "expired") return { status: "failed" };

  // Intent expiré
  if (new Date(intent.expires_at) < new Date()) {
    await supabase.from("ad_payment_intents").update({ status: "expired" }).eq("id", intent.id);
    return { status: "failed" };
  }

  // Interroger Campay
  let campayData;
  try {
    campayData = await campayTransactionStatus(reference);
  } catch {
    return { status: "pending" };
  }

  if (campayData.status === "SUCCESSFUL") {
    // 1. Créditer le wallet plateforme en premier (si ça échoue, on n'a rien créé)
    const { error: walletErr } = await supabase.rpc("credit_platform_wallet_for_ad", {
      p_amount: intent.amount,
      p_brand_id: intent.brand_id,
      p_description: `Pub "${intent.title}" - ${intent.target_count} utilisateurs`,
    });
    if (walletErr) {
      console.error("[Ads] credit_platform_wallet_for_ad error:", walletErr);
      throw new AppError(500, "WALLET_ERROR", `Wallet plateforme : ${walletErr.message}`);
    }

    // 2. Créer la pub en statut "pending"
    const { data: newAd, error: adErr } = await supabase
      .from("ads")
      .insert({
        brand_id: intent.brand_id,
        title: intent.title,
        image_url: intent.image_url,
        target_count: intent.target_count,
        amount_paid: intent.amount,
        status: "pending",
      })
      .select("id")
      .single();

    if (adErr || !newAd) {
      console.error("[Ads] ad insert error:", adErr);
      throw new AppError(500, "DB_ERROR", `Création pub : ${adErr?.message ?? "no data"}`);
    }

    // 3. Marquer l'intent comme traité
    await supabase.from("ad_payment_intents")
      .update({ status: "paid", ad_id: newAd.id })
      .eq("id", intent.id);

    return { status: "paid", ad_id: newAd.id };
  }

  if (campayData.status === "FAILED") {
    await supabase.from("ad_payment_intents").update({ status: "failed" }).eq("id", intent.id);
    return { status: "failed" };
  }

  return { status: "pending" };
}

// ─── Admin : lister ses pubs ─────────────────────────────────────────────────
export async function getAdsByBrand(brandId: string) {
  const { data, error } = await supabase
    .from("ads")
    .select("*")
    .eq("brand_id", brandId)
    .order("created_at", { ascending: false });

  if (error) throw new AppError(500, "DB_ERROR", error.message);
  return data ?? [];
}

// ─── Admin : supprimer une pub (pas de remboursement — argent dans wallet plateforme) ──
export async function deleteAd(adId: string, brandId: string) {
  const { data: ad } = await supabase
    .from("ads")
    .select("id, status, brand_id")
    .eq("id", adId)
    .eq("brand_id", brandId)
    .single();

  if (!ad) throw new AppError(404, "NOT_FOUND", "Pub introuvable");
  if (ad.status === "active") throw new AppError(400, "CANNOT_DELETE", "Impossible de supprimer une pub active");

  await supabase.from("ads").delete().eq("id", adId);
  return { deleted: true };
}

// ─── Superadmin : lister toutes les pubs ────────────────────────────────────
export async function getAllAds(status?: string | null) {
  let query = supabase
    .from("ads")
    .select("*, brands(id, name, logo_url)")
    .order("created_at", { ascending: false });

  if (status && status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) throw new AppError(500, "DB_ERROR", error.message);
  return data ?? [];
}

// ─── Superadmin : approuver ───────────────────────────────────────────────────
export async function approveAd(adId: string, superAdminId: string) {
  const { data, error } = await supabase
    .from("ads")
    .update({
      status: "active",
      reviewed_by: superAdminId,
      reviewed_at: new Date().toISOString(),
      activated_at: new Date().toISOString(),
    })
    .eq("id", adId)
    .eq("status", "pending")
    .select()
    .single();

  if (error || !data) throw new AppError(404, "NOT_FOUND", "Pub introuvable ou déjà traitée");
  return data;
}

// ─── Superadmin : rejeter (l'argent reste dans le wallet plateforme) ─────────
export async function rejectAd(adId: string, superAdminId: string, reason: string) {
  const { data, error } = await supabase
    .from("ads")
    .update({
      status: "rejected",
      rejection_reason: reason,
      reviewed_by: superAdminId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", adId)
    .eq("status", "pending")
    .select()
    .single();

  if (error || !data) throw new AppError(404, "NOT_FOUND", "Pub introuvable ou déjà traitée");
  return data;
}

// ─── Superadmin : retrait du wallet plateforme vers téléphone ────────────────
export async function platformWithdraw(amount: number, phone: string) {
  const description = `Retrait superadmin — ${amount.toLocaleString("fr-FR")} FCFA`;
  let campayRef: string;

  try {
    const res = await campayWithdraw({
      amount,
      phone,
      description,
      externalReference: `platform_withdrawal_${Date.now()}`,
    });
    campayRef = res.reference;
  } catch (err) {
    throw err;
  }

  const { error } = await supabase.rpc("process_platform_withdrawal", {
    p_amount: amount,
    p_campay_reference: campayRef,
    p_description: description,
  });

  if (error) {
    if (error.message.includes("INSUFFICIENT_BALANCE"))
      throw new AppError(422, "INSUFFICIENT_BALANCE", "Solde plateforme insuffisant");
    throw new AppError(500, "DB_ERROR", error.message);
  }

  return { campay_reference: campayRef, amount };
}

// ─── Mobile : récupérer une pub non vue ──────────────────────────────────────
export async function getAdForUser(userId: string) {
  const { data, error } = await supabase.rpc("get_ad_for_user", { p_user_id: userId });
  if (error) return null;
  return (data as any[])?.[0] ?? null;
}

// ─── Mobile : enregistrer une impression ─────────────────────────────────────
export async function recordImpression(adId: string, userId: string) {
  const { error } = await supabase.rpc("record_ad_impression", { p_ad_id: adId, p_user_id: userId });
  if (error) throw new AppError(500, "DB_ERROR", "Erreur impression");
  return { ok: true };
}
