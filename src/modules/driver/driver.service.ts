import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";

export async function getDeliveries(driverId: string, status?: string) {
  let query = supabase
    .from("deliveries")
    .select(`
      id, status, pickup_address, delivery_address, distance_km,
      earnings_amount, created_at, delivered_at,
      order:orders(id, total_amount, branch:branches(name, address))
    `)
    .eq("driver_id", driverId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (status) {
    query = query.eq("status", status);
  } else {
    // Active deliveries by default (pending + in progress)
    query = query.in("status", ["assigned", "accepted", "picked_up"]);
  }

  const { data, error } = await query;
  if (error) throw new AppError(500, "DB_ERROR", error.message);
  return data ?? [];
}

export async function updateDeliveryStatus(driverId: string, deliveryId: string, status: string) {
  const updates: Record<string, unknown> = { status };
  if (status === "delivered") updates.delivered_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("deliveries")
    .update(updates)
    .eq("id", deliveryId)
    .eq("driver_id", driverId)
    .select()
    .single();

  if (!data) throw new AppError(404, "NOT_FOUND", "Livraison introuvable");
  if (error) throw new AppError(500, "DB_ERROR", error.message);
  return data;
}

export async function getEarnings(driverId: string, period: string) {
  let from: string;
  const now = new Date();

  if (period === "today") {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  } else if (period === "week") {
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    from = new Date(now.setDate(diff)).toISOString();
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }

  const { data, error } = await supabase
    .from("deliveries")
    .select("id, earnings_amount, delivered_at, created_at")
    .eq("driver_id", driverId)
    .eq("status", "delivered")
    .gte("delivered_at", from)
    .order("delivered_at", { ascending: false });

  if (error) throw new AppError(500, "DB_ERROR", error.message);

  const deliveries = data ?? [];
  const total = deliveries.reduce((sum, d) => sum + (d.earnings_amount ?? 0), 0);

  // Group by day
  const byDay: Record<string, number> = {};
  for (const d of deliveries) {
    const day = (d.delivered_at ?? d.created_at).split("T")[0];
    byDay[day] = (byDay[day] ?? 0) + (d.earnings_amount ?? 0);
  }

  return {
    total,
    count: deliveries.length,
    period,
    by_day: Object.entries(byDay).map(([date, amount]) => ({ date, amount })),
  };
}

export async function getProfile(driverId: string) {
  const { data, error } = await supabase
    .from("drivers")
    .select("id, name, phone, vehicle_type, photo_url, is_active, is_online, branch_id, brand_id, created_at")
    .eq("id", driverId)
    .single();

  if (error?.code === "PGRST116") throw new AppError(404, "NOT_FOUND", "Profil introuvable");
  if (error) throw new AppError(500, "DB_ERROR", error.message);
  return data;
}

export async function updateProfile(driverId: string, updates: { name?: string; vehicle_type?: string }) {
  const { data, error } = await supabase
    .from("drivers")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", driverId)
    .select()
    .single();

  if (!data) throw new AppError(404, "NOT_FOUND", "Profil introuvable");
  if (error) throw new AppError(500, "DB_ERROR", error.message);
  return data;
}

export async function updateAvailability(driverId: string, isOnline: boolean) {
  const { data, error } = await supabase
    .from("drivers")
    .update({ is_online: isOnline, updated_at: new Date().toISOString() })
    .eq("id", driverId)
    .select("id, is_online")
    .single();

  if (error) throw new AppError(500, "DB_ERROR", error.message);
  return data;
}

export async function updateLocation(driverId: string, lat: number, lng: number) {
  const { error } = await supabase
    .from("drivers")
    .update({
      current_lat: lat,
      current_lng: lng,
      location_updated_at: new Date().toISOString(),
    })
    .eq("id", driverId);

  if (error) throw new AppError(500, "DB_ERROR", error.message);
  return { updated: true };
}
