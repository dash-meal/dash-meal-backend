/**
 * Keep-Alive
 *
 * Render (plan gratuit) met le service en veille après une période sans
 * requête entrante. On s'auto-ping périodiquement pour rester éveillé.
 * L'intervalle est randomisé (entre MIN et MAX) pour éviter un pattern trop
 * régulier, avec une moyenne visée d'environ 10 min.
 */

import axios from "axios";
import { API_PREFIX } from "../shared/index.js";

const MIN_INTERVAL_MS =  6 * 60 * 1000; //  6 min
const MAX_INTERVAL_MS = 10 * 60 * 1000; // 10 min

function nextDelay(): number {
  return MIN_INTERVAL_MS + Math.floor(Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

async function ping(baseUrl: string) {
  try {
    await axios.get(`${baseUrl}${API_PREFIX}/health`, { timeout: 15_000 });
    console.log("[KeepAlive] Ping OK");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[KeepAlive] Ping échoué : ${message}`);
  }
}

export function startKeepAlive() {
  const baseUrl = process.env.RENDER_EXTERNAL_URL ?? "https://dashmeal-3ix5.onrender.com";

  const schedule = () => {
    setTimeout(() => {
      ping(baseUrl);
      schedule();
    }, nextDelay());
  };

  console.log(`[KeepAlive] Démarré — ping ${baseUrl}${API_PREFIX}/health toutes les 6 à 10 min`);
  schedule();
}
