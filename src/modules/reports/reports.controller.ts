import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";

// ─── Helpers CSV ──────────────────────────────────────────────────────────────

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  // Envelopper dans des guillemets si le champ contient virgule, guillemet ou saut de ligne
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function rowToCsv(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(",");
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

// ─── Exportation des commandes ────────────────────────────────────────────────

export async function exportOrdersCsv(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const { from, to, branch_id } = req.query as Record<string, string>;

    let query = supabase
      .from("orders")
      .select(`
        id,
        created_at,
        status,
        type,
        subtotal,
        discount,
        delivery_fee,
        total,
        payment_method,
        users(name),
        branches(name, brand_id)
      `)
      .order("created_at", { ascending: false });

    // Isolation marque
    if (user.role === "admin") {
      if (!user.brand_id) throw new AppError(403, "FORBIDDEN", "Marque non associée");
      // Récupérer les agences de la marque
      const { data: branches } = await supabase
        .from("branches")
        .select("id")
        .eq("brand_id", user.brand_id);
      const ids = (branches ?? []).map((b) => b.id);
      if (!ids.length) {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename=orders_${todayStr()}.csv`);
        res.send("id,date,customer,branch,status,type,payment_method,total,discount,delivery_fee\n");
        return;
      }
      query = query.in("branch_id", ids);
    }

    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", `${to}T23:59:59`);
    if (branch_id) query = query.eq("branch_id", branch_id);

    const { data, error } = await query.limit(10000);
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    const headers = "id,date,customer,branch,status,type,payment_method,total,discount,delivery_fee\n";
    const rows = (data ?? []).map((o) => {
      const users = (o.users as unknown) as Record<string, unknown> | null;
      const branches = (o.branches as unknown) as Record<string, unknown> | null;
      return rowToCsv([
        o.id,
        o.created_at ? new Date(o.created_at as string).toLocaleString("fr-FR") : "",
        users?.name ?? "",
        branches?.name ?? "",
        o.status,
        o.type,
        o.payment_method ?? "",
        o.total,
        o.discount ?? 0,
        o.delivery_fee ?? 0,
      ]);
    });

    const csv = headers + rows.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=orders_${todayStr()}.csv`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

// ─── Exportation des ventes par produit ───────────────────────────────────────

export async function exportProductsSalesCsv(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const { from, to, brand_id: queryBrandId } = req.query as Record<string, string>;

    const brandId = user.role === "superadmin" ? queryBrandId : user.brand_id;
    if (!brandId) throw new AppError(400, "MISSING_BRAND_ID", "brand_id requis");

    // Récupérer les agences de la marque
    const { data: branches } = await supabase
      .from("branches")
      .select("id")
      .eq("brand_id", brandId);
    const branchIds = (branches ?? []).map((b) => b.id);

    if (!branchIds.length) {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=products_${todayStr()}.csv`);
      res.send("product_name,quantity_sold,revenue\n");
      return;
    }

    // Construire la query sur order_items avec jointure commandes et produits
    let query = supabase
      .from("order_items")
      .select(`
        quantity,
        subtotal,
        products(name_fr),
        orders!inner(branch_id, created_at, status)
      `)
      .in("orders.branch_id", branchIds)
      .neq("orders.status", "cancelled");

    if (from) query = query.gte("orders.created_at", from);
    if (to) query = query.lte("orders.created_at", `${to}T23:59:59`);

    const { data, error } = await query.limit(50000);
    if (error) throw new AppError(500, "DB_ERROR", error.message);

    // Agréger par produit
    const productMap = new Map<string, { quantity: number; revenue: number }>();
    for (const item of data ?? []) {
      const products = (item.products as unknown) as Record<string, unknown> | null;
      const name = (products?.name_fr as string) ?? "Produit inconnu";
      const existing = productMap.get(name) ?? { quantity: 0, revenue: 0 };
      productMap.set(name, {
        quantity: existing.quantity + Number(item.quantity),
        revenue: existing.revenue + Number(item.subtotal),
      });
    }

    // Trier par quantité vendue décroissante
    const sorted = [...productMap.entries()].sort((a, b) => b[1].quantity - a[1].quantity);

    const headers = "product_name,quantity_sold,revenue\n";
    const rows = sorted.map(([name, stats]) =>
      rowToCsv([name, stats.quantity, stats.revenue])
    );

    const csv = headers + rows.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=products_${todayStr()}.csv`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

// ─── Résumé analytics ─────────────────────────────────────────────────────────

export async function getSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user!;
    const { from, to } = req.query as Record<string, string>;

    // Résoudre les agences accessibles
    let branchIds: string[] | null = null;

    if (user.role === "admin") {
      if (!user.brand_id) throw new AppError(403, "FORBIDDEN", "Marque non associée");
      const { data: branches } = await supabase
        .from("branches")
        .select("id")
        .eq("brand_id", user.brand_id);
      branchIds = (branches ?? []).map((b) => b.id);
      if (!branchIds.length) {
        sendSuccess(res, {
          total_orders: 0,
          total_revenue: 0,
          avg_order: 0,
          delivered: 0,
          cancelled: 0,
          top_branch: null,
          top_product: null,
        });
        return;
      }
    }

    // Query commandes
    let ordersQuery = supabase
      .from("orders")
      .select("id, total, status, branch_id, branches(name)", { count: "exact" })
      .neq("status", "pending");

    if (branchIds) ordersQuery = ordersQuery.in("branch_id", branchIds);
    if (from) ordersQuery = ordersQuery.gte("created_at", from);
    if (to) ordersQuery = ordersQuery.lte("created_at", `${to}T23:59:59`);

    const { data: orders, count: totalCount, error: ordersErr } = await ordersQuery.limit(10000);
    if (ordersErr) throw new AppError(500, "DB_ERROR", ordersErr.message);

    const allOrders = orders ?? [];
    const total_orders = totalCount ?? allOrders.length;
    const total_revenue = allOrders.reduce((sum, o) => sum + Number(o.total ?? 0), 0);
    const avg_order = total_orders > 0 ? Math.round(total_revenue / total_orders) : 0;
    const delivered = allOrders.filter((o) => o.status === "delivered").length;
    const cancelled = allOrders.filter((o) => o.status === "cancelled").length;

    // Top agence (par nombre de commandes)
    const branchCount = new Map<string, { name: string; count: number }>();
    for (const o of allOrders) {
      if (!o.branch_id) continue;
      const branches = (o.branches as unknown) as Record<string, unknown> | null;
      const name = (branches?.name as string) ?? o.branch_id;
      const existing = branchCount.get(o.branch_id) ?? { name, count: 0 };
      branchCount.set(o.branch_id, { ...existing, count: existing.count + 1 });
    }
    const topBranchEntry = [...branchCount.values()].sort((a, b) => b.count - a.count)[0];
    const top_branch = topBranchEntry ? { name: topBranchEntry.name, orders: topBranchEntry.count } : null;

    // Top produit (par quantité)
    let itemsQuery = supabase
      .from("order_items")
      .select("quantity, products(name_fr), orders!inner(branch_id, status)");

    if (branchIds) itemsQuery = itemsQuery.in("orders.branch_id", branchIds);
    itemsQuery = itemsQuery.neq("orders.status", "cancelled");
    if (from) itemsQuery = itemsQuery.gte("orders.created_at", from);
    if (to) itemsQuery = itemsQuery.lte("orders.created_at", `${to}T23:59:59`);

    const { data: items } = await itemsQuery.limit(50000);

    const productQty = new Map<string, number>();
    for (const item of items ?? []) {
      const products = (item.products as unknown) as Record<string, unknown> | null;
      const name = (products?.name_fr as string) ?? "Inconnu";
      productQty.set(name, (productQty.get(name) ?? 0) + Number(item.quantity));
    }
    const topProductEntry = [...productQty.entries()].sort((a, b) => b[1] - a[1])[0];
    const top_product = topProductEntry ? { name: topProductEntry[0], quantity: topProductEntry[1] } : null;

    sendSuccess(res, {
      total_orders,
      total_revenue,
      avg_order,
      delivered,
      cancelled,
      top_branch,
      top_product,
    });
  } catch (err) {
    next(err);
  }
}
