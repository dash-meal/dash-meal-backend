import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// ─── Mocks ──────────────────────────────────────────────────────────────────
// `config/env.ts` valide ~15 variables d'environnement au chargement du module
// (process.exit(1) si absentes). On le mocke pour rester isolé du vrai
// environnement. `config/supabase.ts` est mocké pour intercepter les requêtes
// DB faites par loadOrderOwnership / loadBranchOwnership sans réseau réel.

const { fromMock, selectMock, eqMock, singleMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  selectMock: vi.fn(),
  eqMock: vi.fn(),
  singleMock: vi.fn(),
}));

vi.mock("../config/supabase.js", () => ({
  supabase: { from: fromMock },
}));

vi.mock("../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(32), JWT_REFRESH_SECRET: "y".repeat(32) },
}));

const {
  authenticate,
  requireOwnBrand,
  requireBranchAccess,
  loadOrderOwnership,
  loadOrderOwnershipFromParam,
  loadBranchOwnership,
  loadBrandFromBranchParam,
  loadProductOwnership,
  loadPromoCodeOwnership,
  loadBrandFromParam,
  assertBranchOwnership,
} = await import("./auth.js");
const { revokeToken, clearTokenBlacklist } = await import("../utils/tokenBlacklist.js");

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    body: {},
    query: {},
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function resetSupabaseChain() {
  singleMock.mockReset();
  eqMock.mockReset().mockImplementation(() => ({ single: singleMock }));
  selectMock.mockReset().mockImplementation(() => ({ eq: eqMock }));
  fromMock.mockReset().mockImplementation(() => ({ select: selectMock }));
}

beforeEach(() => {
  resetSupabaseChain();
});

// ─── requireOwnBrand ────────────────────────────────────────────────────────

describe("requireOwnBrand", () => {
  it("laisse passer le superadmin même si la marque ne correspond pas", () => {
    const req = mockReq({ user: { id: "u1", role: "superadmin" } as any, params: { brandId: "brand-B" } });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireOwnBrand(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("laisse passer l'admin si la marque de la ressource correspond à la sienne", () => {
    const req = mockReq({
      user: { id: "u1", role: "admin", brand_id: "brand-A" } as any,
      params: { brandId: "brand-A" },
    });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireOwnBrand(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("bloque l'admin de la marque A qui vise une ressource de la marque B (bug initial)", () => {
    const req = mockReq({
      user: { id: "u1", role: "admin", brand_id: "brand-A" } as any,
      params: { brandId: "brand-B" },
    });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireOwnBrand(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.objectContaining({ code: "FORBIDDEN" }) })
    );
  });

  it("accepte brand_id fourni via req.body en fallback", () => {
    const req = mockReq({
      user: { id: "u1", role: "admin", brand_id: "brand-A" } as any,
      params: {},
      body: { brand_id: "brand-A" },
    });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireOwnBrand(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});

// ─── requireBranchAccess ────────────────────────────────────────────────────

describe("requireBranchAccess", () => {
  it("refuse si aucun utilisateur authentifié", () => {
    const req = mockReq({ user: undefined });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireBranchAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("laisse passer le superadmin sans vérification d'agence", () => {
    const req = mockReq({ user: { id: "u1", role: "superadmin" } as any, params: { branchId: "branch-X" } });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireBranchAccess(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("laisse passer l'admin sans vérification d'agence (contrôle de marque géré ailleurs)", () => {
    const req = mockReq({ user: { id: "u1", role: "admin", brand_id: "brand-A" } as any, params: {} });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireBranchAccess(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("refuse le branch_manager si aucun branchId n'est fourni", () => {
    const req = mockReq({ user: { id: "u1", role: "branch_manager", branch_id: "branch-X" } as any, params: {} });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireBranchAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "MISSING_BRANCH_ID" }) })
    );
  });

  it("bloque le branch_manager de l'agence X qui vise l'agence Y (bug initial)", () => {
    const req = mockReq({
      user: { id: "u1", role: "branch_manager", branch_id: "branch-X" } as any,
      params: { branchId: "branch-Y" },
    });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireBranchAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "BRANCH_ACCESS_DENIED" }) })
    );
  });

  it("laisse passer le branch_manager sur sa propre agence", () => {
    const req = mockReq({
      user: { id: "u1", role: "branch_manager", branch_id: "branch-X" } as any,
      params: { branchId: "branch-X" },
    });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireBranchAccess(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });

  it("refuse un rôle non prévu (ex: user, driver)", () => {
    const req = mockReq({ user: { id: "u1", role: "driver" } as any, params: { branchId: "branch-X" } });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    requireBranchAccess(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: "FORBIDDEN" }) })
    );
  });
});

// ─── loadOrderOwnership ─────────────────────────────────────────────────────

describe("loadOrderOwnership", () => {
  it("appelle next(AppError 400) si req.params.id est absent", async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    const next = vi.fn();

    await loadOrderOwnership(req, res, next as unknown as NextFunction);

    expect(fromMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toMatchObject({ statusCode: 400, code: "MISSING_ORDER_ID" });
  });

  it("appelle next(AppError 404) si la commande n'existe pas", async () => {
    singleMock.mockResolvedValueOnce({ data: null, error: { message: "not found" } });
    const req = mockReq({ params: { id: "order-404" } });
    const res = mockRes();
    const next = vi.fn();

    await loadOrderOwnership(req, res, next as unknown as NextFunction);

    expect(fromMock).toHaveBeenCalledWith("orders");
    expect(eqMock).toHaveBeenCalledWith("id", "order-404");
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("injecte branchId et brandId dans req.params puis appelle next() sans erreur", async () => {
    singleMock.mockResolvedValueOnce({
      data: { branch_id: "branch-X", branches: { brand_id: "brand-A" } },
      error: null,
    });
    const req = mockReq({ params: { id: "order-1" } });
    const res = mockRes();
    const next = vi.fn();

    await loadOrderOwnership(req, res, next as unknown as NextFunction);

    expect(req.params.branchId).toBe("branch-X");
    expect(req.params.brandId).toBe("brand-A");
    expect(next).toHaveBeenCalledWith();
  });

  it("n'injecte pas brandId si la relation branches est absente", async () => {
    singleMock.mockResolvedValueOnce({
      data: { branch_id: "branch-X", branches: null },
      error: null,
    });
    const req = mockReq({ params: { id: "order-2" } });
    const res = mockRes();
    const next = vi.fn();

    await loadOrderOwnership(req, res, next as unknown as NextFunction);

    expect(req.params.branchId).toBe("branch-X");
    expect(req.params.brandId).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  it("propage une erreur inattendue (ex: panne réseau) à next()", async () => {
    const dbError = new Error("connexion supabase perdue");
    singleMock.mockRejectedValueOnce(dbError);
    const req = mockReq({ params: { id: "order-3" } });
    const res = mockRes();
    const next = vi.fn();

    await loadOrderOwnership(req, res, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledWith(dbError);
  });
});

// ─── loadBranchOwnership ────────────────────────────────────────────────────

describe("loadBranchOwnership", () => {
  it("appelle next(AppError 400) si req.params.id est absent", async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    const next = vi.fn();

    await loadBranchOwnership(req, res, next as unknown as NextFunction);

    expect(fromMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toMatchObject({ statusCode: 400, code: "MISSING_BRANCH_ID" });
  });

  it("appelle next(AppError 404) si l'agence n'existe pas", async () => {
    singleMock.mockResolvedValueOnce({ data: null, error: { message: "not found" } });
    const req = mockReq({ params: { id: "branch-404" } });
    const res = mockRes();
    const next = vi.fn();

    await loadBranchOwnership(req, res, next as unknown as NextFunction);

    expect(fromMock).toHaveBeenCalledWith("branches");
    expect(eqMock).toHaveBeenCalledWith("id", "branch-404");
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("injecte brandId dans req.params puis appelle next() sans erreur", async () => {
    singleMock.mockResolvedValueOnce({ data: { brand_id: "brand-A" }, error: null });
    const req = mockReq({ params: { id: "branch-1" } });
    const res = mockRes();
    const next = vi.fn();

    await loadBranchOwnership(req, res, next as unknown as NextFunction);

    expect(req.params.brandId).toBe("brand-A");
    expect(next).toHaveBeenCalledWith();
  });
});

// ─── Intégration : chaîne complète loadOrderOwnership → requireOwnBrand ────
// Reproduit le scénario exact de la faille : un admin de la marque A tente
// d'agir sur une commande appartenant à la marque B via l'id de la commande.

describe("Chaîne loadOrderOwnership + requireOwnBrand (scénario de la faille)", () => {
  it("bloque un admin de la marque A sur une commande de la marque B", async () => {
    singleMock.mockResolvedValueOnce({
      data: { branch_id: "branch-B1", branches: { brand_id: "brand-B" } },
      error: null,
    });

    const req = mockReq({
      user: { id: "admin-A", role: "admin", brand_id: "brand-A" } as any,
      params: { id: "order-of-brand-B" },
    });
    const res = mockRes();
    const next = vi.fn();

    await loadOrderOwnership(req, res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledWith(); // l'ownership a bien été chargée

    next.mockClear();
    requireOwnBrand(req, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("autorise un admin de la marque A sur sa propre commande", async () => {
    singleMock.mockResolvedValueOnce({
      data: { branch_id: "branch-A1", branches: { brand_id: "brand-A" } },
      error: null,
    });

    const req = mockReq({
      user: { id: "admin-A", role: "admin", brand_id: "brand-A" } as any,
      params: { id: "order-of-brand-A" },
    });
    const res = mockRes();
    const next = vi.fn();

    await loadOrderOwnership(req, res, next as unknown as NextFunction);
    next.mockClear();
    requireOwnBrand(req, res, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ─── loadOrderOwnershipFromParam / loadBrandFromBranchParam (versions génériques) ─
// Utilisées quand l'id de la ressource n'est pas dans req.params.id
// (ex: /collect/admin/order/:orderId, /collect/branch/:branchId).

describe("loadOrderOwnershipFromParam", () => {
  it("lit l'id de commande depuis le nom de paramètre fourni (ex: orderId)", async () => {
    singleMock.mockResolvedValueOnce({
      data: { branch_id: "branch-X", branches: { brand_id: "brand-A" } },
      error: null,
    });
    const req = mockReq({ params: { orderId: "order-42" } });
    const res = mockRes();
    const next = vi.fn();

    await loadOrderOwnershipFromParam("orderId")(req, res, next as unknown as NextFunction);

    expect(eqMock).toHaveBeenCalledWith("id", "order-42");
    expect(req.params.branchId).toBe("branch-X");
    expect(req.params.brandId).toBe("brand-A");
    expect(next).toHaveBeenCalledWith();
  });

  it("appelle next(AppError 400) si le paramètre nommé est absent", async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    const next = vi.fn();

    await loadOrderOwnershipFromParam("orderId")(req, res, next as unknown as NextFunction);

    expect(fromMock).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400, code: "MISSING_ORDER_ID" });
  });
});

describe("loadBrandFromBranchParam", () => {
  it("lit l'id d'agence depuis le nom de paramètre fourni (ex: branchId)", async () => {
    singleMock.mockResolvedValueOnce({ data: { brand_id: "brand-A" }, error: null });
    const req = mockReq({ params: { branchId: "branch-9" } });
    const res = mockRes();
    const next = vi.fn();

    await loadBrandFromBranchParam("branchId")(req, res, next as unknown as NextFunction);

    expect(fromMock).toHaveBeenCalledWith("branches");
    expect(eqMock).toHaveBeenCalledWith("id", "branch-9");
    expect(req.params.brandId).toBe("brand-A");
    expect(next).toHaveBeenCalledWith();
  });

  it("appelle next(AppError 404) si l'agence référencée n'existe pas", async () => {
    singleMock.mockResolvedValueOnce({ data: null, error: { message: "not found" } });
    const req = mockReq({ params: { branchId: "ghost" } });
    const res = mockRes();
    const next = vi.fn();

    await loadBrandFromBranchParam("branchId")(req, res, next as unknown as NextFunction);

    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });
});

// ─── assertBranchOwnership ──────────────────────────────────────────────────
// Vérification manuelle utilisée quand la ressource n'est identifiable
// qu'après une requête en base (ex: /collect/scan résout la commande depuis
// un qr_code envoyé dans le body — aucun id n'est disponible dans l'URL).

describe("assertBranchOwnership", () => {
  it("rejette si aucun utilisateur n'est fourni", async () => {
    await expect(assertBranchOwnership(undefined, "branch-X")).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("laisse passer le superadmin quelle que soit l'agence", async () => {
    await expect(
      assertBranchOwnership({ id: "u1", role: "superadmin" } as any, "branch-X")
    ).resolves.toBeUndefined();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("autorise l'admin si l'agence appartient à sa marque", async () => {
    singleMock.mockResolvedValueOnce({ data: { brand_id: "brand-A" }, error: null });
    await expect(
      assertBranchOwnership({ id: "u1", role: "admin", brand_id: "brand-A" } as any, "branch-X")
    ).resolves.toBeUndefined();
  });

  it("bloque l'admin si l'agence appartient à une autre marque (faille collect/analytics corrigée)", async () => {
    singleMock.mockResolvedValueOnce({ data: { brand_id: "brand-B" }, error: null });
    await expect(
      assertBranchOwnership({ id: "u1", role: "admin", brand_id: "brand-A" } as any, "branch-X")
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });

  it("autorise le branch_manager sur sa propre agence sans requête DB", async () => {
    await expect(
      assertBranchOwnership({ id: "u1", role: "branch_manager", branch_id: "branch-X" } as any, "branch-X")
    ).resolves.toBeUndefined();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("bloque le branch_manager sur l'agence d'un autre", async () => {
    await expect(
      assertBranchOwnership({ id: "u1", role: "branch_manager", branch_id: "branch-X" } as any, "branch-Y")
    ).rejects.toMatchObject({ statusCode: 403, code: "BRANCH_ACCESS_DENIED" });
  });

  it("bloque un rôle non prévu (ex: driver, user)", async () => {
    await expect(
      assertBranchOwnership({ id: "u1", role: "user" } as any, "branch-X")
    ).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
  });
});

// ─── loadProductOwnership ───────────────────────────────────────────────────

describe("loadProductOwnership", () => {
  it("rejette 400 si l'id du produit est absent des params", async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await loadProductOwnership(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: "MISSING_PRODUCT_ID" })
    );
  });

  it("rejette 404 si le produit n'existe pas", async () => {
    singleMock.mockResolvedValueOnce({ data: null, error: { message: "Not found" } });
    const req = mockReq({ params: { id: "prod-999" } });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await loadProductOwnership(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" })
    );
  });

  it("injecte brandId et branchId dans req.params si le produit est trouvé", async () => {
    singleMock.mockResolvedValueOnce({
      data: { branch_id: "branch-1", brand_id: "brand-1", branches: { brand_id: "brand-1" } },
      error: null,
    });
    const req = mockReq({ params: { id: "prod-1" } });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await loadProductOwnership(req, res, next);

    expect(req.params.branchId).toBe("branch-1");
    expect(req.params.brandId).toBe("brand-1");
    expect(next).toHaveBeenCalledWith();
  });
});

// ─── loadPromoCodeOwnership ─────────────────────────────────────────────────

describe("loadPromoCodeOwnership", () => {
  it("rejette 400 si l'id de promo est absent", async () => {
    const req = mockReq({ params: {} });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await loadPromoCodeOwnership(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, code: "MISSING_PROMO_ID" })
    );
  });

  it("injecte brandId et branchId depuis l'agence liée au code promo", async () => {
    singleMock.mockResolvedValueOnce({
      data: { branch_id: "branch-promo", branches: { brand_id: "brand-promo" } },
      error: null,
    });
    const req = mockReq({ params: { id: "promo-1" } });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    await loadPromoCodeOwnership(req, res, next);

    expect(req.params.branchId).toBe("branch-promo");
    expect(req.params.brandId).toBe("brand-promo");
    expect(next).toHaveBeenCalledWith();
  });
});

// ─── loadBrandFromParam ─────────────────────────────────────────────────────

describe("loadBrandFromParam", () => {
  it("injecte req.params.id dans req.params.brandId", () => {
    const req = mockReq({ params: { id: "brand-target" } });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    loadBrandFromParam("id")(req, res, next);

    expect(req.params.brandId).toBe("brand-target");
    expect(next).toHaveBeenCalledWith();
  });
});

// ─── authenticate avec révocation de token ──────────────────────────────────

describe("authenticate & token revocation", () => {
  beforeEach(() => {
    clearTokenBlacklist();
  });

  it("bloque un token révoqué avec code TOKEN_REVOKED", () => {
    const testToken = "sample.revoked.jwt.token";
    revokeToken(testToken);

    const req = mockReq({ headers: { authorization: `Bearer ${testToken}` } });
    const res = mockRes();
    const next = vi.fn() as unknown as NextFunction;

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: "TOKEN_REVOKED", message: "Session révoquée ou déconnectée" },
    });
    expect(next).not.toHaveBeenCalled();
  });
});

