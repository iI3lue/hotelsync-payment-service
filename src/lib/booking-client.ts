import { AppError } from "../middleware/error-handler";

/** Subconjunto de la reserva que payment-service necesita (booking-service es la fuente de verdad). */
export interface BookingDetails {
  booking_id: string;
  hotel_id: string;
  status: string; // pending | confirmed | cancelled
  total_amount: number | string;
  booked_by_user_id: string | null;
  payment_status?: string; // PENDING | PAID
  payment_method_preference?: string; // ONLINE | RECEPTION
}

const TIMEOUT_MS = 5_000;

function baseUrl(): string {
  return process.env.BOOKING_SERVICE_URL || "http://localhost:3004/v1";
}

async function getBooking(bookingId: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetch(`${baseUrl()}/bookings/${encodeURIComponent(bookingId)}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AppError(502, "El servicio de reservas no responde", "BadGateway");
  }
}

/**
 * Lectura servidor-a-servidor con la clave `x-payment-key`
 * (= PAYMENT_SERVICE_KEY de booking-service). 401/403 aquí significa
 * configuración incorrecta, no culpa del cliente: se responde 502.
 */
export async function getBookingAsService(bookingId: string): Promise<BookingDetails | null> {
  const res = await getBooking(bookingId, { "x-payment-key": process.env.BOOKING_SERVICE_KEY || "" });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    console.error("[booking-client] booking-service rechazó la clave de pagos: revisar BOOKING_SERVICE_KEY / PAYMENT_SERVICE_KEY");
    throw new AppError(502, "No se pudo verificar la reserva", "BadGateway");
  }
  if (!res.ok) throw new AppError(502, "No se pudo verificar la reserva", "BadGateway");
  return (await res.json()) as BookingDetails;
}

/**
 * Lectura en nombre del huésped anónimo: booking-service valida el manage
 * token (hash + vigencia). Un token ajeno o vencido es 403 para el cliente.
 */
export async function getBookingWithManageToken(
  bookingId: string,
  manageToken: string
): Promise<BookingDetails | null> {
  const res = await getBooking(bookingId, { "x-manage-token": manageToken });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new AppError(403, "El código de gestión no corresponde a esta reserva", "Forbidden");
  }
  if (!res.ok) throw new AppError(502, "No se pudo verificar la reserva", "BadGateway");
  return (await res.json()) as BookingDetails;
}
