import type { Request, Response, NextFunction } from "express";
import * as reelsService from "./reels.service.js";
import { sendSuccess, sendCreated } from "../../utils/response.js";

// ─── Routes publiques ─────────────────────────────────────────────────────────

export async function listReels(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined;
    const branch_id = req.query.branch_id as string | undefined;
    const user_id = req.user?.id;

    const result = await reelsService.listReels({ limit, offset, branch_id, user_id });
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getReelById(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as { id: string };
    const user_id = req.user?.id;

    const reel = await reelsService.getReelById(id, user_id);
    sendSuccess(res, reel);
  } catch (err) {
    next(err);
  }
}

// ─── Likes ────────────────────────────────────────────────────────────────────

export async function likeReel(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;

    const result = await reelsService.likeReel(id, userId);
    sendSuccess(res, result, "Reel liké");
  } catch (err) {
    next(err);
  }
}

export async function unlikeReel(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;

    const result = await reelsService.unlikeReel(id, userId);
    sendSuccess(res, result, "Like retiré");
  } catch (err) {
    next(err);
  }
}

// ─── Commentaires ─────────────────────────────────────────────────────────────

export async function getComments(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as { id: string };

    const comments = await reelsService.getComments(id);
    sendSuccess(res, comments);
  } catch (err) {
    next(err);
  }
}

export async function addComment(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const { content } = req.body as { content: string };

    const comment = await reelsService.addComment(id, userId, content);
    sendCreated(res, comment, "Commentaire ajouté");
  } catch (err) {
    next(err);
  }
}

export async function deleteComment(req: Request, res: Response, next: NextFunction) {
  try {
    const { comment_id } = req.params as { comment_id: string };
    const userId = req.user!.id;

    const result = await reelsService.deleteComment(comment_id, userId);
    sendSuccess(res, result, "Commentaire supprimé");
  } catch (err) {
    next(err);
  }
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export async function createReel(req: Request, res: Response, next: NextFunction) {
  try {
    const brandId = req.user!.brand_id!;
    const data = { ...req.body, brand_id: brandId };

    const reel = await reelsService.createReel(data);
    sendCreated(res, reel, "Reel créé");
  } catch (err) {
    next(err);
  }
}

export async function updateReel(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as { id: string };
    const brandId = req.user!.brand_id!;

    const reel = await reelsService.updateReel(id, brandId, req.body);
    sendSuccess(res, reel, "Reel mis à jour");
  } catch (err) {
    next(err);
  }
}

export async function deleteReel(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params as { id: string };
    const brandId = req.user!.brand_id!;

    const result = await reelsService.deleteReel(id, brandId);
    sendSuccess(res, result, "Reel supprimé");
  } catch (err) {
    next(err);
  }
}

export async function addAdminReply(req: Request, res: Response, next: NextFunction) {
  try {
    const { comment_id } = req.params as { comment_id: string };
    const brandId = req.user!.brand_id!;
    const { content } = req.body as { content: string };

    const reply = await reelsService.addAdminReply(comment_id, brandId, content);
    sendCreated(res, reply, "Réponse ajoutée");
  } catch (err) {
    next(err);
  }
}
