import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess, sendPaginated } from "../../utils/response.js";

// ─── GET /stock/:branch_id — liste le stock complet d'une agence ──────────────
export async function getBranchStock(req: Request, res: Response, next: NextFunction) {
  try {
    const branch_id = String(req.params.branch_id);
    await assertBranchAccess(req, branch_id);

    const { low_stock } = req.query;

    let query = supabase
      .from("branch_stock")
      .select("*, products(id, name_fr, name_en, price, category_id, categories(name_fr))")
      .eq("branch_id", branch_id)
      .order("stock_qty", { ascending: true });

    if (low_stock === "true") query = query.lt("stock_qty", 5);

    const { data, error } = await query;
    if (error) throw new AppError(500, "DB_ERROR", error.message);
    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

// ─── PATCH /stock/:branch_id/:product_id — ajuster le stock ──────────────────
export async function updateStockItem(req: Request, res: Response, next: NextFunction) {
  try {
    const branch_id  = String(req.params.branch_id);
    const product_id = String(req.params.product_id);
    await assertBranchAccess(req, branch_id);

    const { quantity, type, note } = req.body as {
      quantity: number; // nouvelle quantité absolue
      type: "restock" | "adjustment" | "removal" | "loss";
      note?: string;
    };

    // Lire le stock actuel
    const { data: current } = await supabase
      .from("branch_stock")
      .select("stock_qty, id")
      .eq("branch_id", branch_id)
      .eq("product_id", product_id)
      .maybeSingle();

    const quantity_before = current?.stock_qty ?? 0;
    const quantity_change  = quantity - quantity_before;

    // Upsert du stock
    const { data: updated, error } = await supabase
      .from("branch_stock")
      .upsert({ branch_id, product_id, stock_qty: quantity, updated_at: new Date().toISOString() }, { onConflict: "branch_id,product_id" })
      .select()
      .single();

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    // Enregistrer le mouvement
    await supabase.from("stock_movements").insert({
      branch_id,
      product_id,
      branch_manager_id: req.user!.role === "branch_manager" ? req.user!.id : null,
      admin_id:          req.user!.role === "admin" ? req.user!.id : null,
      type,
      quantity_change,
      quantity_before,
      quantity_after: quantity,
      note: note ?? null,
    });

    sendSuccess(res, updated, "Stock mis à jour");
  } catch (err) {
    next(err);
  }
}

// ─── POST /stock/:branch_id/bulk — mise à jour en masse ──────────────────────
export async function bulkUpdateStock(req: Request, res: Response, next: NextFunction) {
  try {
    const branch_id = String(req.params.branch_id);
    await assertBranchAccess(req, branch_id);

    const items = req.body.items as Array<{
      product_id: string; quantity: number; type: "restock" | "adjustment"; note?: string;
    }>;

    // Lire stock actuel en une requête
    const productIds = items.map((i) => i.product_id);
    const { data: currentStocks } = await supabase
      .from("branch_stock")
      .select("product_id, stock_qty")
      .eq("branch_id", branch_id)
      .in("product_id", productIds);

    const currentMap = Object.fromEntries((currentStocks ?? []).map((s) => [s.product_id, s.stock_qty]));

    const now = new Date().toISOString();
    const upsertRows = items.map((item) => ({
      branch_id,
      product_id:  item.product_id,
      stock_qty:   item.quantity,
      updated_at:  now,
    }));

    const movementRows = items.map((item) => ({
      branch_id,
      product_id:        item.product_id,
      branch_manager_id: req.user!.role === "branch_manager" ? req.user!.id : null,
      admin_id:          req.user!.role === "admin" ? req.user!.id : null,
      type:              item.type,
      quantity_change:   item.quantity - (currentMap[item.product_id] ?? 0),
      quantity_before:   currentMap[item.product_id] ?? 0,
      quantity_after:    item.quantity,
      note:              item.note ?? null,
    }));

    await supabase.from("branch_stock").upsert(upsertRows, { onConflict: "branch_id,product_id" });
    await supabase.from("stock_movements").insert(movementRows);

    sendSuccess(res, { updated: items.length }, "Stock mis à jour en masse");
  } catch (err) {
    next(err);
  }
}

// ─── GET /stock/:branch_id/movements — historique ────────────────────────────
export async function getStockMovements(req: Request, res: Response, next: NextFunction) {
  try {
    const branch_id = String(req.params.branch_id);
    await assertBranchAccess(req, branch_id);

    const page       = Math.max(1, parseInt(req.query.page       as string) || 1);
    const limit      = Math.min(100, parseInt(req.query.limit     as string) || 30);
    const product_id = req.query.product_id as string | undefined;
    const type       = req.query.type       as string | undefined;
    const from_row   = (page - 1) * limit;

    let query = supabase
      .from("stock_movements")
      .select("*, products(name_fr, name_en)", { count: "exact" })
      .eq("branch_id", branch_id)
      .order("created_at", { ascending: false })
      .range(from_row, from_row + limit - 1);

    if (product_id) query = query.eq("product_id", product_id);
    if (type)       query = query.eq("type", type);

    const { data, count, error } = await query;
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendPaginated(res, data ?? [], count ?? 0, page, limit);
  } catch (err) {
    next(err);
  }
}

// ─── GET /stock/:branch_id/alerts — produits sous le seuil d'alerte ──────────
export async function getStockAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    const branch_id = String(req.params.branch_id);
    await assertBranchAccess(req, branch_id);

    const threshold = parseInt(req.query.threshold as string) || 5;

    const { data, error } = await supabase
      .from("branch_stock")
      .select("*, products(id, name_fr, name_en, price)")
      .eq("branch_id", branch_id)
      .lt("stock_qty", threshold)
      .order("stock_qty");

    if (error) throw new AppError(500, "DB_ERROR", error.message);
    sendSuccess(res, data ?? []);
  } catch (err) {
    next(err);
  }
}

// ─── Helper : vérification accès agence ──────────────────────────────────────
async function assertBranchAccess(req: { user?: { role: string; brand_id?: string; branch_id?: string } }, branch_id: string) {
  if (!req.user) throw new AppError(401, "UNAUTHORIZED", "Non authentifié");

  if (req.user.role === "superadmin") return;

  if (req.user.role === "admin") {
    const { data } = await supabase.from("branches").select("brand_id").eq("id", branch_id).single();
    if (!data || data.brand_id !== req.user.brand_id) throw new AppError(403, "FORBIDDEN", "Accès refusé");
    return;
  }

  if (req.user.role === "branch_manager") {
    if (req.user.branch_id !== branch_id) throw new AppError(403, "BRANCH_ACCESS_DENIED", "Accès refusé à cette agence");
    return;
  }

  throw new AppError(403, "FORBIDDEN", "Accès refusé");
}
