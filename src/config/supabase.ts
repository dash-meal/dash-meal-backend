import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

// Client avec service_role — uniquement côté backend, jamais exposé au client
export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
