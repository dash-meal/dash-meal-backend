import type { Request, Response, NextFunction } from "express";
import { supabase } from "../../config/supabase.js";
import { AppError } from "../../middleware/errorHandler.js";
import { sendSuccess } from "../../utils/response.js";

export async function updateLocation(req: Request, res: Response, next: NextFunction) {
  try {
    const driverId = req.user!.id;
    const { lat, lng, heading, speed } = req.body as {
      lat: number;
      lng: number;
      heading?: number;
      speed?: number;
    };

    if (lat === undefined || lng === undefined) {
      throw new AppError(400, "MISSING_COORDINATES", "lat et lng sont requis");
    }

    const { error } = await supabase
      .from("driver_locations")
      .upsert(
        {
          driver_id: driverId,
          lat: Number(lat),
          lng: Number(lng),
          heading: heading !== undefined ? Number(heading) : null,
          speed: speed !== undefined ? Number(speed) : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "driver_id" }
      );

    if (error) throw new AppError(500, "DB_ERROR", error.message);

    sendSuccess(res, null, "Position mise à jour");
  } catch (err) {
    next(err);
  }
}

export async function getDeliveryLocation(req: Request, res: Response, next: NextFunction) {
  try {
    const { order_id } = req.params;
    const user = req.user!;

    // Récupérer la livraison active pour cette commande
    const { data: delivery, error: deliveryErr } = await supabase
      .from("deliveries")
      .select("id, driver_id, status, order_id")
      .eq("order_id", order_id)
      .in("status", ["assigned", "picked_up", "on_the_way"])
      .maybeSingle();

    if (deliveryErr) throw new AppError(500, "DB_ERROR", deliveryErr.message);
    if (!delivery) throw new AppError(404, "NO_ACTIVE_DELIVERY", "Aucune livraison active pour cette commande");
    if (!delivery.driver_id) throw new AppError(404, "NO_DRIVER_ASSIGNED", "Aucun livreur assigné");

    // Vérifier l'accès : l'utilisateur doit être le propriétaire de la commande ou admin
    if (user.role === "user") {
      const { data: order } = await supabase
        .from("orders")
        .select("user_id")
        .eq("id", order_id)
        .single();

      if (!order || order.user_id !== user.id) {
        throw new AppError(403, "FORBIDDEN", "Accès refusé à cette livraison");
      }
    }

    // Récupérer la position du livreur
    const { data: location, error: locErr } = await supabase
      .from("driver_locations")
      .select("lat, lng, heading, speed, updated_at")
      .eq("driver_id", delivery.driver_id)
      .maybeSingle();

    if (locErr) throw new AppError(500, "DB_ERROR", locErr.message);
    if (!location) throw new AppError(404, "LOCATION_NOT_FOUND", "Position du livreur non disponible");

    sendSuccess(res, {
      driver_id: delivery.driver_id,
      delivery_id: delivery.id,
      delivery_status: delivery.status,
      ...location,
    });
  } catch (err) {
    next(err);
  }
}

export async function getDriverLocation(req: Request, res: Response, next: NextFunction) {
  try {
    const { driver_id } = req.params;
    const user = req.user!;

    // Vérifier isolation marque pour admin
    if (user.role === "admin") {
      const { data: driver } = await supabase
        .from("drivers")
        .select("brand_id")
        .eq("id", driver_id)
        .single();

      if (!driver || driver.brand_id !== user.brand_id) {
        throw new AppError(403, "FORBIDDEN", "Ce livreur n'appartient pas à votre marque");
      }
    }

    const { data, error } = await supabase
      .from("driver_locations")
      .select("driver_id, lat, lng, heading, speed, updated_at")
      .eq("driver_id", driver_id)
      .maybeSingle();

    if (error) throw new AppError(500, "DB_ERROR", error.message);
    if (!data) throw new AppError(404, "LOCATION_NOT_FOUND", "Position du livreur non disponible");

    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}
