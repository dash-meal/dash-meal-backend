import { supabase } from "../config/supabase.js";
import { AppError } from "../middleware/errorHandler.js";

interface StockItem {
  product_id: string;
  quantity: number;
}

/**
 * Décrémente le stock plateforme (branch_stock) pour une commande qui vient
 * d'être créée. Tout ou rien côté RPC : si un article suivi n'a pas assez de
 * stock alloué, rien n'est décrémenté.
 *
 * Les produits sans ligne branch_stock ne sont pas suivis et n'empêchent
 * jamais la commande (compatibilité avec les agences qui ne font pas encore
 * de suivi de stock).
 *
 * `deleteOnFailure` (défaut true) supprime la commande (cascade order_items)
 * quand le stock est insuffisant — correct pour une commande pas encore
 * payée. À mettre à `false` pour une commande créée APRÈS un paiement en
 * ligne déjà encaissé (ex: createOrderFromIntent) : le client a payé, on ne
 * peut pas faire disparaître sa commande — l'incident est loggé pour
 * réconciliation manuelle plutôt que de bloquer/supprimer.
 */
export async function reservePlatformStock(
  branch_id: string,
  order_id: string,
  items: StockItem[],
  options: { deleteOnFailure?: boolean } = {}
): Promise<void> {
  const { deleteOnFailure = true } = options;

  const { error } = await supabase.rpc("reserve_platform_stock", {
    p_branch_id: branch_id,
    p_order_id:  order_id,
    p_items:     items.map((i) => ({ product_id: i.product_id, quantity: i.quantity })),
  });

  if (!error) return;

  const insufficientStock = error.message?.startsWith("INSUFFICIENT_STOCK");

  if (!insufficientStock) {
    console.error("[reservePlatformStock] Erreur RPC:", error.message);
    if (deleteOnFailure) await supabase.from("orders").delete().eq("id", order_id);
    throw new AppError(500, "STOCK_RESERVATION_ERROR", "Échec de la réservation du stock");
  }

  if (!deleteOnFailure) {
    // Commande déjà payée : on ne la supprime pas, on log pour réconciliation manuelle.
    console.error(`[reservePlatformStock] Stock insuffisant sur commande déjà payée order_id=${order_id} — vente en survente, réconciliation manuelle requise`);
    return;
  }

  await supabase.from("orders").delete().eq("id", order_id);
  throw new AppError(409, "INSUFFICIENT_STOCK", "Un ou plusieurs articles ne sont plus disponibles en quantité suffisante");
}
