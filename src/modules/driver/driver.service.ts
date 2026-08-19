import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";

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

