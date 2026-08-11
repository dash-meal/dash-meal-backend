import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";

// ─── GET /analytics/dashboard?days=7|30|90 ───────────────────────────────────
// Tableau de bord complet pour l'admin de marque

export async function getDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const role      = req.user!.role;
    const brand_id  = req.user!.brand_id;
    const branch_id = req.user!.branch_id; // branch_manager only

    if (!brand_id && role !== "branch_manager") {
      throw new AppError(403, "FORBIDDEN", "Accès réservé aux admins de marque");
    }

    const days = Math.max(1, Math.min(365, parseInt(req.query.days as string) || 30));
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const todayStart = new Date().toISOString().split("T")[0] + "T00:00:00";

    // Branch manager → une seule agence ; admin → toutes les agences de la marque
    let branchIds: string[];
    if (role === "branch_manager" && branch_id) {
      branchIds = [branch_id];
    } else {
      const { data: branches } = await supabase
        .from("branches")
        .select("id")
        .eq("brand_id", brand_id!);
      branchIds = (branches ?? []).map((b: any) => b.id);
    }

    if (branchIds.length === 0) {
      return sendSuccess(res, emptyDashboard());
    }

    // Commandes de la période
    const { data: orders } = await supabase
      .from("orders")
      .select("id, total, status, type, created_at, payment_method")
      .in("branch_id", branchIds)
      .gte("created_at", since);

    const allOrders = (orders ?? []) as any[];

    // Stats du jour
    const todayOrders = allOrders.filter((o) => o.created_at >= todayStart);
    const todayRevenue = todayOrders.filter((o) => o.status === "delivered").reduce((s: number, o: any) => s + (o.total ?? 0), 0);
    const todayAvg = todayOrders.length ? todayRevenue / todayOrders.filter((o) => o.status === "delivered").length : 0;

    // Stock en rupture (tous les produits de la marque sans stock)
    const { count: outOfStock } = await supabase
      .from("branch_stock")
      .select("id", { count: "exact" })
      .in("branch_id", branchIds)
      .eq("stock_qty", 0);

    // Commandes en attente (toutes, pas limitées à la période)
    const { count: pendingOrders } = await supabase
      .from("orders")
      .select("id", { count: "exact" })
      .in("branch_id", branchIds)
      .eq("status", "pending");

    // CA par jour (delivered orders uniquement)
    const deliveredOrders = allOrders.filter((o) => o.status === "delivered");
    const byDay: Record<string, { revenue: number; orders: number }> = {};
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().split("T")[0];
      byDay[d] = { revenue: 0, orders: 0 };
    }
    for (const o of allOrders) {
      const d = o.created_at.split("T")[0];
      if (byDay[d]) {
        byDay[d].orders++;
        if (o.status === "delivered") byDay[d].revenue += o.total ?? 0;
      }
    }
    const revenue_by_day = Object.entries(byDay).map(([date, v]) => ({ date, ...v }));

    // Top produits de la période
    const { data: itemsData } = await supabase
      .from("order_items")
      .select("quantity, unit_price, products(name_fr), orders!inner(branch_id, status, created_at)")
      .in("orders.branch_id", branchIds)
      .eq("orders.status", "delivered")
      .gte("orders.created_at", since);

    const productMap: Record<string, { name: string; revenue: number; quantity: number }> = {};
    for (const item of (itemsData ?? []) as any[]) {
      const name = item.products?.name_fr ?? "Inconnu";
      if (!productMap[name]) productMap[name] = { name, revenue: 0, quantity: 0 };
      productMap[name].revenue += (item.quantity ?? 0) * (item.unit_price ?? 0);
      productMap[name].quantity += item.quantity ?? 0;
    }
    const top_products = Object.values(productMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Répartition par statut
    const statusCount: Record<string, number> = {};
    for (const o of allOrders) {
      statusCount[o.status] = (statusCount[o.status] ?? 0) + 1;
    }
    const orders_by_status = Object.entries(statusCount).map(([status, count]) => ({ status, count }));

    // Répartition par type (collect / delivery)
    const typeCount: Record<string, number> = {};
    for (const o of allOrders) {
      typeCount[o.type ?? "delivery"] = (typeCount[o.type ?? "delivery"] ?? 0) + 1;
    }
    const orders_by_type = Object.entries(typeCount).map(([type, count]) => ({ type, count }));

    // Répartition par moyen de paiement
    const paymentCount: Record<string, number> = {};
    for (const o of allOrders) {
      paymentCount[o.payment_method ?? "unknown"] = (paymentCount[o.payment_method ?? "unknown"] ?? 0) + 1;
    }
    const orders_by_payment = Object.entries(paymentCount).map(([method, count]) => ({ method, count }));

    // Taux de conversion (delivered / total)
    const conversionRate = allOrders.length
      ? Math.round((deliveredOrders.length / allOrders.length) * 100)
      : 0;

    sendSuccess(res, {
      period_days: days,
      pending_orders: pendingOrders ?? 0,
      today: {
        revenue: Math.round(todayRevenue),
        orders: todayOrders.length,
        avg_order: Math.round(todayAvg),
        out_of_stock: outOfStock ?? 0,
      },
      period: {
        revenue: Math.round(deliveredOrders.reduce((s: number, o: any) => s + (o.total ?? 0), 0)),
        orders: allOrders.length,
        delivered: deliveredOrders.length,
        avg_order: deliveredOrders.length
          ? Math.round(deliveredOrders.reduce((s: number, o: any) => s + (o.total ?? 0), 0) / deliveredOrders.length)
          : 0,
        conversion_rate: conversionRate,
      },
      revenue_by_day,
      top_products,
      orders_by_status,
      orders_by_type,
      orders_by_payment,
    });
  } catch (err) {
    next(err);
  }
}

function emptyDashboard() {
  return {
    period_days: 30,
    pending_orders: 0,
    today: { revenue: 0, orders: 0, avg_order: 0, out_of_stock: 0 },
    period: { revenue: 0, orders: 0, delivered: 0, avg_order: 0, conversion_rate: 0 },
    revenue_by_day: [],
    top_products: [],
    orders_by_status: [],
    orders_by_type: [],
    orders_by_payment: [],
  };
}

// ─── GET /analytics/branches?days=7|30|90 ────────────────────────────────────
// CA + commandes par agence

export async function getBranchesStats(req: Request, res: Response, next: NextFunction) {
  try {
    const brand_id = req.user!.brand_id;
    if (!brand_id) throw new AppError(403, "FORBIDDEN", "Accès réservé aux admins de marque");

    const days = Math.max(1, Math.min(365, parseInt(req.query.days as string) || 30));
    const since = new Date(Date.now() - days * 86400_000).toISOString();

    const { data: branches } = await supabase
      .from("branches")
      .select("id, name")
      .eq("brand_id", brand_id);

    if (!branches || branches.length === 0) {
      return sendSuccess(res, []);
    }

    const results = await Promise.all(
      (branches as any[]).map(async (branch) => {
        const { data: orders } = await supabase
          .from("orders")
          .select("total, status")
          .eq("branch_id", branch.id)
          .gte("created_at", since);

        const all = orders ?? [];
        const delivered = (all as any[]).filter((o: any) => o.status === "delivered");
        const revenue = delivered.reduce((s: number, o: any) => s + (o.total ?? 0), 0);

        return {
          branch_id: branch.id,
          branch_name: branch.name,
          revenue: Math.round(revenue),
          orders: all.length,
          delivered: delivered.length,
        };
      })
    );

    sendSuccess(res, results.sort((a, b) => b.revenue - a.revenue));
  } catch (err) {
    next(err);
  }
}

// ─── GET /analytics/orders-stats ─────────────────────────────────────────────
export async function getOrdersStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { period = "week" } = req.query;
    sendSuccess(res, { period, stats: [] });
  } catch (err) {
    next(err);
  }
}

// ─── GET /analytics/top-products ─────────────────────────────────────────────
export async function getTopProducts(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("order_items")
      .select("product_id, quantity, products(name_fr)")
      .limit(10);
    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}

// ─── GET /analytics/revenue ───────────────────────────────────────────────────
export async function getRevenue(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, { revenue: 0 });
  } catch (err) {
    next(err);
  }
}

// ─── GET /analytics/branch/:branch_id ────────────────────────────────────────
export async function getBranchStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { branch_id } = req.params;

    if (req.user!.role === "admin") {
      const { data: branch } = await supabase.from("branches").select("brand_id").eq("id", branch_id).single();
      if (!branch || branch.brand_id !== req.user!.brand_id) {
        throw new AppError(403, "FORBIDDEN", "Accès refusé à cette agence");
      }
    }

    const [
      { count: totalOrders },
      { count: pendingOrders },
      { count: todayOrders },
      { data: revenueData },
      { data: statusData },
    ] = await Promise.all([
      supabase.from("orders").select("id", { count: "exact" }).eq("branch_id", branch_id),
      supabase.from("orders").select("id", { count: "exact" }).eq("branch_id", branch_id).eq("status", "pending"),
      supabase.from("orders").select("id", { count: "exact" })
        .eq("branch_id", branch_id)
        .gte("created_at", new Date().toISOString().split("T")[0] + "T00:00:00"),
      supabase.from("orders").select("total").eq("branch_id", branch_id).eq("status", "delivered"),
      supabase.from("orders").select("status").eq("branch_id", branch_id),
    ]);

    const totalRevenue = (revenueData ?? []).reduce((s: number, o: any) => s + (o.total ?? 0), 0);

    const byStatus: Record<string, number> = {};
    for (const o of (statusData ?? [])) {
      byStatus[(o as any).status] = (byStatus[(o as any).status] ?? 0) + 1;
    }

    sendSuccess(res, {
      total_orders: totalOrders ?? 0,
      pending_orders: pendingOrders ?? 0,
      today_orders: todayOrders ?? 0,
      total_revenue: Math.round(totalRevenue),
      by_status: byStatus,
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /analytics/platform (superadmin) ────────────────────────────────────
export async function getPlatformStats(req: Request, res: Response, next: NextFunction) {
  try {
    const days30ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [
      { count: activeBrands },
      { count: suspendedBrands },
      { count: totalUsers },
      { count: verifiedUsers },
      { count: totalOrders },
      { count: todayOrders },
      { count: deliveringOrders },
      { data: commissionsData },
      { count: pendingApplications },
      { count: approvedApplications },
      { count: rejectedApplications },
      { data: recentCommissions },
      { data: brandCommissions },
    ] = await Promise.all([
      supabase.from("brands").select("id", { count: "exact" }).eq("is_active", true),
      supabase.from("brands").select("id", { count: "exact" }).eq("is_active", false),
      supabase.from("users").select("id", { count: "exact" }),
      supabase.from("users").select("id", { count: "exact" }).eq("is_verified", true),
      supabase.from("orders").select("id", { count: "exact" }),
      supabase.from("orders").select("id", { count: "exact" }).gte("created_at", new Date().toISOString().split("T")[0] + "T00:00:00"),
      supabase.from("orders").select("id", { count: "exact" }).eq("status", "delivering"),
      supabase.from("commissions").select("amount, is_settled, type"),
      supabase.from("brand_applications").select("id", { count: "exact" }).eq("status", "pending"),
      supabase.from("brand_applications").select("id", { count: "exact" }).eq("status", "approved"),
      supabase.from("brand_applications").select("id", { count: "exact" }).eq("status", "rejected"),
      supabase.from("commissions").select("amount, type, created_at").gte("created_at", days30ago),
      supabase.from("commissions").select("amount, type, brand_id, brands(name)").eq("is_settled", false),
    ]);

    const commissions = (commissionsData ?? []) as { amount: number; is_settled: boolean; type: string }[];
    const gmvOnline = commissions.filter(c => c.type === "online").reduce((s, c) => s + (c.amount / 0.02), 0);
    const gmvInperson = commissions.filter(c => c.type === "inperson").reduce((s, c) => s + (c.amount / 0.015), 0);
    const commTotal = commissions.reduce((s, c) => s + c.amount, 0);
    const commSettled = commissions.filter(c => c.is_settled).reduce((s, c) => s + c.amount, 0);
    const commPending = commissions.filter(c => !c.is_settled).reduce((s, c) => s + c.amount, 0);

    // GMV par jour sur 30 jours — agréger les commissions par date
    const gmvDayMap: Record<string, number> = {};
    for (const c of (recentCommissions ?? []) as { amount: number; type: string; created_at: string }[]) {
      const day = c.created_at.split("T")[0];
      const gmv = c.type === "online" ? c.amount / 0.02 : c.amount / 0.015;
      gmvDayMap[day] = (gmvDayMap[day] ?? 0) + gmv;
    }
    const gmv_by_day = Object.entries(gmvDayMap)
      .map(([date, gmv]) => ({ date, gmv: Math.round(gmv) }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Top marques par volume de commission en attente de règlement
    const brandMap: Record<string, { name: string; total: number }> = {};
    for (const c of (brandCommissions ?? []) as unknown as { amount: number; brand_id: string; brands: { name: string } | null }[]) {
      if (!c.brand_id) continue;
      const name = c.brands?.name ?? c.brand_id;
      if (!brandMap[c.brand_id]) brandMap[c.brand_id] = { name, total: 0 };
      brandMap[c.brand_id].total += c.amount;
    }
    const top_brands = Object.values(brandMap)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5)
      .map(b => ({ name: b.name, commission: Math.round(b.total) }));

    sendSuccess(res, {
      brands: { total: (activeBrands ?? 0) + (suspendedBrands ?? 0), active: activeBrands ?? 0, suspended: suspendedBrands ?? 0 },
      users: { total: totalUsers ?? 0, verified: verifiedUsers ?? 0 },
      orders: { total: totalOrders ?? 0, today: todayOrders ?? 0, delivering: deliveringOrders ?? 0 },
      revenue: { gmv_total: Math.round(gmvOnline + gmvInperson), gmv_online: Math.round(gmvOnline), gmv_inperson: Math.round(gmvInperson) },
      commissions: { total: Math.round(commTotal), pending: Math.round(commPending), settled: Math.round(commSettled) },
      applications: { pending: pendingApplications ?? 0, approved: approvedApplications ?? 0, rejected: rejectedApplications ?? 0 },
      gmv_by_day,
      top_brands,
    });
  } catch (err) {
    next(err);
  }
}

// ─── GET /analytics/commissions (superadmin) ─────────────────────────────────
export async function getCommissionsOverview(req: Request, res: Response, next: NextFunction) {
  try {
    const { data, error } = await supabase
      .from("commissions")
      .select("type, amount, is_settled, brands(name)")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) throw new AppError(500, "FETCH_ERROR", "Erreur lors de la récupération");

    const total_online = (data ?? []).filter(c => c.type === "online").reduce((sum, c) => sum + c.amount, 0);
    const total_inperson = (data ?? []).filter(c => c.type === "inperson").reduce((sum, c) => sum + c.amount, 0);
    const pending = (data ?? []).filter(c => !c.is_settled).reduce((sum, c) => sum + c.amount, 0);

    sendSuccess(res, { total_online, total_inperson, pending_settlement: pending, entries: data });
  } catch (err) {
    next(err);
  }
}
