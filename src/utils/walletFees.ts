// ─── Frais de retrait des wallets ─────────────────────────────────────────────
// Source unique des taux de frais appliqués lors d'un retrait Mobile Money.
// Le wallet livreur (driver-wallet) n'applique aucun frais de retrait.

export const BRANCH_WITHDRAWAL_FEE_RATE = 0.015; // 1.5% — wallet agence (admin de marque)
export const USER_WITHDRAWAL_FEE_RATE   = 0.02;  // 2%   — wallet client
export const USER_WITHDRAWAL_MIN_FEE    = 1;     // 1 FCFA minimum côté client

export function computeWithdrawalFee(
  amount: number,
  rate: number,
  minFee = 0,
): { fee: number; net: number } {
  const fee = Math.max(Math.round(amount * rate), minFee);
  return { fee, net: amount - fee };
}
