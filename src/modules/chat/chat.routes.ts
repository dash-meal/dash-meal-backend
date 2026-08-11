import { Router } from "express";
import { authenticate } from "../../middleware/auth.js";
import * as controller from "./chat.controller.js";

const router: import("express").Router = Router();

// ─── Conversations du livreur ─────────────────────────────────────────────────
router.get("/conversations/driver/list", authenticate, controller.getDriverConversations);

// ─── Conversation (créer ou récupérer) ───────────────────────────────────────
// GET /chat/conversations/order/:orderId?type=driver|support
router.get("/conversations/order/:orderId", authenticate, controller.getOrCreateConversation);

// ─── Messages ─────────────────────────────────────────────────────────────────
router.get("/conversations/:conversationId/messages", authenticate, controller.getMessages);
router.post("/conversations/:conversationId/messages", authenticate, controller.sendMessage);
router.post("/conversations/:conversationId/typing", authenticate, controller.setTyping);
router.patch("/conversations/:conversationId/read", authenticate, controller.markAsRead);

// ─── Upload média (photo ou audio) ───────────────────────────────────────────
router.post("/upload", authenticate, controller.mediaUpload.single("file"), controller.uploadChatMedia);

// ─── Legacy : liste des conversations d'une commande ─────────────────────────
router.get("/conversations/:orderId", authenticate, controller.getConversations);

export default router;
