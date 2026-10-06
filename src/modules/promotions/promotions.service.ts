import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";

export interface ResolvedPromotion {
  promotion_id: string;
  type: "percent" | "fixed";
  value: number;
  discount: number;
}

// ─── Validation d'un code promo + calcul de la réduction ─────────────────────
// Lève une AppError si le code est invalide. Partagé entre /promotions/validate
// et la création de commande.
export async function resolvePromotion(params: {
  code: string;
  orderTotal: number;
  userId: string;
  branchId?: string;
  brandId?: string;
}): Promise<ResolvedPromotion> {
  const { code, orderTotal, userId, branchId, brandId } = params;
  const now = new Date().toISOString();

  // Récupérer la promotion
  let query = supabase
    .from("promotions")
    .select("*")
    .eq("code", code.trim().toUpperCase())
    .eq("is_active", true);

  // Les codes ne sont uniques qu'au sein d'une marque
  if (brandId) query = query.eq("brand_id", brandId);

  const { data: promo, error } = await query.maybeSingle();

  if (error) throw new AppError(500, "DB_ERROR", error.message);
  if (!promo) throw new AppError(404, "PROMO_NOT_FOUND", "Code promotionnel invalide");

  // Vérifier expiration
  if (promo.expires_at && promo.expires_at < now) {
    throw new AppError(422, "PROMO_EXPIRED", "Ce code promotionnel a expiré");
  }

  // Vérifier date de début
  if (promo.starts_at && promo.starts_at > now) {
    throw new AppError(422, "PROMO_NOT_STARTED", "Ce code promotionnel n'est pas encore actif");
  }

  // Vérifier restriction d'agence
  if (promo.branch_id && branchId && promo.branch_id !== branchId) {
    throw new AppError(422, "PROMO_BRANCH_MISMATCH", "Ce code n'est pas valable pour cette agence");
  }

  // Vérifier montant minimum
  if (promo.min_order && orderTotal < Number(promo.min_order)) {
    throw new AppError(422, "PROMO_MIN_ORDER", `Montant minimum requis: ${promo.min_order} FCFA`);
  }

  // Vérifier nombre max d'utilisations global
  if (promo.max_uses !== null && Number(promo.uses_count) >= Number(promo.max_uses)) {
    throw new AppError(422, "PROMO_MAX_USES", "Ce code promotionnel a atteint son nombre maximum d'utilisations");
  }

  // Vérifier utilisations par utilisateur
  if (promo.max_uses_per_user !== null) {
    const { count } = await supabase
      .from("promotion_usages")
      .select("id", { count: "exact", head: true })
      .eq("promotion_id", promo.id)
      .eq("user_id", userId);

    if ((count ?? 0) >= Number(promo.max_uses_per_user)) {
      throw new AppError(422, "PROMO_USER_LIMIT", "Vous avez déjà utilisé ce code le nombre maximum de fois autorisé");
    }
  }

  // Calculer la réduction
  const discount = promo.type === "percent"
    ? Math.round(orderTotal * Number(promo.value) / 100)
    : Math.min(Number(promo.value), orderTotal);

  return {
    promotion_id: promo.id,
    type: promo.type,
    value: promo.value,
    discount,
  };
}

// ─── Enregistrer l'utilisation d'une promotion sur une commande ──────────────
export async function recordPromotionUsage(promotionId: string, orderId: string, userId: string) {
  const { data: promo, error: promoErr } = await supabase
    .from("promotions")
    .select("id, uses_count")
    .eq("id", promotionId)
    .eq("is_active", true)
    .maybeSingle();

  if (promoErr) throw new AppError(500, "DB_ERROR", promoErr.message);
  if (!promo) throw new AppError(404, "PROMO_NOT_FOUND", "Promotion introuvable");

  // Insérer usage
  const { error: usageErr } = await supabase
    .from("promotion_usages")
    .insert({ promotion_id: promotionId, order_id: orderId, user_id: userId, used_at: new Date().toISOString() });

  if (usageErr) throw new AppError(500, "DB_ERROR", usageErr.message);

  // Incrémenter uses_count
  await supabase
    .from("promotions")
    .update({ uses_count: Number(promo.uses_count) + 1 })
    .eq("id", promotionId);
}
