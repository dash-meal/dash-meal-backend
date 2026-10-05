import { describe, it, expect, beforeEach, vi } from "vitest";

const { fromMock, selectMock, eqMock, singleMock, insertMock, orMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  selectMock: vi.fn(),
  eqMock: vi.fn(),
  singleMock: vi.fn(),
  insertMock: vi.fn(),
  orMock: vi.fn(),
}));

vi.mock("../../config/supabase.js", () => ({
  supabase: {
    from: fromMock,
  },
}));

vi.mock("../../config/env.js", () => ({
  env: {
    JWT_SECRET: "x".repeat(32),
    JWT_REFRESH_SECRET: "y".repeat(32),
    SUPERADMIN_BOOTSTRAP_SECRET: "expected-secret-123",
  },
}));

const { registerSuperAdmin } = await import("./auth.service.js");
const { isTokenRevoked, revokeToken, clearTokenBlacklist } = await import("../../utils/tokenBlacklist.js");

describe("registerSuperAdmin security (Issue #7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("bloque la création publique si un superadmin existe déjà", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "super_admins") {
        return {
          select: vi.fn().mockReturnValue({ count: 1, error: null }),
        };
      }
      return {};
    });

    await expect(
      registerSuperAdmin({
        email: "attacker@dash-meal.com",
        phone: "+237699999999",
        password: "ValidPassword123!",
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
  });

  it("permet à un superadmin authentifié de créer un autre superadmin", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "super_admins") {
        return {
          select: vi.fn().mockImplementation((_fields, opts) => {
            if (opts?.head) return Promise.resolve({ count: 1, error: null });
            return {
              or: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            };
          }),
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: "new-sa", email: "new@dash-meal.com", phone: "+237699999999" },
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    const result = await registerSuperAdmin(
      {
        email: "new@dash-meal.com",
        phone: "+237699999999",
        password: "ValidPassword123!",
      },
      { id: "sa-1", role: "superadmin" }
    );

    expect(result.admin).toMatchObject({ email: "new@dash-meal.com" });
    expect(result.tokens).toBeDefined();
  });

  it("permet l'amorçage avec le secret bootstrap", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "super_admins") {
        return {
          select: vi.fn().mockImplementation((_fields, opts) => {
            if (opts?.head) return Promise.resolve({ count: 1, error: null });
            return {
              or: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            };
          }),
          insert: vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: "new-sa", email: "sa@dash-meal.com", phone: "+237699999999" },
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    const result = await registerSuperAdmin({
      email: "sa@dash-meal.com",
      phone: "+237699999999",
      password: "ValidPassword123!",
      bootstrap_secret: "expected-secret-123",
    });

    expect(result.admin).toMatchObject({ email: "sa@dash-meal.com" });
  });
});

describe("Token Blacklist (Issue #4)", () => {
  beforeEach(() => {
    clearTokenBlacklist();
  });

  it("gère l'ajout et la détection d'un token révoqué", () => {
    const token = "some.jwt.token";
    expect(isTokenRevoked(token)).toBe(false);
    revokeToken(token);
    expect(isTokenRevoked(token)).toBe(true);
  });
});
