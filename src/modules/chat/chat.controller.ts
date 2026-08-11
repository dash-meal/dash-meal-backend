import type { Request, Response, NextFunction } from "express";
import multer from "multer";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";
import { notifyUser } from "../../utils/push.js";

// ─── Types ────────────────────────────────────────────────────────────────────

type ConvType = "client_driver" | "client_support";

// ─── Typing indicators (in-memory, TTL 4s) ────────────────────────────────────
// key: `${conversationId}:${userId}` → timestamp de fin
const typingMap = new Map<string, number>();

// Nettoyage automatique toutes les 30s
setInterval(() => {
  const now = Date.now();
  for (const [key, until] of typingMap) {
    if (until < now) typingMap.delete(key);
  }
}, 30_000);

// ─── Récupérer ou créer une conversation pour une commande ───────────────────

export async function getOrCreateConversation(req: Request, res: Response, next: NextFunction) {
  try {
    const { orderId } = req.params;
    const type = (req.query.type === "driver" ? "client_driver" : "client_support") as ConvType;

    // Vérifier que la commande appartient à l'utilisateur (ou est accessible)
    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, user_id, branch_id, branches(name, brand_id, phone)")
      .eq("id", orderId)
      .single();

    if (orderErr || !order) throw new AppError(404, "NOT_FOUND", "Commande introuvable");
    if (order.user_id !== req.user!.id && req.user!.role !== "admin" && req.user!.role !== "driver")
      throw new AppError(403, "FORBIDDEN", "Accès refusé");

    // Chercher une conversation existante
    const { data: existing } = await supabase
      .from("conversations")
      .select("*")
      .eq("order_id", orderId)
      .eq("type", type)
      .maybeSingle();

    const conv = existing ?? await (async () => {
      const { data, error: createErr } = await supabase
        .from("conversations")
        .insert({ order_id: orderId, type })
        .select()
        .single();
      if (createErr || !data) throw new AppError(500, "CREATE_ERROR", "Impossible de créer la conversation");
      return data;
    })();

    // Enrich with counterpart info
    let counterpart_name: string | null = null;
    let counterpart_phone: string | null = null;
    let counterpart_avatar: string | null = null;
    const branch = order.branches as unknown as { name: string; phone: string | null } | null;

    if (type === "client_driver") {
      const { data: delivery } = await supabase
        .from("deliveries")
        .select("driver_id, drivers(name, phone, photo_url)")
        .eq("order_id", orderId)
        .maybeSingle();
      const driver = delivery?.drivers as unknown as { name: string; phone: string; photo_url: string | null } | null;
      if (driver) {
        counterpart_name = driver.name;
        counterpart_phone = driver.phone;
        counterpart_avatar = driver.photo_url ?? null;
      }
    } else {
      counterpart_name = branch?.name ?? null;
      counterpart_phone = branch?.phone ?? null;
    }

    sendSuccess(res, {
      ...conv,
      counterpart_name,
      counterpart_phone,
      counterpart_avatar,
      order_ref: orderId,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Lister les conversations d'une commande ─────────────────────────────────

export async function getConversations(req: Request, res: Response, next: NextFunction) {
  try {
    const { orderId } = req.params;

    const { data, error } = await supabase
      .from("conversations")
      .select("*, messages(count)")
      .eq("order_id", orderId);

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Messages d'une conversation ─────────────────────────────────────────────

export async function getMessages(req: Request, res: Response, next: NextFunction) {
  try {
    const { conversationId } = req.params;
    const { page = "1", limit = "50" } = req.query as Record<string, string>;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;

    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .range(offset, offset + limitNum - 1);

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    // Typing indicator — quelqu'un d'autre dans cette conversation est-il en train d'écrire ?
    const now = Date.now();
    const isCounterpartTyping = [...typingMap.entries()].some(
      ([key, until]) =>
        key.startsWith(`${conversationId}:`) &&
        !key.endsWith(`:${req.user!.id}`) &&
        until > now
    );

    sendSuccess(res, { messages: data ?? [], is_counterpart_typing: isCounterpartTyping });
  } catch (err) {
    next(err);
  }
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

export async function setTyping(req: Request, res: Response) {
  const { conversationId } = req.params;
  typingMap.set(`${conversationId}:${req.user!.id}`, Date.now() + 4000);
  res.status(204).send();
}

// ─── Envoyer un message (texte, image, voix) ─────────────────────────────────

export async function sendMessage(req: Request, res: Response, next: NextFunction) {
  try {
    const { conversationId } = req.params;
    const { content, message_type = "text", media_url, duration_s } = req.body as {
      content?: string;
      message_type?: "text" | "image" | "voice";
      media_url?: string;
      duration_s?: number;
    };

    if (message_type === "text" && !content?.trim())
      throw new AppError(400, "EMPTY_MESSAGE", "Le message ne peut pas être vide");

    const { data, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: conversationId,
        sender_id: req.user!.id,
        sender_role: req.user!.role,
        content: content?.trim() ?? null,
        message_type,
        media_url: media_url ?? null,
        duration_s: duration_s ?? null,
        is_read: false,
      })
      .select()
      .single();

    if (error || !data) throw new AppError(500, "SEND_ERROR", "Échec d'envoi du message");

    // Notifier l'autre participant
    const conv = await supabase
      .from("conversations")
      .select("order_id, orders(user_id)")
      .eq("id", conversationId)
      .single();

    if (conv.data?.order_id) {
      const orderId = conv.data.order_id;
      const orderUserId = (conv.data.orders as any)?.user_id;
      if (orderUserId && orderUserId !== req.user!.id) {
        await notifyUser(
          orderUserId,
          "Nouveau message 💬",
          content?.trim() ?? (message_type === "image" ? "📷 Photo" : "🎙️ Note vocale"),
          { screen: "chat", conversationId, orderId }
        );
      }
    }

    sendCreated(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── Upload média (photo ou audio) ───────────────────────────────────────────

export const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 Mo max
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "audio/mpeg", "audio/mp4", "audio/wav", "audio/aac", "audio/m4a", "audio/x-m4a", "audio/3gpp", "audio/webm"];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Type non supporté (image JPEG/PNG/WEBP ou audio MP3/M4A/WAV)"));
  },
});

export async function uploadChatMedia(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new AppError(400, "NO_FILE", "Aucun fichier fourni");

    const isAudio = req.file.mimetype.startsWith("audio/");
    const bucket = isAudio ? "chat-audio" : "chat-images";
    const ext = req.file.originalname.split(".").pop() ?? (isAudio ? "m4a" : "jpg");
    const path = `${req.user!.id}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) throw new AppError(500, "UPLOAD_ERROR", "Échec upload: " + uploadError.message);

    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(path);

    sendCreated(res, {
      url: urlData.publicUrl,
      type: isAudio ? "voice" : "image",
    });
  } catch (err) {
    next(err);
  }
}

// ─── Marquer comme lus ────────────────────────────────────────────────────────

export async function markAsRead(req: Request, res: Response, next: NextFunction) {
  try {
    await supabase
      .from("messages")
      .update({ is_read: true })
      .eq("conversation_id", req.params.conversationId)
      .neq("sender_id", req.user!.id);

    sendSuccess(res, null, "Messages marqués comme lus");
  } catch (err) {
    next(err);
  }
}

// ─── Conversations du livreur ─────────────────────────────────────────────────
// Returns all client_driver conversations for deliveries the driver owns

export async function getDriverConversations(req: Request, res: Response, next: NextFunction) {
  try {
    const driverId = req.user!.id;

    // Step 1: get order_ids for this driver's deliveries
    const { data: deliveries } = await supabase
      .from("deliveries")
      .select("order_id, status, address")
      .eq("driver_id", driverId);

    if (!deliveries || deliveries.length === 0) return sendSuccess(res, []);

    const orderIds = deliveries.map((d) => d.order_id);
    const deliveryByOrder = Object.fromEntries(deliveries.map((d) => [d.order_id, d]));

    // Step 2: get client_driver conversations for those orders
    const { data: conversations, error } = await supabase
      .from("conversations")
      .select(`
        id, order_id, created_at,
        orders(id, status, users(name, phone)),
        messages(id, content, message_type, created_at, sender_id, is_read)
      `)
      .eq("type", "client_driver")
      .in("order_id", orderIds)
      .order("created_at", { ascending: false });

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    const enriched = (conversations ?? []).map((conv: any) => {
      const msgs: any[] = conv.messages ?? [];
      const lastMsg = [...msgs].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )[0] ?? null;
      const unread = msgs.filter((m) => !m.is_read && m.sender_id !== driverId).length;
      const user = conv.orders?.users;
      const delivery = deliveryByOrder[conv.order_id];

      return {
        id: conv.id,
        order_id: conv.order_id,
        counterpart_name: user?.name ?? "Client",
        counterpart_phone: user?.phone ?? null,
        delivery_status: delivery?.status ?? null,
        delivery_address: delivery?.address ?? null,
        last_message: lastMsg ? {
          content: lastMsg.content,
          message_type: lastMsg.message_type,
          created_at: lastMsg.created_at,
          is_mine: lastMsg.sender_id === driverId,
        } : null,
        unread_count: unread,
      };
    });

    sendSuccess(res, enriched);
  } catch (err) {
    next(err);
  }
}
