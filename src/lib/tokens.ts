import jwt from "jsonwebtoken";
import { AppError } from "../middleware/error-handler";
import type { AuthUser } from "../types";

/**
 * Verificación local de access tokens HS256 emitidos por user-service
 * (mismo contrato que booking-service: iss `hotelsync`, aud `hotelsync-api`).
 * AUTH_JWT_SECRET debe ser IDÉNTICO al de user-service o todo da 401.
 */
export const TOKEN_ISSUER = "hotelsync";
export const TOKEN_AUDIENCE = "hotelsync-api";
const TEST_SECRET = "test-secret-for-unit-tests-only-32b!";

export function getJwtSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "test") return TEST_SECRET;
  throw new Error("AUTH_JWT_SECRET must be set (min 32 chars, igual a user-service)");
}

interface Claims {
  sub?: string;
  userId?: string;
  role?: string;
  hotel_id?: string | null;
  email?: string;
}

export function verifyAccessToken(token: string): AuthUser {
  let decoded: Claims;
  try {
    decoded = jwt.verify(token, getJwtSecret(), {
      algorithms: ["HS256"],
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    }) as Claims;
  } catch {
    throw new AppError(401, "Token inválido o vencido", "Unauthorized");
  }
  const userId = decoded.sub ?? decoded.userId;
  if (!userId) throw new AppError(401, "Token inválido o vencido", "Unauthorized");
  return {
    userId,
    role: decoded.role ?? "GUEST",
    hotelId: decoded.hotel_id ?? null,
    email: decoded.email,
  };
}
