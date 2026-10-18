import { z } from "zod";

const cardNumber = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .refine((v) => /^\d{13,19}$/.test(v), "Número de tarjeta inválido");

const cardSchema = z.object({
  number: cardNumber,
  exp_month: z.number().int().min(1).max(12),
  exp_year: z.number().int().min(2000).max(2100),
  cvc: z.string().regex(/^\d{3,4}$/, "CVV inválido"),
  holder: z.string().trim().min(1).max(100).optional(),
});

// Pago web con tarjeta simulada. El monto NO viaja en el body: se verifica
// contra booking-service para que el cliente no pueda auto-fijar el precio.
export const CheckoutSchema = z.object({
  booking_id: z.string().uuid("El booking_id debe ser un UUID válido"),
  card: cardSchema,
});

// Pago manual de recepción (efectivo, transferencia o datáfono físico).
export const FrontDeskPaymentSchema = z.object({
  booking_id: z.string().uuid("El booking_id debe ser un UUID válido"),
  method: z.enum(["CASH", "TRANSFER", "TERMINAL"]),
  received_by: z.string().trim().min(1).max(100).optional(),
});

export const BookingIdParamSchema = z.object({
  bookingId: z.string().uuid("El bookingId debe ser un UUID válido"),
});

// Solo necesitamos el id: el resto del payload de booking.cancelled es
// informativo. `passthrough` tolera campos nuevos del emisor.
export const BookingCancelledEventSchema = z
  .object({
    booking_id: z.string().uuid(),
  })
  .passthrough();


export type CheckoutInput = z.infer<typeof CheckoutSchema>;
export type FrontDeskPaymentInput = z.infer<typeof FrontDeskPaymentSchema>;
