import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { AppError } from "./errorHandler.js";
import type { AuthUser } from "../shared/index.js";

// Augmenter le type Request pour inclure l'utilisateur authentifié
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Token manquant" },
    });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({
      success: false,
      error: { code: "INVALID_TOKEN", message: "Token invalide ou expiré" },
    });
  }
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { code: "UNAUTHORIZED", message: "Non authentifié" },
      });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: { code: "FORBIDDEN", message: "Accès refusé" },
      });
      return;
    }
    next();
  };
}

// Auth optionnelle — attache req.user si token présent, passe sinon
export function optionalAuthenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return next();
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthUser;
    req.user = payload;
  } catch {
    // token invalide → on ignore simplement
  }
  next();
}

// Vérifie que le branch_manager accède uniquement à sa propre agence
export function requireBranchAccess(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ success: false, error: { code: "UNAUTHORIZED", message: "Non authentifié" } });
    return;
  }
  if (req.user.role === "superadmin" || req.user.role === "admin") return next();
  if (req.user.role === "branch_manager") {
    const branchId = req.params.branchId ?? req.params.branch_id ?? (req.body?.branch_id as string | undefined);
    // Si aucun branchId n'est fourni, on refuse : un endpoint sans branchId
    // ne doit pas être accessible à tous les branch_managers indistinctement.
    if (!branchId) {
      res.status(400).json({ success: false, error: { code: "MISSING_BRANCH_ID", message: "Identifiant d'agence requis" } });
      return;
    }
    if (branchId !== req.user.branch_id) {
      res.status(403).json({ success: false, error: { code: "BRANCH_ACCESS_DENIED", message: "Accès à cette agence refusé" } });
      return;
    }
    return next();
  }
  res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "Accès refusé" } });
}

// Vérifie que l'admin accède uniquement à sa propre marque
export function requireOwnBrand(req: Request, res: Response, next: NextFunction) {
  const brandId = req.params.brandId ?? req.body.brand_id;
  if (req.user?.role === "superadmin") {
    // Le superadmin peut tout voir
    next();
    return;
  }
  if (req.user?.brand_id !== brandId) {
    res.status(403).json({
      success: false,
      error: { code: "FORBIDDEN", message: "Accès à cette marque refusé" },
    });
    return;
  }
  next();
}

// ─── Résolution de propriétaire pour les routes basées sur :id ───────────────
//
// requireBranchAccess / requireOwnBrand lisent branchId/brandId depuis
// req.params.branchId|brandId ou req.body.branch_id|brand_id. Sur les routes
// du type /orders/:id/status ou /branches/:id, le seul identifiant présent
// dans l'URL est celui de la ressource elle-même (commande, agence) — pas sa
// marque ou son agence propriétaire. Ces deux middlewares vont chercher cette
// info en base et l'injectent dans req.params, pour que requireBranchAccess
// et requireOwnBrand puissent ensuite s'appliquer normalement.
//
// À placer APRÈS authenticate/requireRole et AVANT requireBranchAccess /
// requireOwnBrand dans la chaîne de middlewares.

// Résout branch_id et brand_id d'une commande depuis req.params.id
export const loadOrderOwnership = loadOrderOwnershipFromParam("id");

// Version générique : même résolution que loadOrderOwnership, mais pour un
// nom de paramètre d'URL différent (ex: "orderId" sur /collect/admin/order/:orderId).
export function loadOrderOwnershipFromParam(paramName: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderId = req.params[paramName];
      if (!orderId) {
        next(new AppError(400, "MISSING_ORDER_ID", "Identifiant de commande requis"));
        return;
      }

      const { data: order, error } = await supabase
        .from("orders")
        .select("branch_id, branches(brand_id)")
        .eq("id", orderId)
        .single();

      if (error || !order) {
        next(new AppError(404, "NOT_FOUND", "Commande introuvable"));
        return;
      }

      if (order.branch_id) req.params.branchId = order.branch_id;
      const brandId = (order.branches as { brand_id?: string } | null)?.brand_id;
      if (brandId) req.params.brandId = brandId;

      next();
    } catch (err) {
      next(err);
    }
  };
}

// Résout brand_id d'une agence depuis req.params.id
export const loadBranchOwnership = loadBrandFromBranchParam("id");

// Version générique : résout brand_id d'une agence depuis n'importe quel nom
// de paramètre d'URL (ex: "branch_id" sur /branch-hours/:branch_id,
// "branchId" sur /collect/branch/:branchId, "id" sur /branches/:id...).
// Injecte le résultat dans req.params.brandId pour requireOwnBrand.
export function loadBrandFromBranchParam(paramName: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const branchId = req.params[paramName];
      if (!branchId) {
        next(new AppError(400, "MISSING_BRANCH_ID", "Identifiant d'agence requis"));
        return;
      }

      const { data: branch, error } = await supabase
        .from("branches")
        .select("brand_id")
        .eq("id", branchId)
        .single();

      if (error || !branch) {
        next(new AppError(404, "NOT_FOUND", "Agence introuvable"));
        return;
      }

      if (branch.brand_id) req.params.brandId = branch.brand_id;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// ─── Vérification manuelle (hors chaîne de middlewares) ───────────────────────
//
// Certaines ressources ne sont identifiables qu'après une requête en base
// (ex: /collect/scan résout la commande à partir d'un qr_code envoyé dans le
// body — aucun branchId n'est disponible dans l'URL avant cette requête).
// Dans ces cas, un middleware de route ne peut pas s'appliquer : on vérifie
// l'accès directement dans le controller, une fois la ressource chargée.
//
// Lève une AppError (401/403) — à laisser remonter via le bloc try/catch +
// next(err) déjà présent dans les controllers de ce projet.
export async function assertBranchOwnership(
  user: AuthUser | undefined,
  branchId: string | null | undefined
): Promise<void> {
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Non authentifié");
  if (user.role === "superadmin") return;

  if (user.role === "admin") {
    if (!branchId) throw new AppError(403, "FORBIDDEN", "Accès refusé");
    const { data: branch } = await supabase.from("branches").select("brand_id").eq("id", branchId).single();
    if (!branch || branch.brand_id !== user.brand_id) {
      throw new AppError(403, "FORBIDDEN", "Accès refusé à cette agence");
    }
    return;
  }

  if (user.role === "branch_manager") {
    if (!branchId || branchId !== user.branch_id) {
      throw new AppError(403, "BRANCH_ACCESS_DENIED", "Accès refusé à cette agence");
    }
    return;
  }

  throw new AppError(403, "FORBIDDEN", "Accès refusé");
}
