import { supabase } from "../config/supabase.js";

type LogActivityParams = {
  actor_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  metadata?: Record<string, unknown>;
  ip_address?: string;
};

/**
 * Insère une entrée dans activity_logs.
 * Best-effort : ne lève jamais d'exception (évite de bloquer la réponse principale).
 */
export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    await supabase.from("activity_logs").insert({
      actor_id: params.actor_id,
      actor_role: params.actor_role,
      action: params.action,
      resource_type: params.resource_type,
      resource_id: params.resource_id ?? null,
      metadata: params.metadata ?? null,
      ip_address: params.ip_address ?? null,
    });
  } catch {
    // Silencieux — les logs ne doivent pas impacter la réponse
  }
}
