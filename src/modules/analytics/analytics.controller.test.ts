import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("../../config/supabase.js", () => ({
  supabase: { from: fromMock },
}));

vi.mock("../../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(32), JWT_REFRESH_SECRET: "y".repeat(32) },
}));

const { getTopProducts } = await import("./analytics.controller.js");

function makeChain(result: { data: unknown; error: unknown }) {
  const chain: any = {};
  const methods = ["select", "eq", "single", "maybeSingle", "in", "limit", "order", "gte", "lt"];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

function configureSupabase(responses: Record<string, Array<{ data: unknown; error: unknown }>>) {
  const queues: Record<string, Array<{ data: unknown; error: unknown }>> = Object.fromEntries(
    Object.entries(responses).map(([k, v]) => [k, [...v]])
  );
  fromMock.mockImplementation((table: string) => {
    const queue = queues[table];
    const result = queue && queue.length > 0
      ? (queue.length > 1 ? queue.shift()! : queue[0])
      : { data: null, error: null };
    return makeChain(result);
  });
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return { params: {}, body: {}, query: {}, headers: {}, ...overrides } as unknown as Request;
}

function mockRes(): Response {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("getTopProducts — portée par tenant (fuite cross-marque corrigée)", () => {
  it("restreint la requête aux agences de la marque de l'admin", async () => {
    configureSupabase({
      branches: [{ data: [{ id: "branch-A1" }, { id: "branch-A2" }], error: null }],
      order_items: [{ data: [{ product_id: "p1", quantity: 3, products: { name_fr: "Pizza" }, orders: { branch_id: "branch-A1" } }], error: null }],
    });

    const req = mockReq({ user: { id: "admin-A", role: "admin", brand_id: "brand-A" } as any });
    const res = mockRes();
    const next = vi.fn();

    await getTopProducts(req, res, next as unknown as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    // Le champ technique "orders" utilisé pour filtrer ne doit pas fuiter dans la réponse
    const body = (res.json as any).mock.calls[0][0];
    expect(body.data).toEqual([{ product_id: "p1", quantity: 3, products: { name_fr: "Pizza" } }]);
  });

  it("renvoie une liste vide sans requêter order_items si l'admin n'a aucune agence", async () => {
    configureSupabase({
      branches: [{ data: [], error: null }],
    });

    const req = mockReq({ user: { id: "admin-A", role: "admin", brand_id: "brand-A" } as any });
    const res = mockRes();
    const next = vi.fn();

    await getTopProducts(req, res, next as unknown as NextFunction);

    expect(fromMock).not.toHaveBeenCalledWith("order_items");
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as any).mock.calls[0][0];
    expect(body.data).toEqual([]);
  });

  it("restreint la requête à la seule agence du branch_manager", async () => {
    configureSupabase({
      order_items: [{ data: [{ product_id: "p2", quantity: 1, products: { name_fr: "Burger" }, orders: { branch_id: "branch-X" } }], error: null }],
    });

    const req = mockReq({ user: { id: "bm-X", role: "branch_manager", branch_id: "branch-X" } as any });
    const res = mockRes();
    const next = vi.fn();

    await getTopProducts(req, res, next as unknown as NextFunction);

    expect(fromMock).not.toHaveBeenCalledWith("branches"); // pas besoin de résoudre les agences pour un branch_manager
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("ne restreint pas la requête pour le superadmin", async () => {
    configureSupabase({
      order_items: [{ data: [{ product_id: "p3", quantity: 9, products: { name_fr: "Sushi" }, orders: { branch_id: "branch-Anything" } }], error: null }],
    });

    const req = mockReq({ user: { id: "root", role: "superadmin" } as any });
    const res = mockRes();
    const next = vi.fn();

    await getTopProducts(req, res, next as unknown as NextFunction);

    expect(fromMock).not.toHaveBeenCalledWith("branches");
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
