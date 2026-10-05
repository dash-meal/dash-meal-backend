import jwt from "jsonwebtoken";

// Stockage en mémoire des tokens révoqués : token -> timestamp d'expiration (ms)
const revokedTokens = new Map<string, number>();

/**
 * Révoque un token JWT en l'ajoutant à la liste noire jusqu'à son expiration naturelle.
 */
export function revokeToken(token: string, fallbackTtlMs = 24 * 60 * 60 * 1000): void {
  if (!token) return;

  let expiresAt: number = Date.now() + fallbackTtlMs;
  try {
    const decoded = jwt.decode(token) as { exp?: number } | null;
    if (decoded?.exp) {
      expiresAt = decoded.exp * 1000;
    }
  } catch {
    // Si le décodage échoue, on conserve le fallback TTL
  }

  // Si le token n'est pas déjà expiré, on l'ajoute à la blacklist
  if (expiresAt > Date.now()) {
    revokedTokens.set(token, expiresAt);
  }
}

/**
 * Vérifie si un token a été révoqué.
 */
export function isTokenRevoked(token: string): boolean {
  if (!token) return false;
  const expiresAt = revokedTokens.get(token);
  if (!expiresAt) return false;

  // Si le token est désormais expiré naturellement, le retirer de la mémoire
  if (Date.now() > expiresAt) {
    revokedTokens.delete(token);
    return false;
  }

  return true;
}

/**
 * Purge les tokens expirés pour libérer la mémoire.
 */
export function cleanupRevokedTokens(): void {
  const now = Date.now();
  for (const [token, expiresAt] of revokedTokens.entries()) {
    if (now > expiresAt) {
      revokedTokens.delete(token);
    }
  }
}

/**
 * Vider la liste noire (utilisé principalement pour les tests unitaires).
 */
export function clearTokenBlacklist(): void {
  revokedTokens.clear();
}
