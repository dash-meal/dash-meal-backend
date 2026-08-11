import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import { COMMISSION_RATE_ONLINE, COMMISSION_RATE_INPERSON } from "../../shared/index.js";
import {
  campayCollect,
  campayTransactionStatus,
  campayBalance,
} from "../../services/campay.js";
import { notifyOrderStatus, notifyPaymentFailed } from "../../utils/push.js";
import { generateQrCode } from "../../utils/qrcode.js";

// ─── Initier un paiement AVANT création de commande ─────────────────────────
// Flux : initier CamPay → USSD push → user confirme PIN → poll status → créer commande

export async function initiateOrderPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const user_id = req.user!.id;
    const {
      branch_id, type, items,
      slot_id, delivery_address, delivery_lat, delivery_lng, delivery_phone,
      payment_method, payment_phone, notes,
    } = req.body;

    // ── Calculer le total depuis les produits ─────────────────────────────────
    let subtotal = 0;
    const orderItems: Array<{ product_id: string; quantity: number; unit_price: number; subtotal: number }> = [];

    for (const item of items as Array<{ product_id: string; quantity: number }>) {
      const { data: product } = await supabase
        .from("products")
        .select("price")
        .eq("id", item.product_id)
        .single();

      if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND", `Produit introuvable: ${item.product_id}`);

      // Number() force la conversion si Supabase retourne la valeur comme string (colonne NUMERIC)
      const unit_price = Number(product.price);
      if (isNaN(unit_price)) throw new AppError(500, "INVALID_PRICE", `Prix invalide pour le produit ${item.product_id}`);
      const sub = unit_price * item.quantity;
      subtotal += sub;
      orderItems.push({ product_id: item.product_id, quantity: item.quantity, unit_price, subtotal: sub });
    }

    const delivery_fee = type === "delivery" ? 5 : 0;
    const total = subtotal + delivery_fee;

    console.log(`[CamPay] Préparation paiement — total: ${total} XAF, articles: ${orderItems.length}`);

    // ── 1. Stocker les données de commande D'ABORD ───────────────────────────
    // → si CamPay échoue ensuite, l'intent est supprimé (pas d'USSD orphelin)
    const orderData = {
      branch_id, type, subtotal, delivery_fee, total, notes: notes ?? null,
      payment_method,
      items: orderItems,
      ...(type === "collect" ? { slot_id } : {
        delivery_address,
        delivery_lat: delivery_lat ?? null,
        delivery_lng: delivery_lng ?? null,
        delivery_phone: delivery_phone ?? null,
      }),
    };

    const { data: intent, error: intentErr } = await supabase
      .from("payment_intents")
      .insert({
        user_id,
        reference: `pending_${user_id.slice(0, 8)}_${Date.now()}`, // temporaire
        amount: Math.round(total),
        status: "pending",
        order_data: orderData,
      })
      .select()
      .single();

    if (intentErr || !intent) {
      throw new AppError(500, "INTENT_ERROR", "Impossible de préparer la commande. Réessayez.");
    }

    // ── 2. Appeler CamPay (USSD push envoyé au téléphone) ────────────────────
    let campayData;
    try {
      console.log(`[CamPay] Envoi USSD push — total: ${Math.round(total)} XAF, téléphone: ${payment_phone}`);
      campayData = await campayCollect({
        amount: Math.round(total),
        phone: payment_phone,
        description: `DashMeal commande`,
        externalReference: intent.id,
        paymentMethod: payment_method,
      });
    } catch (campayErr) {
      // CamPay a échoué → supprimer l'intent pour ne pas bloquer l'utilisateur
      await supabase.from("payment_intents").delete().eq("id", intent.id);
      throw campayErr; // remonte vers le handler d'erreur Express
    }

    // ── 3. Mettre à jour l'intent avec la vraie référence CamPay ─────────────
    await supabase.from("payment_intents")
      .update({
        reference: campayData.reference,
        ussd_code: campayData.ussd_code ?? null,
        operator: campayData.operator ?? null,
      })
      .eq("id", intent.id);

    sendCreated(res, {
      reference: campayData.reference,
      ussd_code: campayData.ussd_code ?? null,
      operator: campayData.operator ?? null,
      total,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Initier un paiement Mobile Money (commande existante) ───────────────────

export async function initiatePayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { order_id, method, phone } = req.body;

    // Vérifier que la commande appartient à l'utilisateur
    const { data: order } = await supabase
      .from("orders")
      .select("id, total, user_id, branch_id, branches(brand_id)")
      .eq("id", order_id)
      .single();

    if (!order || order.user_id !== req.user!.id) {
      throw new AppError(404, "NOT_FOUND", "Commande introuvable");
    }

    if (method === "mobile_money" || method === "orange_money" || method === "mtn_mobile_money") {
      if (!phone) throw new AppError(400, "PHONE_REQUIRED", "Numéro de téléphone requis");

      const campayData = await campayCollect({
        amount: order.total,
        phone,
        description: `DashMeal #${order_id.slice(0, 8)}`,
        externalReference: order_id,
        paymentMethod: method,
      });

      const { data: payment } = await supabase
        .from("payments")
        .insert({
          order_id,
          method,
          amount: order.total,
          status: "pending",
          provider_ref: campayData.reference,
          provider: "campay",
          operator: campayData.operator ?? null,
        })
        .select()
        .single();

      sendCreated(res, {
        payment,
        reference: campayData.reference,
        ussd_code: campayData.ussd_code ?? null,
        operator: campayData.operator ?? null,
      });
    } else if (method === "wallet") {
      throw new AppError(501, "NOT_IMPLEMENTED", "Paiement par portefeuille bientôt disponible");
    } else {
      throw new AppError(400, "INVALID_METHOD", "Méthode de paiement invalide");
    }
  } catch (err) {
    next(err);
  }
}

// ─── Polling statut en temps réel ────────────────────────────────────────────
// Gère deux cas :
//  1. Payment intent (nouveau flux) : commande pas encore créée
//  2. Payment lié à une commande existante (ancien flux / webhook)

export async function getPaymentStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const reference = req.params.reference as string;

    // ── Chercher d'abord dans les payment_intents (nouveau flux) ─────────────
    const { data: intent } = await supabase
      .from("payment_intents")
      .select("*")
      .eq("reference", reference)
      .single();

    if (intent) {
      // Commande déjà créée lors d'un poll précédent
      if (intent.status === "paid" && intent.order_id) {
        return sendSuccess(res, { status: "paid", order_id: intent.order_id, operator: intent.operator });
      }
      if (intent.status === "failed") {
        return sendSuccess(res, { status: "failed" });
      }
      // Création en cours par un autre poll — attendre
      if (intent.status === "processing") {
        return sendSuccess(res, { status: "pending" });
      }

      // Intent expiré
      if (new Date(intent.expires_at) < new Date()) {
        await supabase.from("payment_intents").update({ status: "expired" }).eq("id", intent.id);
        return sendSuccess(res, { status: "failed" });
      }

      // Toujours pending → interroger CamPay
      let campayData;
      try {
        campayData = await campayTransactionStatus(reference);
      } catch (campayErr) {
        // Erreur réseau vers CamPay uniquement → on retente au prochain poll
        console.error("[Poll] Erreur réseau CamPay:", campayErr);
        return sendSuccess(res, { status: "pending" });
      }

      if (campayData.status === "SUCCESSFUL") {
        // ── Verrou atomique : seul le premier poll qui passe "pending" → "processing" crée la commande
        const { data: claimed } = await supabase
          .from("payment_intents")
          .update({ status: "processing" })
          .eq("id", intent.id)
          .eq("status", "pending")
          .select("id")
          .single();

        if (!claimed) {
          // Un autre poll a déjà verrouillé — attendre que l'order_id soit disponible
          const { data: latest } = await supabase
            .from("payment_intents")
            .select("status, order_id, operator")
            .eq("id", intent.id)
            .single();
          if (latest?.status === "paid" && latest.order_id) {
            return sendSuccess(res, { status: "paid", order_id: latest.order_id, operator: latest.operator });
          }
          return sendSuccess(res, { status: "pending" });
        }

        const d = intent.order_data as Record<string, unknown>;
        console.log(`[Poll] Paiement SUCCESSFUL pour intent ${intent.id}, création commande...`);
        const order_id = await createOrderFromIntent(intent.user_id, intent.id, campayData.operator, d);
        console.log(`[Poll] Commande créée : ${order_id}`);

        notifyOrderStatus(intent.user_id, order_id, "confirmed", order_id).catch(() => {});
        return sendSuccess(res, { status: "paid", order_id, operator: campayData.operator });
      }

      if (campayData.status === "FAILED") {
        await supabase.from("payment_intents").update({ status: "failed" }).eq("id", intent.id);
        notifyPaymentFailed(intent.user_id, "", reference).catch(() => {});
        return sendSuccess(res, { status: "failed" });
      }

      return sendSuccess(res, { status: "pending" });
    }

    // ── Fallback : chercher dans payments (commande existante) ───────────────
    const { data: payment } = await supabase
      .from("payments")
      .select("id, status, order_id, amount, operator, orders(branch_id, branches(brand_id))")
      .eq("provider_ref", reference)
      .single();

    if (!payment) throw new AppError(404, "NOT_FOUND", "Référence de paiement introuvable");

    if (payment.status === "pending") {
      try {
        const campayData = await campayTransactionStatus(reference);

        if (campayData.status === "SUCCESSFUL") {
          await supabase.from("payments").update({ status: "paid", operator: campayData.operator })
            .eq("provider_ref", reference);
          const { data: updatedOrder } = await supabase
            .from("orders").update({ status: "confirmed" })
            .eq("id", payment.order_id).select("id, user_id").single();

          const orderData = payment.orders as unknown as { branch_id: string; branches: { brand_id: string } };
          const branchId = orderData?.branch_id;
          const brandId  = orderData?.branches?.brand_id;
          if (branchId && brandId) {
            await supabase.rpc("credit_branch_wallet", {
              p_branch_id:   branchId,
              p_brand_id:    brandId,
              p_amount:      payment.amount,
              p_payment_id:  payment.id,
              p_order_id:    payment.order_id,
              p_description: `Commande #${String(payment.order_id).slice(0, 8)} — paiement en ligne`,
            }).then(({ error }) => { if (error) console.error("[poll] wallet credit:", error.message); });
          }

          if (updatedOrder?.user_id) {
            notifyOrderStatus(updatedOrder.user_id, payment.order_id, "confirmed", payment.order_id).catch(() => {});
          }
          return sendSuccess(res, { status: "paid", order_id: payment.order_id, operator: campayData.operator });
        }

        if (campayData.status === "FAILED") {
          await supabase.from("payments").update({ status: "failed" }).eq("provider_ref", reference);
          const { data: failedOrder } = await supabase.from("orders").select("user_id").eq("id", payment.order_id).single();
          if (failedOrder?.user_id) {
            notifyPaymentFailed(failedOrder.user_id, payment.order_id, payment.order_id).catch(() => {});
          }
          return sendSuccess(res, { status: "failed", order_id: payment.order_id });
        }

        return sendSuccess(res, { status: "pending", order_id: payment.order_id });
      } catch {
        return sendSuccess(res, { status: "pending", order_id: payment.order_id });
      }
    }

    sendSuccess(res, { status: payment.status, order_id: payment.order_id, operator: payment.operator });
  } catch (err) {
    next(err);
  }
}

// ─── Helper : créer la commande depuis un payment intent ─────────────────────

async function createOrderFromIntent(
  user_id: string,
  intentId: string,
  operator: string | undefined,
  d: Record<string, unknown>
): Promise<string> {
  type OrderItem = { product_id: string; quantity: number; unit_price: number; subtotal: number };

  // ── 1. Créer la commande ─────────────────────────────────────────────────
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .insert({
      user_id,
      branch_id: d.branch_id,
      type: d.type,
      status: "confirmed",
      subtotal: Number(d.subtotal),
      delivery_fee: Number(d.delivery_fee),
      total: Number(d.total),
      notes: d.notes ?? null,
    })
    .select("id")
    .single();

  if (orderErr || !order) {
    console.error("[createOrderFromIntent] Erreur création order:", orderErr?.message);
    throw new AppError(500, "CREATE_ORDER_ERROR", `Échec création commande: ${orderErr?.message ?? "inconnu"}`);
  }
  console.log(`[createOrderFromIntent] Order créé: ${order.id}`);

  // ── 2. Insérer les articles ───────────────────────────────────────────────
  const items = d.items as OrderItem[];
  const { error: itemsErr } = await supabase.from("order_items").insert(
    items.map((i) => ({ ...i, order_id: order.id }))
  );
  if (itemsErr) {
    console.error("[createOrderFromIntent] Erreur order_items:", itemsErr.message);
    throw new AppError(500, "CREATE_ITEMS_ERROR", `Échec items: ${itemsErr.message}`);
  }

  // ── 3. Click & Collect ────────────────────────────────────────────────────
  if (d.type === "collect" && d.slot_id) {
    const qr_code = await generateQrCode(order.id);
    await supabase.rpc("increment_slot_booking", { slot_id: d.slot_id });
    const { error: collectErr } = await supabase.from("collect_orders").insert({
      order_id: order.id, slot_id: d.slot_id, qr_code, pickup_status: "waiting",
    });
    if (collectErr) console.error("[createOrderFromIntent] Erreur collect_orders:", collectErr.message);
  }

  // ── 4. Enregistrer le paiement ────────────────────────────────────────────
  const { data: branch } = await supabase
    .from("branches").select("brand_id").eq("id", d.branch_id as string).single();

  // Créer la livraison ici pour avoir accès à branch.brand_id (notification drivers)
  if (d.type === "delivery") {
    const { error: deliveryErr } = await supabase.from("deliveries").insert({
      order_id: order.id,
      address: d.delivery_address,
      lat: d.delivery_lat != null ? Number(d.delivery_lat) : null,
      lng: d.delivery_lng != null ? Number(d.delivery_lng) : null,
      status: "pending",
      brand_id: branch?.brand_id ?? null,
    });
    if (deliveryErr) {
      console.error("[createOrderFromIntent] Erreur deliveries:", deliveryErr.message);
    }
  }

  // Mapper vers l'enum payment_method de la DB ('mobile_money', 'cash_on_delivery', 'wallet')
  const dbPaymentMethod = (d.payment_method === "orange_money" || d.payment_method === "mtn_mobile_money")
    ? "mobile_money"
    : "mobile_money";

  const { data: payment, error: paymentErr } = await supabase.from("payments").insert({
    order_id: order.id,
    method: dbPaymentMethod,
    amount: Number(d.total),
    status: "paid",
    provider_ref: null,
    provider: "campay",
    operator: operator ?? null,
  }).select().single();

  if (paymentErr) console.error("[createOrderFromIntent] Erreur payments:", paymentErr.message);

  // ── 5. Créditer le wallet de l'agence (paiement en ligne = sans frais) ──────
  if (branch?.brand_id && d.branch_id && payment) {
    const { error: walletErr } = await supabase.rpc("credit_branch_wallet", {
      p_branch_id:  d.branch_id as string,
      p_brand_id:   branch.brand_id,
      p_amount:     Number(d.total),
      p_payment_id: payment.id,
      p_order_id:   order.id,
      p_description: `Commande #${order.id.slice(0, 8)} — paiement en ligne`,
    });
    if (walletErr) console.error("[createOrderFromIntent] Erreur wallet credit:", walletErr.message);
  }

  // ── 6. Marquer l'intent comme traité ──────────────────────────────────────
  await supabase.from("payment_intents")
    .update({ status: "paid", order_id: order.id })
    .eq("id", intentId);

  return order.id;
}

// ─── Webhook CamPay (push) ────────────────────────────────────────────────────
// Sécurité : secret validé dans payments.routes.ts avant d'arriver ici.

export async function campayWebhook(req: Request, res: Response, next: NextFunction) {
  try {
    const { reference, status, external_reference, amount: webhookAmount } = req.body as {
      reference?: string;
      status?: string;
      external_reference?: string;
      amount?: string | number;
    };

    // Valider les champs obligatoires
    if (!reference || !status || !external_reference) {
      res.status(400).json({ status: "error", message: "Payload incomplet" });
      return;
    }

    // ── Vérification d'idempotence : ne pas retraiter un paiement déjà confirmé ──
    const { data: existingPayment } = await supabase
      .from("payments")
      .select("id, status, amount, order_id, orders(branch_id, branches(brand_id))")
      .eq("provider_ref", reference)
      .single();

    if (status === "SUCCESSFUL") {
      // Paiement déjà traité → répondre 200 sans retraiter
      if (existingPayment?.status === "paid") {
        res.status(200).json({ status: "ok" });
        return;
      }

      // Vérification du montant (si fourni par CamPay)
      if (webhookAmount != null && existingPayment && Number(webhookAmount) !== Number(existingPayment.amount)) {
        console.error(`[webhook] Montant invalide pour ${reference}: reçu ${webhookAmount}, attendu ${existingPayment.amount}`);
        res.status(400).json({ status: "error", message: "Montant invalide" });
        return;
      }

      if (existingPayment) {
        const { data: updatedPayment } = await supabase
          .from("payments")
          .update({ status: "paid" })
          .eq("provider_ref", reference)
          .eq("status", "pending") // Verrou atomique : uniquement si encore pending
          .select("id, amount, order_id, orders(branch_id, branches(brand_id))")
          .single();

        if (updatedPayment) {
          const { data: updatedOrder } = await supabase
            .from("orders")
            .update({ status: "confirmed" })
            .eq("id", external_reference)
            .select("id, user_id")
            .single();

          const webhookOrder = updatedPayment.orders as unknown as { branch_id: string; branches: { brand_id: string } };
          const wBranchId = webhookOrder?.branch_id;
          const wBrandId  = webhookOrder?.branches?.brand_id;
          if (wBranchId && wBrandId) {
            await supabase.rpc("credit_branch_wallet", {
              p_branch_id:   wBranchId,
              p_brand_id:    wBrandId,
              p_amount:      updatedPayment.amount as number,
              p_payment_id:  updatedPayment.id,
              p_order_id:    external_reference,
              p_description: `Commande #${String(external_reference).slice(0, 8)} — paiement en ligne`,
            }).then(({ error }) => { if (error) console.error("[webhook] wallet credit:", error.message); });
          }

          if (updatedOrder?.user_id) {
            notifyOrderStatus(updatedOrder.user_id, external_reference, "confirmed", external_reference).catch(() => {});
          }
        }
      }
    } else if (status === "FAILED") {
      // Idempotence : ne rien faire si déjà échoué
      if (existingPayment?.status !== "failed") {
        await supabase.from("payments").update({ status: "failed" }).eq("provider_ref", reference);
        const { data: failedOrder } = await supabase
          .from("orders")
          .select("user_id")
          .eq("id", external_reference)
          .single();
        if (failedOrder?.user_id) {
          notifyPaymentFailed(failedOrder.user_id, external_reference, external_reference).catch(() => {});
        }
      }
    }

    res.status(200).json({ status: "ok" });
  } catch (err) {
    next(err);
  }
}

// ─── Paiement en présentiel (enregistré par l'admin) ─────────────────────────

export async function recordInPersonPayment(req: Request, res: Response, next: NextFunction) {
  try {
    const { order_id, amount, reference } = req.body;

    const { data: order } = await supabase
      .from("orders")
      .select("id, total, branches(brand_id)")
      .eq("id", order_id)
      .single();

    if (!order) throw new AppError(404, "NOT_FOUND", "Commande introuvable");

    const { data: payment } = await supabase
      .from("payments")
      .insert({
        order_id,
        method: "cash_on_delivery",
        amount,
        status: "paid",
        provider_ref: reference ?? null,
        provider: "inperson",
      })
      .select()
      .single();

    await supabase.from("orders").update({ status: "delivered" }).eq("id", order_id);

    const brandId = (order.branches as unknown as { brand_id: string }).brand_id;
    const commission = Math.round(amount * COMMISSION_RATE_INPERSON);
    await supabase.from("commissions").insert({
      payment_id: payment!.id,
      order_id,
      brand_id: brandId,
      type: "inperson",
      rate: COMMISSION_RATE_INPERSON,
      amount: commission,
      is_settled: false,
    });

    sendSuccess(res, payment, "Paiement enregistré");
  } catch (err) {
    next(err);
  }
}

// ─── Solde du portefeuille CamPay (superadmin) ───────────────────────────────

export async function getCampayBalance(req: Request, res: Response, next: NextFunction) {
  try {
    const balance = await campayBalance();
    sendSuccess(res, balance);
  } catch (err) {
    next(err);
  }
}

// ─── Historique par commande ──────────────────────────────────────────────────

export async function getPaymentByOrder(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("order_id", req.params.orderId)
      .single();

    if (error || !data) throw new AppError(404, "NOT_FOUND", "Paiement introuvable");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}
