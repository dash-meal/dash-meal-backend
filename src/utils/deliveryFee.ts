import { supabase } from "../config/supabase.js";
import { AppError } from "../middleware/errorHandler.js";

interface LatLng {
  lat: number;
  lng: number;
}

export interface DeliveryQuote {
  zone_id: string;
  delivery_fee: number;
  estimated_min: number | null;
}

/**
 * Test point-dans-polygone (ray casting). lng = axe X, lat = axe Y.
 * Suffisant à l'échelle d'une ville (pas de polygones traversant l'antiméridien).
 */
function isPointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i].lng), yi = Number(polygon[i].lat);
    const xj = Number(polygon[j].lng), yj = Number(polygon[j].lat);
    const intersects =
      (yi > point.lat) !== (yj > point.lat) &&
      point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Calcule les frais de livraison d'une commande à partir des zones de
 * livraison actives de l'agence (module delivery-zones).
 *
 * - Zones qui se chevauchent : la moins chère l'emporte (même ordre que
 *   l'endpoint public /delivery-zones/public/:branch_id vu par le client).
 * - Refuse la commande (400) si pas de coordonnées, aucune zone configurée,
 *   adresse hors zone, ou minimum de commande de la zone non atteint.
 */
export async function getDeliveryQuote(params: {
  branch_id: string;
  lat: number | null | undefined;
  lng: number | null | undefined;
  subtotal: number;
}): Promise<DeliveryQuote> {
  const { branch_id, lat, lng, subtotal } = params;

  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new AppError(400, "DELIVERY_LOCATION_REQUIRED", "Coordonnées GPS de livraison requises");
  }

  const { data: zones, error } = await supabase
    .from("delivery_zones")
    .select("id, delivery_fee, min_order, estimated_min, polygon")
    .eq("branch_id", branch_id)
    .eq("is_active", true)
    .order("delivery_fee", { ascending: true });

  if (error) throw new AppError(500, "DB_ERROR", error.message);
  if (!zones?.length) {
    throw new AppError(400, "DELIVERY_NOT_AVAILABLE", "Cette agence ne propose pas encore la livraison");
  }

  const zone = zones.find(
    (z) => Array.isArray(z.polygon) && z.polygon.length >= 3 && isPointInPolygon({ lat, lng }, z.polygon as LatLng[])
  );
  if (!zone) {
    throw new AppError(400, "OUT_OF_DELIVERY_ZONE", "Cette adresse est hors de la zone de livraison de l'agence");
  }

  const minOrder = zone.min_order != null ? Number(zone.min_order) : 0;
  if (subtotal < minOrder) {
    throw new AppError(400, "MIN_ORDER_NOT_MET", `Montant minimum de commande pour cette zone : ${minOrder} FCFA`);
  }

  return {
    zone_id: zone.id,
    delivery_fee: Number(zone.delivery_fee),
    estimated_min: zone.estimated_min != null ? Number(zone.estimated_min) : null,
  };
}
