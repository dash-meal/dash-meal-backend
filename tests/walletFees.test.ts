import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeWithdrawalFee,
  BRANCH_WITHDRAWAL_FEE_RATE,
  USER_WITHDRAWAL_FEE_RATE,
  USER_WITHDRAWAL_MIN_FEE,
} from "../src/utils/walletFees.js";

// Formules d'origine (avant refactoring #14), recopiées telles quelles
const legacyBranch = (a: number) => { const fee = Math.round(a * 0.015); return { fee, net: a - fee }; };
const legacyUser   = (a: number) => { const fee = Math.max(Math.round(a * 0.02), 1); return { fee, net: a - fee }; };

const amounts = [1, 10, 33, 34, 99, 100, 500, 501, 1234, 9999, 10_000, 123_457, 1_000_000];

test("wallet agence : frais 1.5% identiques à l'ancienne formule", () => {
  for (const a of amounts) {
    assert.deepEqual(computeWithdrawalFee(a, BRANCH_WITHDRAWAL_FEE_RATE), legacyBranch(a), `amount=${a}`);
  }
});

test("wallet client : frais 2% (min 1 FCFA) identiques à l'ancienne formule", () => {
  for (const a of amounts) {
    assert.deepEqual(
      computeWithdrawalFee(a, USER_WITHDRAWAL_FEE_RATE, USER_WITHDRAWAL_MIN_FEE),
      legacyUser(a),
      `amount=${a}`,
    );
  }
});

test("valeurs de référence", () => {
  assert.deepEqual(computeWithdrawalFee(10_000, BRANCH_WITHDRAWAL_FEE_RATE), { fee: 150, net: 9850 });
  assert.deepEqual(computeWithdrawalFee(500, USER_WITHDRAWAL_FEE_RATE, USER_WITHDRAWAL_MIN_FEE), { fee: 10, net: 490 });
  assert.deepEqual(computeWithdrawalFee(10, USER_WITHDRAWAL_FEE_RATE, USER_WITHDRAWAL_MIN_FEE), { fee: 1, net: 9 });
});
