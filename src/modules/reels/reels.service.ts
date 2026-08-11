import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";

// ─── Types internes ───────────────────────────────────────────────────────────

interface ListReelsParams {
  limit?: number;
  offset?: number;
  branch_id?: string;
  user_id?: string;
}

interface CreateReelInput {
  brand_id: string;
  branch_id: string;
  video_url: string;
  thumbnail_url?: string;
  caption: string;
  product_id?: string;
}

interface UpdateReelInput {
  video_url?: string;
  thumbnail_url?: string;
  caption?: string;
  product_id?: string;
  is_active?: boolean;
}

// ─── Lecture publique ─────────────────────────────────────────────────────────

export async function listReels(params: ListReelsParams) {
  const limit = Math.min(params.limit ?? 20, 50);
  const offset = params.offset ?? 0;

  let query = supabase
    .from("reels")
    .select(
      `
      id,
      brand_id,
      branch_id,
      product_id,
      video_url,
      thumbnail_url,
      caption,
      likes_count,
      views_count,
      is_active,
      created_at,
      reel_comments(count),
      reel_likes(count)
      `,
      { count: "exact" }
    )
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (params.branch_id) {
    query = query.eq("branch_id", params.branch_id);
  }

  const { data, error, count } = await query;

  if (error) throw new AppError(500, "DB_ERROR", error.message);

  // Si un utilisateur est authentifié, récupérer ses likes
  let likedReelIds = new Set<string>();
  if (params.user_id && data && data.length > 0) {
    const reelIds = data.map((r) => r.id);
    const { data: likes } = await supabase
      .from("reel_likes")
      .select("reel_id")
      .eq("user_id", params.user_id)
      .in("reel_id", reelIds);
    if (likes) likedReelIds = new Set(likes.map((l) => l.reel_id));
  }

  const reels = (data ?? []).map((reel) => ({
    ...reel,
    comment_count: (reel.reel_comments as unknown as { count: number }[])?.[0]?.count ?? 0,
    liked_by_user: params.user_id ? likedReelIds.has(reel.id) : null,
  }));

  return { reels, total: count ?? 0, limit, offset };
}

export async function getReelById(id: string, userId?: string) {
  const { data: reel, error } = await supabase
    .from("reels")
    .select(
      `
      id,
      brand_id,
      branch_id,
      product_id,
      video_url,
      thumbnail_url,
      caption,
      likes_count,
      views_count,
      is_active,
      created_at,
      reel_comments(count)
      `
    )
    .eq("id", id)
    .eq("is_active", true)
    .single();

  if (error) {
    if (error.code === "PGRST116") throw new AppError(404, "NOT_FOUND", "Reel introuvable");
    throw new AppError(500, "DB_ERROR", error.message);
  }

  let liked_by_user: boolean | null = null;
  if (userId) {
    const { data: like } = await supabase
      .from("reel_likes")
      .select("reel_id")
      .eq("reel_id", id)
      .eq("user_id", userId)
      .maybeSingle();
    liked_by_user = like !== null;
  }

  // Incrémenter views_count (best-effort)
  await supabase
    .from("reels")
    .update({ views_count: (reel.views_count ?? 0) + 1 })
    .eq("id", id);

  return {
    ...reel,
    comment_count: (reel.reel_comments as unknown as { count: number }[])?.[0]?.count ?? 0,
    liked_by_user,
  };
}

// ─── Likes ────────────────────────────────────────────────────────────────────

export async function likeReel(reelId: string, userId: string) {
  // Vérifier que le reel existe
  const { data: reel, error: reelErr } = await supabase
    .from("reels")
    .select("id, likes_count")
    .eq("id", reelId)
    .eq("is_active", true)
    .single();

  if (reelErr || !reel) {
    throw new AppError(404, "NOT_FOUND", "Reel introuvable");
  }

  // Insérer le like (ignorer si déjà liké)
  const { error: insertErr } = await supabase
    .from("reel_likes")
    .upsert({ reel_id: reelId, user_id: userId }, { onConflict: "reel_id,user_id", ignoreDuplicates: true });

  if (insertErr) throw new AppError(500, "DB_ERROR", insertErr.message);

  // Mettre à jour le compteur
  await supabase
    .from("reels")
    .update({ likes_count: (reel.likes_count ?? 0) + 1 })
    .eq("id", reelId);

  return { liked: true };
}

export async function unlikeReel(reelId: string, userId: string) {
  const { data: reel, error: reelErr } = await supabase
    .from("reels")
    .select("id, likes_count")
    .eq("id", reelId)
    .single();

  if (reelErr || !reel) {
    throw new AppError(404, "NOT_FOUND", "Reel introuvable");
  }

  const { error: deleteErr } = await supabase
    .from("reel_likes")
    .delete()
    .eq("reel_id", reelId)
    .eq("user_id", userId);

  if (deleteErr) throw new AppError(500, "DB_ERROR", deleteErr.message);

  // Décrémenter sans passer sous 0
  const newCount = Math.max(0, (reel.likes_count ?? 0) - 1);
  await supabase.from("reels").update({ likes_count: newCount }).eq("id", reelId);

  return { liked: false };
}

// ─── Commentaires ─────────────────────────────────────────────────────────────

export async function getComments(reelId: string) {
  // Vérifier que le reel existe
  const { data: reel, error: reelErr } = await supabase
    .from("reels")
    .select("id")
    .eq("id", reelId)
    .single();

  if (reelErr || !reel) throw new AppError(404, "NOT_FOUND", "Reel introuvable");

  // Récupérer tous les commentaires du reel (parents + replies)
  const { data: allComments, error } = await supabase
    .from("reel_comments")
    .select(
      `
      id,
      reel_id,
      user_id,
      brand_id,
      content,
      parent_id,
      is_brand_reply,
      created_at,
      users(id, name)
      `
    )
    .eq("reel_id", reelId)
    .order("created_at", { ascending: true });

  if (error) throw new AppError(500, "DB_ERROR", error.message);

  const comments = allComments ?? [];

  // Construire l'arbre : parents + replies imbriquées
  const parents = comments.filter((c) => c.parent_id === null);
  const repliesMap = new Map<string, typeof comments>();

  for (const comment of comments) {
    if (comment.parent_id) {
      const arr = repliesMap.get(comment.parent_id) ?? [];
      arr.push(comment);
      repliesMap.set(comment.parent_id, arr);
    }
  }

  return parents.map((parent) => ({
    ...parent,
    replies: repliesMap.get(parent.id) ?? [],
  }));
}

export async function addComment(reelId: string, userId: string, content: string) {
  const { data: reel, error: reelErr } = await supabase
    .from("reels")
    .select("id")
    .eq("id", reelId)
    .eq("is_active", true)
    .single();

  if (reelErr || !reel) throw new AppError(404, "NOT_FOUND", "Reel introuvable");

  const { data, error } = await supabase
    .from("reel_comments")
    .insert({
      reel_id: reelId,
      user_id: userId,
      content,
      parent_id: null,
      is_brand_reply: false,
    })
    .select()
    .single();

  if (error) throw new AppError(500, "DB_ERROR", error.message);

  return data;
}

export async function deleteComment(commentId: string, userId: string) {
  // Vérifier que le commentaire appartient à l'utilisateur
  const { data: comment, error: fetchErr } = await supabase
    .from("reel_comments")
    .select("id, user_id")
    .eq("id", commentId)
    .single();

  if (fetchErr || !comment) throw new AppError(404, "NOT_FOUND", "Commentaire introuvable");

  if (comment.user_id !== userId) {
    throw new AppError(403, "FORBIDDEN", "Vous ne pouvez supprimer que vos propres commentaires");
  }

  // Supprimer le commentaire et ses réponses
  await supabase.from("reel_comments").delete().eq("parent_id", commentId);
  const { error } = await supabase.from("reel_comments").delete().eq("id", commentId);

  if (error) throw new AppError(500, "DB_ERROR", error.message);

  return { deleted: true };
}

export async function addAdminReply(commentId: string, brandId: string, content: string) {
  // Vérifier que le commentaire parent existe
  const { data: parent, error: parentErr } = await supabase
    .from("reel_comments")
    .select("id, reel_id")
    .eq("id", commentId)
    .is("parent_id", null)
    .single();

  if (parentErr || !parent) {
    throw new AppError(404, "NOT_FOUND", "Commentaire parent introuvable");
  }

  const { data, error } = await supabase
    .from("reel_comments")
    .insert({
      reel_id: parent.reel_id,
      brand_id: brandId,
      content,
      parent_id: commentId,
      is_brand_reply: true,
    })
    .select()
    .single();

  if (error) throw new AppError(500, "DB_ERROR", error.message);

  return data;
}

// ─── CRUD admin ───────────────────────────────────────────────────────────────

export async function createReel(data: CreateReelInput) {
  const { data: reel, error } = await supabase
    .from("reels")
    .insert({
      brand_id: data.brand_id,
      branch_id: data.branch_id,
      video_url: data.video_url,
      thumbnail_url: data.thumbnail_url ?? null,
      caption: data.caption,
      product_id: data.product_id ?? null,
      is_active: true,
      likes_count: 0,
      views_count: 0,
    })
    .select()
    .single();

  if (error) throw new AppError(500, "DB_ERROR", error.message);

  return reel;
}

export async function updateReel(id: string, brandId: string, updates: UpdateReelInput) {
  // Vérifier que le reel appartient à la marque
  const { data: existing, error: fetchErr } = await supabase
    .from("reels")
    .select("id, brand_id")
    .eq("id", id)
    .single();

  if (fetchErr || !existing) throw new AppError(404, "NOT_FOUND", "Reel introuvable");

  if (existing.brand_id !== brandId) {
    throw new AppError(403, "FORBIDDEN", "Ce reel n'appartient pas à votre marque");
  }

  const { data, error } = await supabase
    .from("reels")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw new AppError(500, "DB_ERROR", error.message);

  return data;
}

export async function deleteReel(id: string, brandId: string) {
  const { data: existing, error: fetchErr } = await supabase
    .from("reels")
    .select("id, brand_id")
    .eq("id", id)
    .single();

  if (fetchErr || !existing) throw new AppError(404, "NOT_FOUND", "Reel introuvable");

  if (existing.brand_id !== brandId) {
    throw new AppError(403, "FORBIDDEN", "Ce reel n'appartient pas à votre marque");
  }

  // Supprimer les likes et commentaires associés
  await supabase.from("reel_likes").delete().eq("reel_id", id);
  await supabase.from("reel_comments").delete().eq("reel_id", id);

  const { error } = await supabase.from("reels").delete().eq("id", id);

  if (error) throw new AppError(500, "DB_ERROR", error.message);

  return { deleted: true };
}
