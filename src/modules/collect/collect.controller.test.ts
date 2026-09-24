import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("../../config/supabase.js", () => ({
  supabase: { from: fromMock },
}));

vi.mock("../../config/env.js", () => ({
  env: { JWT_SECRET: "x".repeat(32), JWT_REFRESH_SECRET: "y".repeat(32), EXPO_ACCESS_TOKEN: undefined },
}));

const { scanQrCode } = await import("./collect.controller.js");

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeChain(result: { data: unknown; error: unknown }) {
  const chain: any = {};
  const methods = [
    "select", "eq", "single", "maybeSingle", "update", "insert",
    "delete", "order", "range", "in", "gte", "lte", "lt", "limit", "upsert",
  ];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

/**
 * Configure supabase.from(table) pour retourner, dans l'ordre, les réponses
 * fournies pour cette table (une queue par table — indépendante des autres
 * tables, pour rester robuste même si un appel fire-and-forget d'une table
 * comme push_tokens survient après la fin logique du test).
 */
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

// ─── scanQrCode ─────────────────────────────────────────────────────────────

describe("scanQrCode — vérification d'appartenance (faille critique corrigée)", () => {
  it("bloque un admin de la marque A qui scanne le QR d'une commande de la marque B", async () => {
    configureSupabase({
      collect_orders: [{
        data: {
          id: "collect-1",
          pickup_status: "waiting",
          orders: {
            id: "order-1",
            status: "ready",
            total: 5000,
            user_id: "user-1",
            branch_id: "branch-B1",
            users: { name: "Client B" },
            order_items: [],
          },
        },
        error: null,
      }],
      // assertBranchOwnership(admin) résout la marque de branch-B1 → brand-B,
      // différente de la marque de l'admin (brand-A) → doit bloquer.
      branches: [{ data: { brand_id: "brand-B" }, error: null }],
    });

    const req = mockReq({
      user: { id: "admin-A", role: "admin", brand_id: "brand-A" } as any,
      body: { qr_code: "QR-XYZ" },
    });
    const res = mockRes();
    const next = vi.fn();

    await scanQrCode(req, res, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toMatchObject({ statusCode: 403 });

    // Aucune réponse de succès ne doit avoir été envoyée
    expect(res.status).not.toHaveBeenCalled();
  });

  it("bloque un branch_manager d'une agence qui scanne le QR d'une commande d'une autre agence", async () => {
    configureSupabase({
      collect_orders: [{
        data: {
          id: "collect-2",
          pickup_status: "waiting",
          orders: {
            id: "order-2",
            status: "ready",
            total: 3000,
            user_id: "user-2",
            branch_id: "branch-Y",
            users: { name: "Client Y" },
            order_items: [],
          },
        },
        error: null,
      }],
    });

    const req = mockReq({
      user: { id: "bm-X", role: "branch_manager", branch_id: "branch-X" } as any,
      body: { qr_code: "QR-ABC" },
    });
    const res = mockRes();
    const next = vi.fn();

    await scanQrCode(req, res, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403, code: "BRANCH_ACCESS_DENIED" });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("autorise le scan quand la commande appartient bien à la marque de l'admin", async () => {
    configureSupabase({
      collect_orders: [
        {
          data: {
            id: "collect-3",
            pickup_status: "waiting",
            orders: {
              id: "order-3",
              status: "ready",
              total: 4200,
              user_id: "user-3",
              branch_id: "branch-A1",
              users: { name: "Client A" },
              order_items: [],
            },
          },
          error: null,
        },
        { data: {}, error: null }, // update collect_orders
      ],
      branches: [{ data: { brand_id: "brand-A" }, error: null }],
      orders: [{ data: {}, error: null }], // update orders → delivered
      order_status_history: [{ data: {}, error: null }], // insert historique
      push_tokens: [{ data: [], error: null }], // fire-and-forget, court-circuité (tableau vide)
    });

    const req = mockReq({
      user: { id: "admin-A", role: "admin", brand_id: "brand-A" } as any,
      body: { qr_code: "QR-OK" },
    });
    const res = mockRes();
    const next = vi.fn();

    await scanQrCode(req, res, next as unknown as NextFunction);
    // Laisse une chance au push fire-and-forget (non awaité) de se résoudre
    // avant que le test suivant ne réinitialise les mocks.
    await Promise.resolve();
    await Promise.resolve();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, message: "Retrait validé avec succès" })
    );
  });

  it("autorise le scan pour le superadmin quelle que soit l'agence", async () => {
    configureSupabase({
      collect_orders: [
        {
          data: {
            id: "collect-4",
            pickup_status: "waiting",
            orders: {
              id: "order-4",
              status: "ready",
              total: 1000,
              user_id: "user-4",
              branch_id: "branch-Z",
              users: { name: "Client Z" },
              order_items: [],
            },
          },
          error: null,
        },
        { data: {}, error: null },
      ],
      orders: [{ data: {}, error: null }],
      order_status_history: [{ data: {}, error: null }],
      push_tokens: [{ data: [], error: null }],
    });

    const req = mockReq({
      user: { id: "root", role: "superadmin" } as any,
      body: { qr_code: "QR-ROOT" },
    });
    const res = mockRes();
    const next = vi.fn();

    await scanQrCode(req, res, next as unknown as NextFunction);
    await Promise.resolve();
    await Promise.resolve();

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("renvoie 400 si qr_code est manquant, sans toucher la base", async () => {
    configureSupabase({});
    const req = mockReq({ user: { id: "admin-A", role: "admin", brand_id: "brand-A" } as any, body: {} });
    const res = mockRes();
    const next = vi.fn();

    await scanQrCode(req, res, next as unknown as NextFunction);

    expect(fromMock).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400, code: "MISSING_QR_CODE" });
  });
});
