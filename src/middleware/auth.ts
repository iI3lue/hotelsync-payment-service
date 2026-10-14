import { Request, Response, NextFunction } from "express";
import { AppError } from "./error-handler";
import { verifyAccessToken } from "../lib/tokens";
import type { AuthUser, Payer } from "../types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

/** Exige Bearer válido. */
export const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
  const token = bearer(req);
  if (!token) return next(new AppError(401, "Falta el token de acceso", "Unauthorized"));
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Huésped que paga: Bearer válido O `x-manage-token` de la reserva (alta
 * anónima). Un Bearer presente pero inválido es 401: no se degrada a anónimo.
 */
export const requirePayer = (req: Request, _res: Response, next: NextFunction) => {
  const token = bearer(req);
  try {
    if (token) req.user = verifyAccessToken(token);
  } catch (err) {
    return next(err);
  }
  if (!req.user && !manageTokenFrom(req)) {
    return next(new AppError(401, "Iniciá sesión o usá el código de gestión de la reserva", "Unauthorized"));
  }
  next();
};

export const requireRole = (roles: readonly string[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, "Falta el token de acceso", "Unauthorized"));
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, "Permisos insuficientes", "Forbidden"));
    }
    next();
  };
};

export function manageTokenFrom(req: Request): string | undefined {
  const value = req.headers["x-manage-token"];
  const token = Array.isArray(value) ? value[0] : value;
  return token && token.length <= 256 ? token : undefined;
}

export function payerFrom(req: Request): Payer {
  return { user: req.user, manageToken: manageTokenFrom(req) };
}
