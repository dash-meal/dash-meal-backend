import { describe, it, expect, vi } from "vitest";

// user-wallet.routes.ts importe middleware/auth.js (authenticate/requireRole),
// qui charge config/env.js et config/supabase.js au niveau module. On les
// mocke pour rester isolé, comme pour les autres suites de tests.
vi.mock("../../config/supabase.js", () => ({ supabase: { from: vi.fn() } }));
vi.mock("../../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(32), JWT_REFRESH_SECRET: "y".repeat(32) },
}));

const {
  ActivateSchema,
  TopUpSchema,
  VerifyPinSchema,
  TransferSchema,
  WithdrawSchema,
} = await import("./user-wallet.routes.js");

const validActivate = {
  card_number: "12345678",
  pin: "1234",
  payment_phone: "670000000",
  payment_method: "orange_money",
  initial_amount: 500,
};

describe("ActivateSchema", () => {
  it("accepte une charge utile valide", () => {
    expect(ActivateSchema.safeParse(validActivate).success).toBe(true);
  });

  it("rejette un montant non numérique (contournait auparavant le contrôle 'amount < 10' en JS)", () => {
    const result = ActivateSchema.safeParse({ ...validActivate, initial_amount: "abc" });
    expect(result.success).toBe(false);
  });

  it("rejette un dépôt initial sous le minimum (10 FCFA)", () => {
    const result = ActivateSchema.safeParse({ ...validActivate, initial_amount: 5 });
    expect(result.success).toBe(false);
  });

  it("rejette un numéro de carte qui n'est pas exactement 8 chiffres", () => {
    expect(ActivateSchema.safeParse({ ...validActivate, card_number: "123" }).success).toBe(false);
    expect(ActivateSchema.safeParse({ ...validActivate, card_number: "abcdefgh" }).success).toBe(false);
  });

  it("rejette un pin trop court ou trop long", () => {
    expect(ActivateSchema.safeParse({ ...validActivate, pin: "12" }).success).toBe(false);
    expect(ActivateSchema.safeParse({ ...validActivate, pin: "123456789" }).success).toBe(false);
  });

  it("rejette une méthode de paiement inconnue", () => {
    expect(ActivateSchema.safeParse({ ...validActivate, payment_method: "bitcoin" }).success).toBe(false);
  });
});

describe("TopUpSchema", () => {
  it("accepte un montant numérique valide", () => {
    expect(TopUpSchema.safeParse({ amount: 1000, phone: "670000000" }).success).toBe(true);
  });

  it("rejette un montant sous le minimum (10 FCFA)", () => {
    expect(TopUpSchema.safeParse({ amount: 5, phone: "670000000" }).success).toBe(false);
  });

  it("rejette un montant fourni en chaîne de caractères", () => {
    // amount:"abc" < 10 → false en JS : le contrôle manuel était silencieusement
    // contourné. Le schéma Zod doit rejeter avant même d'atteindre le service.
    expect(TopUpSchema.safeParse({ amount: "abc", phone: "670000000" }).success).toBe(false);
    expect(TopUpSchema.safeParse({ amount: "5", phone: "670000000" }).success).toBe(false);
  });

  it("rejette un téléphone trop court", () => {
    expect(TopUpSchema.safeParse({ amount: 1000, phone: "12" }).success).toBe(false);
  });
});

describe("VerifyPinSchema", () => {
  it("accepte un pin de longueur valide", () => {
    expect(VerifyPinSchema.safeParse({ pin: "1234" }).success).toBe(true);
  });

  it("rejette un pin manquant ou vide", () => {
    expect(VerifyPinSchema.safeParse({}).success).toBe(false);
    expect(VerifyPinSchema.safeParse({ pin: "" }).success).toBe(false);
  });
});

describe("TransferSchema", () => {
  it("accepte un identifiant carte ou email avec un montant valide", () => {
    expect(TransferSchema.safeParse({ identifier: "12345678", amount: 500 }).success).toBe(true);
    expect(TransferSchema.safeParse({ identifier: "a@b.com", amount: 500 }).success).toBe(true);
  });

  it("rejette un montant sous le minimum de transfert (100 FCFA)", () => {
    expect(TransferSchema.safeParse({ identifier: "12345678", amount: 50 }).success).toBe(false);
  });

  it("rejette un montant non numérique", () => {
    expect(TransferSchema.safeParse({ identifier: "12345678", amount: "100" }).success).toBe(false);
  });
});

describe("WithdrawSchema", () => {
  it("accepte un retrait valide avec téléphones identiques", () => {
    const result = WithdrawSchema.safeParse({ amount: 1000, phone: "670000000", phone_confirm: "670000000" });
    expect(result.success).toBe(true);
  });

  it("rejette un montant sous le minimum de retrait (500 FCFA)", () => {
    expect(WithdrawSchema.safeParse({ amount: 100, phone: "670000000", phone_confirm: "670000000" }).success).toBe(false);
  });

  it("rejette si les deux numéros de téléphone ne correspondent pas (avant même d'appeler le service)", () => {
    const result = WithdrawSchema.safeParse({ amount: 1000, phone: "670000000", phone_confirm: "680000000" });
    expect(result.success).toBe(false);
  });

  it("rejette un montant non numérique (contournait le contrôle manuel amount < 500)", () => {
    expect(WithdrawSchema.safeParse({ amount: "abc", phone: "670000000", phone_confirm: "670000000" }).success).toBe(false);
  });
});
