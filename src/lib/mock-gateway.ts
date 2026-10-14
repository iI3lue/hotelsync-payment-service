import type { CardInput } from "../types";

/**
 * Pasarela SIMULADA. Nunca toca dinero real ni guarda tarjetas.
 * - Tarjeta de prueba que autoriza: 4111111111111111
 * - Tarjeta de prueba que rechaza: 4000000000000002
 * - Cualquier otra con Luhn válido y fecha futura: autoriza.
 */

export function luhnValid(number: string): boolean {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function expiryValid(expMonth: number, expYear: number, now = new Date()): boolean {
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12) return false;
  if (!Number.isInteger(expYear) || expYear < 1000) return false;
  // Válida hasta fin del mes de vencimiento.
  const endOfMonth = new Date(expYear, expMonth, 0, 23, 59, 59);
  return endOfMonth.getTime() >= now.getTime();
}

export type CardBrand = "VISA" | "MASTERCARD" | "AMEX" | "OTHER";

/** Marca por prefijo (IIN), solo para mostrar "Visa •••• 1111". */
export function cardBrand(number: string): CardBrand {
  const d = number.replace(/\D/g, "");
  if (/^4/.test(d)) return "VISA";
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(d)) return "MASTERCARD";
  if (/^3[47]/.test(d)) return "AMEX";
  return "OTHER";
}

export interface AuthorizationResult {
  authorized: boolean;
  auth_code: string | null;
  reason?: string;
}

export function authorizeCard(card: CardInput, amountMinor: number): AuthorizationResult {
  const digits = card.number.replace(/\D/g, "");
  if (!luhnValid(digits)) return { authorized: false, auth_code: null, reason: "Número de tarjeta inválido" };
  if (!expiryValid(card.exp_month, card.exp_year))
    return { authorized: false, auth_code: null, reason: "Tarjeta vencida" };
  const cvcLength = cardBrand(digits) === "AMEX" ? 4 : 3;
  if (!new RegExp(`^\\d{${cvcLength}}$`).test(card.cvc))
    return { authorized: false, auth_code: null, reason: "CVV inválido" };
  if (!Number.isFinite(amountMinor) || amountMinor <= 0)
    return { authorized: false, auth_code: null, reason: "Monto inválido" };
  if (digits === "4000000000000002")
    return { authorized: false, auth_code: null, reason: "Tarjeta rechazada por el banco (simulado)" };
  const authCode = `MOCK-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296)
    .toString(36)
    .toUpperCase()
    .padStart(2, "0")}`;
  return { authorized: true, auth_code: authCode };
}
