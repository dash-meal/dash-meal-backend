import { supabase } from "../config/supabase.js";

// ─── Types Expo Push ──────────────────────────────────────────────────────────

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default" | null;
  badge?: number;
  priority?: "default" | "normal" | "high";
  channelId?: string;
}

// ─── Envoi bas niveau vers l'API Expo ─────────────────────────────────────────

async function sendToExpo(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return;

  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });

    const result = await response.json() as { data?: { status: string; id?: string; message?: string; details?: unknown }[] };

    if (!response.ok) {
      console.error(`[Push] Expo API error (${response.status}):`, JSON.stringify(result));
      return;
    }

    // Expo renvoie { data: [{ status: "ok"|"error", ... }] } même en HTTP 200
    result.data?.forEach((r, i) => {
      if (r.status === "error") {
        console.error(`[Push] Message ${i} rejeté par Expo:`, r.message, r.details ?? "");
      } else {
        console.log(`[Push] Message ${i} envoyé OK (id: ${r.id ?? "—"})`);
      }
    });
  } catch (err) {
    // Ne jamais faire crasher l'app pour une notif ratée
    console.error("[Push] Network error:", err);
  }
}

// ─── Notifier un utilisateur (tous ses appareils enregistrés) ─────────────────

export async function notifyUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>
): Promise<void> {
  const { data: tokens, error } = await supabase
    .from("push_tokens")
    .select("token")
    .eq("user_id", userId);

  if (error) {
    console.error(`[Push] Erreur récupération tokens pour user ${userId}:`, error.message);
    return;
  }

  if (!tokens || tokens.length === 0) {
    console.log(`[Push] Aucun token pour user ${userId} — notification ignorée`);
    return;
  }

  console.log(`[Push] Envoi notif à user ${userId} (${tokens.length} appareil(s)): "${title}"`);

  const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
    to: token,
    title,
    body,
    data,
    sound: "default",
    priority: "high",
    channelId: "default",
  }));

  await sendToExpo(messages);
}

// ─── Messages prédéfinis par statut de commande ───────────────────────────────

export async function notifyOrderStatus(
  userId: string,
  orderId: string,
  status: string,
  orderRef?: string
): Promise<void> {
  const ref = orderRef ? `#${orderRef.slice(0, 8).toUpperCase()}` : "";
  const data = { orderId, screen: "order", type: "order_status" };

  const MESSAGES: Record<string, { title: string; body: string }> = {
    confirmed: {
      title: "Commande confirmée ✅",
      body: `Votre commande ${ref} a été confirmée. Nous la préparons dès maintenant.`,
    },
    preparing: {
      title: "En préparation 👨‍🍳",
      body: `Votre commande ${ref} est en cours de préparation.`,
    },
    ready: {
      title: "Prête à retirer ! 🎉",
      body: `Votre commande ${ref} est prête. Venez la récupérer en agence.`,
    },
    delivering: {
      title: "En cours de livraison 🛵",
      body: `Votre commande ${ref} est en route vers vous !`,
    },
    delivered: {
      title: "Livraison effectuée 🏠",
      body: `Votre commande ${ref} a été livrée. Bon appétit !`,
    },
    cancelled: {
      title: "Commande annulée ❌",
      body: `Votre commande ${ref} a été annulée.`,
    },
  };

  const msg = MESSAGES[status];
  if (!msg) return;

  await notifyUser(userId, msg.title, msg.body, data);
}

// ─── Notifier tous les livreurs actifs d'une marque ─────────────────────────

export async function notifyDriversNewDelivery(
  brandId: string,
  deliveryId: string,
  address: string,
): Promise<void> {
  const { data: drivers } = await supabase
    .from("drivers")
    .select("push_token")
    .eq("brand_id", brandId)
    .eq("is_active", true)
    .not("push_token", "is", null);

  if (!drivers || drivers.length === 0) return;

  const tokens = drivers.map((d) => d.push_token as string).filter(Boolean);
  if (tokens.length === 0) return;

  console.log(`[Push] Nouvelle livraison → ${tokens.length} livreur(s) de la marque ${brandId}`);

  const messages: ExpoPushMessage[] = tokens.map((token) => ({
    to: token,
    title: "Nouvelle livraison disponible 📦",
    body: `Adresse : ${address}`,
    data: { deliveryId, screen: "delivery", type: "new_delivery" },
    sound: "default",
    priority: "high",
    channelId: "default",
  }));

  await sendToExpo(messages);
}

export async function notifyPaymentFailed(
  userId: string,
  orderId: string,
  orderRef?: string
): Promise<void> {
  const ref = orderRef ? `#${orderRef.slice(0, 8).toUpperCase()}` : "";
  await notifyUser(
    userId,
    "Paiement échoué ❌",
    `Le paiement de la commande ${ref} a échoué. Vérifiez votre solde et réessayez.`,
    { orderId, screen: "order", type: "payment_failed" }
  );
}
