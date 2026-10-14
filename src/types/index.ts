export type PaymentMethod = "CREDIT_CARD" | "CASH" | "TRANSFER" | "TERMINAL";
export type ManualPaymentMethod = Extract<PaymentMethod, "CASH" | "TRANSFER" | "TERMINAL">;
export type PaymentStatus = "PROCESSING" | "COMPLETED" | "FAILED" | "REFUNDED";
export type PaymentChannel = "WEB" | "FRONT_DESK";

/** Tarjeta tal como llega del borde (Zod ya normalizó el número a dígitos). */
export interface CardInput {
  number: string;
  exp_month: number;
  exp_year: number;
  cvc: string;
  holder?: string;
}

/** Actor autenticado por Bearer (JWT de user-service). */
export interface AuthUser {
  userId: string;
  role: string;
  hotelId: string | null;
  email?: string;
}

/**
 * Quién intenta pagar o consultar: un usuario logueado y/o el huésped
 * anónimo con su manage token (lo valida booking-service, no este servicio).
 */
export interface Payer {
  user?: AuthUser;
  manageToken?: string;
}

export const STAFF_ROLES = ["SUPER_ADMIN", "MANAGER", "RECEPTIONIST"] as const;
