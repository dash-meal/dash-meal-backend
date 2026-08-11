import type { Request, Response, NextFunction } from "express";
import { env } from "../../config/env.js";
import { sendSuccess } from "../../utils/response.js";
import { AppError } from "../../middleware/errorHandler.js";

const MAPS_BASE = "https://maps.googleapis.com/maps/api";

// ─── Autocomplete ─────────────────────────────────────────────────────────────
// GET /maps/autocomplete?input=<text>&sessiontoken=<uuid>
export async function autocomplete(req: Request, res: Response, next: NextFunction) {
  try {
    const { input, sessiontoken, language = "fr" } = req.query;
    if (!input || String(input).trim().length < 2) {
      sendSuccess(res, []);
      return;
    }

    const params = new URLSearchParams({
      input: String(input),
      key: env.GOOGLE_MAPS_API_KEY,
      language: String(language),
      // Prioritise Central Africa but don't hard-restrict to one country
      location: "3.848,11.502", // centre Yaoundé approx
      radius: "500000",         // 500 km radius bias
      ...(sessiontoken ? { sessiontoken: String(sessiontoken) } : {}),
    });

    const resp = await fetch(`${MAPS_BASE}/place/autocomplete/json?${params}`);
    if (!resp.ok) throw new AppError(502, "MAPS_ERROR", "Erreur Google Places");

    const data = await resp.json() as {
      status: string;
      predictions: Array<{ place_id: string; description: string }>;
      error_message?: string;
    };

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error("[Maps] Autocomplete error:", data.status, data.error_message);
      sendSuccess(res, []);
      return;
    }

    sendSuccess(res, (data.predictions ?? []).map((p) => ({
      place_id: p.place_id,
      description: p.description,
    })));
  } catch (err) {
    next(err);
  }
}

// ─── Place details ─────────────────────────────────────────────────────────────
// GET /maps/place?place_id=<id>&sessiontoken=<uuid>
export async function placeDetails(req: Request, res: Response, next: NextFunction) {
  try {
    const { place_id, sessiontoken } = req.query;
    if (!place_id) throw new AppError(400, "MISSING_PARAM", "Paramètre 'place_id' requis");

    const params = new URLSearchParams({
      place_id: String(place_id),
      fields: "geometry,formatted_address",
      key: env.GOOGLE_MAPS_API_KEY,
      language: "fr",
      ...(sessiontoken ? { sessiontoken: String(sessiontoken) } : {}),
    });

    const resp = await fetch(`${MAPS_BASE}/place/details/json?${params}`);
    if (!resp.ok) throw new AppError(502, "MAPS_ERROR", "Erreur Google Places Details");

    const data = await resp.json() as {
      status: string;
      result?: {
        formatted_address: string;
        geometry: { location: { lat: number; lng: number } };
      };
      error_message?: string;
    };

    if (data.status !== "OK" || !data.result) {
      console.error("[Maps] PlaceDetails error:", data.status, data.error_message);
      throw new AppError(502, "MAPS_ERROR", `Google Places Details: ${data.status}`);
    }

    sendSuccess(res, {
      formatted_address: data.result.formatted_address,
      lat: data.result.geometry.location.lat,
      lng: data.result.geometry.location.lng,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Reverse geocoding ────────────────────────────────────────────────────────
// GET /maps/reverse?lat=<lat>&lng=<lng>
export async function reverseGeocode(req: Request, res: Response, next: NextFunction) {
  try {
    const { lat, lng } = req.query;
    if (!lat || !lng) throw new AppError(400, "MISSING_PARAM", "Paramètres 'lat' et 'lng' requis");

    const latNum = parseFloat(String(lat));
    const lngNum = parseFloat(String(lng));
    if (isNaN(latNum) || isNaN(lngNum)) {
      throw new AppError(400, "INVALID_PARAM", "Coordonnées invalides");
    }

    const params = new URLSearchParams({
      latlng: `${latNum},${lngNum}`,
      key: env.GOOGLE_MAPS_API_KEY,
      language: "fr",
    });

    const resp = await fetch(`${MAPS_BASE}/geocode/json?${params}`);
    if (!resp.ok) throw new AppError(502, "MAPS_ERROR", "Erreur Google Geocoding");

    type AddressComponent = { long_name: string; short_name: string; types: string[] };
    const data = await resp.json() as {
      status: string;
      results: Array<{ formatted_address: string; address_components: AddressComponent[] }>;
    };

    if (data.status !== "OK" || !data.results.length) {
      sendSuccess(res, { formatted_address: null, neighborhood: null, route: null, lat: latNum, lng: lngNum });
      return;
    }

    const result = data.results[0];
    const components = result.address_components ?? [];

    // Extraire les composants pertinents (quartier, rue, secteur)
    const get = (...types: string[]) =>
      components.find((c) => types.some((t) => c.types.includes(t)))?.long_name ?? null;

    const neighborhood = get("sublocality_level_1", "sublocality", "neighborhood");
    const route        = get("route", "premise");
    const locality     = get("locality", "administrative_area_level_2");
    const country      = get("country");

    // Construire un label court et précis : "Quartier Bastos, Rue Kennedy, Yaoundé"
    const parts = [neighborhood, route, locality].filter(Boolean);
    const short_address = parts.length > 0 ? parts.join(", ") : result.formatted_address;

    sendSuccess(res, {
      formatted_address: result.formatted_address,
      short_address,
      neighborhood,
      route,
      locality,
      country,
      lat: latNum,
      lng: lngNum,
    });
  } catch (err) {
    next(err);
  }
}

// ─── Static map image proxy ───────────────────────────────────────────────────
// GET /maps/staticmap?driverlat=&driverlng=&destlat=&destlng=&zoom=14&size=600x300
// Public endpoint — proxies Google Static Maps, API key stays server-side.
export async function staticMap(req: Request, res: Response, next: NextFunction) {
  try {
    const {
      driverlat, driverlng,   // livreur (optionnel)
      destlat, destlng,       // destination (optionnel)
      zoom = "14",
      w, h,                   // dimensions en pixels (priorité sur size)
      size,                   // fallback legacy "WxH"
    } = req.query;

    const hasDriver = !!(driverlat && driverlng);
    const hasDest   = !!(destlat && destlng);

    if (!hasDriver && !hasDest) {
      throw new AppError(400, "MISSING_PARAM", "Au moins driverlat/driverlng ou destlat/destlng est requis");
    }

    // Center: driver first, then destination
    const centerLat = hasDriver ? driverlat : destlat;
    const centerLng = hasDriver ? driverlng : destlng;

    // Google Static Maps max size is 640x640; scale=2 already doubles pixel density
    const imgW = w ? Math.min(Number(w), 640) : 600;
    const imgH = h ? Math.min(Number(h), 640) : 300;
    const imgSize = size ? String(size) : `${imgW}x${imgH}`;

    // Build query string manually (duplicate keys not supported by URLSearchParams)
    const parts: string[] = [
      `center=${centerLat},${centerLng}`,
      `zoom=${zoom}`,
      `size=${imgSize}`,
      `scale=2`,
      `language=fr`,
      `maptype=roadmap`,
      `key=${env.GOOGLE_MAPS_API_KEY}`,
    ];

    // Destination marker — red pin
    if (hasDest) {
      parts.push(`markers=color:red%7Clabel:D%7C${destlat},${destlng}`);
    }

    // Driver marker — blue pin
    if (hasDriver) {
      parts.push(`markers=color:blue%7Clabel:L%7C${driverlat},${driverlng}`);
    }

    const mapUrl = `${MAPS_BASE}/staticmap?${parts.join("&")}`;

    const imgResp = await fetch(mapUrl);
    if (!imgResp.ok) {
      throw new AppError(502, "MAPS_ERROR", `Google Static Maps erreur (${imgResp.status})`);
    }

    const contentType = imgResp.headers.get("content-type") ?? "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache, max-age=0");

    const buffer = await imgResp.arrayBuffer();
    res.end(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
}
