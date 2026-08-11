/**
 * Stale Order Notifier
 *
 * Tourne toutes les 5 minutes. Si une commande est dans un état "actif"
 * depuis plus de STALE_THRESHOLD_MS sans changement, l'utilisateur reçoit
 * une notification push.
 *
 * Anti-spam : on maintient un Map en mémoire (orderId_status → timestamp)
 * ET on vérifie la table notifications en base pour survivre aux redémarrages.
 * Le cooldown minimum entre deux notifications pour le même (orderId, status)
 * est NOTIF_COOLDOWN_MS (2h).
 *
 * Premier check 5 min après le démarrage (pas au démarrage lui-même) pour
 * éviter de noyer l'utilisateur lors d'un redémarrage rapide du serveur.
 */

import { supabase } from "../config/supabase.js";
import { notifyUser } from "../utils/push.js";

const STALE_THRESHOLD_MS = 15 * 60 * 1000;       // commande figée depuis 15 min
const STALE_MAX_AGE_MS   = 24 * 60 * 60 * 1000;  // ignorer commandes > 24h (abandonnées)
const CHECK_INTERVAL_MS  =  5 * 60 * 1000;        // vérifier toutes les 5 min
const NOTIF_COOLDOWN_MS  =  2 * 60 * 60 * 1000;   // pas de re-notif avant 2h
const ACTIVE_STATUSES    = ["pending", "confirmed", "preparing", "delivering"];
// "ready" exclu volontairement : l'admin envoie déjà une notif au changement de statut

const STALE_MESSAGES: Record<string, { title: string; body: string }> = {
  pending:    { title: "Commande en attente ⏳",        body: "Votre commande attend toujours confirmation. Nous vérifions avec l'agence." },
  confirmed:  { title: "Préparation imminente 🍽️",      body: "Votre commande confirmée va bientôt être préparée." },
  preparing:  { title: "Toujours en préparation 👨‍🍳",   body: "La préparation prend un peu plus de temps que prévu. Merci de votre patience." },
  delivering: { title: "Livreur en route 🛵",            body: "Votre livreur est encore en chemin." },
};

// ── Déduplication en mémoire (rapide, survit pas au redémarrage) ─────────────
// Clé : `${orderId}_${status}`, valeur : timestamp de la dernière notif
const notifiedInSession = new Map<string, number>();

async function wasRecentlyNotified(orderId: string, status: string): Promise<boolean> {
  const key = `${orderId}_${status}`;
  const now = Date.now();

  // 1. Check mémoire (plus rapide, évite les requêtes DB)
  const inMemory = notifiedInSession.get(key);
  if (inMemory && now - inMemory < NOTIF_COOLDOWN_MS) return true;

  // 2. Check DB pour les notifs envoyées lors de sessions précédentes
  const since = new Date(now - NOTIF_COOLDOWN_MS).toISOString();
  const { data } = await supabase
    .from("notifications")
    .select("id")
    .eq("type", "stale_order")
    .gte("created_at", since)
    // Filtrer sur le titre plutôt que sur data JSONB pour éviter les problèmes
    // de sérialisation. On encode orderId dans le champ `body` avec un préfixe.
    .ilike("body", `%[${orderId.slice(0, 8).toUpperCase()}]%`)
    .limit(1)
    .maybeSingle();

  return !!data;
}

function markNotified(orderId: string, status: string) {
  notifiedInSession.set(`${orderId}_${status}`, Date.now());
}

async function checkStaleOrders() {
  const threshold   = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  const maxAge      = new Date(Date.now() - STALE_MAX_AGE_MS).toISOString();

  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, user_id, status, updated_at")
    .in("status", ACTIVE_STATUSES)
    .lt("updated_at", threshold)
    .gt("updated_at", maxAge); // ignorer les commandes abandonnées depuis plus de 24h

  if (error) {
    console.error("[StaleNotifier] Erreur récupération commandes:", error.message);
    return;
  }

  if (!orders || orders.length === 0) return;

  console.log(`[StaleNotifier] ${orders.length} commande(s) figée(s) détectée(s)`);

  for (const order of orders) {
    const msg = STALE_MESSAGES[order.status];
    if (!msg) continue;

    const alreadyNotified = await wasRecentlyNotified(order.id, order.status);
    if (alreadyNotified) continue;

    const orderRef = order.id.slice(0, 8).toUpperCase();
    const body = `[${orderRef}] — ${msg.body}`;

    await notifyUser(
      order.user_id,
      msg.title,
      body,
      { screen: "order", orderId: order.id, type: "stale_order" }
    );

    markNotified(order.id, order.status);

    // Persister en DB pour survivre aux redémarrages
    await supabase.from("notifications").insert({
      user_id: order.user_id,
      title:   msg.title,
      body,
      type:    "stale_order",
      data:    { orderId: order.id, status: order.status },
      is_read: false,
    }).then(() => {});

    console.log(`[StaleNotifier] Notifié ${order.user_id} — commande #${orderRef} figée en "${order.status}"`);
  }
}

export function startStaleOrderNotifier() {
  console.log("[StaleNotifier] Démarré — premier check dans 5 min, puis toutes les 5 min");
  // Délai initial de 5 min pour ne pas envoyer de notifs au redémarrage du serveur
  setTimeout(() => {
    checkStaleOrders();
    setInterval(checkStaleOrders, CHECK_INTERVAL_MS);
  }, CHECK_INTERVAL_MS);
}
