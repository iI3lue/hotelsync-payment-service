jest.mock("../../src/lib/prisma", () => ({
  prisma: {
    paymentTransaction: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    eventOutbox: { create: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    $transaction: jest.fn(),
  },
}));
jest.mock("../../src/lib/booking-client", () => ({
  getBookingAsService: jest.fn(),
  getBookingWithManageToken: jest.fn(),
}));

import { prisma } from "../../src/lib/prisma";
import { getBookingAsService, getBookingWithManageToken } from "../../src/lib/booking-client";
import {
  MAX_ATTEMPTS,
  PROCESSING_STALE_MS,
  getPaymentStatus,
  processFrontDeskPayment,
  processWebPayment,
  refundBooking,
} from "../../src/services/payment.service";

const db = prisma as any;
const asService = getBookingAsService as jest.Mock;
const withToken = getBookingWithManageToken as jest.Mock;

const BOOKING_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const HOTEL_ID = "c1b2c3d4-e5f6-4890-abcd-ef1234567890";
const OTHER_HOTEL = "c9b2c3d4-e5f6-4890-abcd-ef1234567890";
const GUEST_ID = "e1b2c3d4-e5f6-4890-abcd-ef1234567890";
const TX_ID = "f1b2c3d4-e5f6-4890-abcd-ef1234567890";

const GOOD_CARD = { number: "4111111111111111", exp_month: 12, exp_year: 2030, cvc: "123" };
const DECLINED_CARD = { ...GOOD_CARD, number: "4000000000000002" };
const guest = { user: { userId: GUEST_ID, role: "GUEST", hotelId: null } };
const receptionist = { userId: "11111111-2222-4333-8444-555555555555", role: "RECEPTIONIST", hotelId: HOTEL_ID };

function booking(over: Record<string, unknown> = {}) {
  return {
    booking_id: BOOKING_ID,
    hotel_id: HOTEL_ID,
    status: "pending",
    total_amount: "1260.00",
    booked_by_user_id: GUEST_ID,
    payment_status: "PENDING",
    payment_method_preference: "ONLINE",
    ...over,
  };
}

function tx(over: Record<string, unknown> = {}) {
  return {
    transaction_id: TX_ID,
    booking_id: BOOKING_ID,
    user_id: GUEST_ID,
    hotel_id: HOTEL_ID,
    amount: 1260,
    currency: "COP",
    method: "CREDIT_CARD",
    status: "PROCESSING",
    channel: "WEB",
    failure_reason: null,
    auth_code: null,
    card_brand: null,
    card_last4: null,
    attempts: 1,
    recorded_by: null,
    received_by: null,
    refund_requested: false,
    refunded_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.paymentTransaction.update.mockImplementation(async ({ data }: any) => tx(data));
  db.paymentTransaction.findUniqueOrThrow.mockResolvedValue(tx());
});

describe("processWebPayment (Flujo A)", () => {
  it("cobra, guarda solo últimos 4 dígitos y encola payment.completed en la misma transacción", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx());

    const result = await processWebPayment(guest, BOOKING_ID, GOOD_CARD);

    expect(result.replay).toBe(false);
    expect(result.transaction.status).toBe("COMPLETED");
    expect(db.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "PROCESSING", amount: 1260, method: "CREDIT_CARD", channel: "WEB" }),
    });
    const update = db.paymentTransaction.update.mock.calls[0][0];
    expect(update.data).toMatchObject({ status: "COMPLETED", card_brand: "VISA", card_last4: "1111" });
    expect(JSON.stringify(db.paymentTransaction.create.mock.calls)).not.toContain("4111111111111111");
    expect(db.eventOutbox.create).toHaveBeenCalledWith({
      data: {
        event_type: "payment.completed",
        payload: { booking_id: BOOKING_ID, transaction_id: TX_ID, amount: 1260, currency: "COP" },
      },
    });
  });

  it("rechazo: 402, transacción FAILED y sin evento (la reserva queda pendiente)", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx());

    await expect(processWebPayment(guest, BOOKING_ID, DECLINED_CARD)).rejects.toMatchObject({ statusCode: 402 });
    expect(db.paymentTransaction.update).toHaveBeenCalledWith({
      where: { transaction_id: TX_ID },
      data: expect.objectContaining({ status: "FAILED", failure_reason: expect.any(String) }),
    });
    expect(db.eventOutbox.create).not.toHaveBeenCalled();
  });

  it("reintento tras rechazo: re-toma la misma fila (sin crear otra) y cobra", async () => {
    asService.mockResolvedValue(booking());
    const failed = tx({ status: "FAILED", attempts: 1 });
    db.paymentTransaction.findUnique.mockResolvedValue(failed);
    db.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
    db.paymentTransaction.findUniqueOrThrow.mockResolvedValue(tx({ attempts: 2 }));

    const result = await processWebPayment(guest, BOOKING_ID, GOOD_CARD);

    expect(result.transaction.status).toBe("COMPLETED");
    expect(db.paymentTransaction.create).not.toHaveBeenCalled();
    expect(db.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { booking_id: BOOKING_ID, status: "FAILED", attempts: 1 },
      data: expect.objectContaining({ status: "PROCESSING", attempts: { increment: 1 } }),
    });
  });

  it("idempotencia: una reserva ya cobrada devuelve el cobro existente sin tocar la pasarela", async () => {
    asService.mockResolvedValue(booking({ payment_status: "PAID", status: "confirmed" }));
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "COMPLETED" }));

    const result = await processWebPayment(guest, BOOKING_ID, DECLINED_CARD);

    expect(result.replay).toBe(true);
    expect(result.transaction.status).toBe("COMPLETED");
    expect(db.paymentTransaction.create).not.toHaveBeenCalled();
    expect(db.eventOutbox.create).not.toHaveBeenCalled();
  });

  it("carrera: si otra request creó la fila (P2002) se relee y responde 409 en curso", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique
      .mockResolvedValueOnce(null) // chequeo de idempotencia
      .mockResolvedValueOnce(null) // claim
      .mockResolvedValueOnce(tx({ status: "PROCESSING" })); // relectura tras P2002
    db.paymentTransaction.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));

    await expect(processWebPayment(guest, BOOKING_ID, GOOD_CARD)).rejects.toMatchObject({
      statusCode: 409,
      error: "PaymentInProgress",
    });
  });

  it("un PROCESSING huérfano (proceso caído) se puede re-tomar", async () => {
    asService.mockResolvedValue(booking());
    const old = new Date(Date.now() - PROCESSING_STALE_MS - 1000);
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "PROCESSING", updated_at: old }));
    db.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
    db.paymentTransaction.findUniqueOrThrow.mockResolvedValue(tx({ attempts: 2 }));

    await expect(processWebPayment(guest, BOOKING_ID, GOOD_CARD)).resolves.toMatchObject({ replay: false });
  });

  it("corta tras el máximo de intentos (429)", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "FAILED", attempts: MAX_ATTEMPTS }));
    await expect(processWebPayment(guest, BOOKING_ID, GOOD_CARD)).rejects.toMatchObject({ statusCode: 429 });
  });

  it("no deja pagar reservas de otra cuenta (403)", async () => {
    asService.mockResolvedValue(booking({ booked_by_user_id: "99999999-2222-4333-8444-555555555555" }));
    await expect(processWebPayment(guest, BOOKING_ID, GOOD_CARD)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rechaza reservas canceladas (409)", async () => {
    asService.mockResolvedValue(booking({ status: "cancelled" }));
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    await expect(processWebPayment(guest, BOOKING_ID, GOOD_CARD)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("huésped anónimo: usa el manage token (lo valida booking-service)", async () => {
    withToken.mockResolvedValue(booking({ booked_by_user_id: null }));
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx({ user_id: null }));

    await processWebPayment({ manageToken: "tok" }, BOOKING_ID, GOOD_CARD);
    expect(withToken).toHaveBeenCalledWith(BOOKING_ID, "tok");
    expect(asService).not.toHaveBeenCalled();
  });

  it("404 si la reserva no existe", async () => {
    asService.mockResolvedValue(null);
    await expect(processWebPayment(guest, BOOKING_ID, GOOD_CARD)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("processFrontDeskPayment (Flujo B)", () => {
  it("registra efectivo con el staff que lo cobró y emite el evento", async () => {
    asService.mockResolvedValue(booking({ status: "confirmed", payment_method_preference: "RECEPTION" }));
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx({ method: "CASH", channel: "FRONT_DESK" }));

    const result = await processFrontDeskPayment(receptionist, BOOKING_ID, "CASH", "Caja 1");

    expect(result.replay).toBe(false);
    expect(db.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        method: "CASH",
        channel: "FRONT_DESK",
        recorded_by: receptionist.userId,
        received_by: "Caja 1",
      }),
    });
    expect(db.eventOutbox.create).toHaveBeenCalled();
  });

  it("si ya se pagó en línea devuelve ese cobro (nunca doble cargo)", async () => {
    asService.mockResolvedValue(booking({ status: "confirmed", payment_status: "PAID" }));
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "COMPLETED" }));
    const result = await processFrontDeskPayment(receptionist, BOOKING_ID, "TERMINAL");
    expect(result.replay).toBe(true);
    expect(db.paymentTransaction.create).not.toHaveBeenCalled();
  });

  it("recepcionista de otro hotel: 403", async () => {
    asService.mockResolvedValue(booking({ hotel_id: OTHER_HOTEL, status: "confirmed" }));
    await expect(processFrontDeskPayment(receptionist, BOOKING_ID, "CASH")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("SUPER_ADMIN opera cualquier hotel", async () => {
    asService.mockResolvedValue(booking({ hotel_id: OTHER_HOTEL, status: "confirmed" }));
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx({ method: "CASH", channel: "FRONT_DESK" }));
    const admin = { userId: receptionist.userId, role: "SUPER_ADMIN", hotelId: null };
    await expect(processFrontDeskPayment(admin, BOOKING_ID, "CASH")).resolves.toMatchObject({ replay: false });
  });
});

describe("getPaymentStatus", () => {
  it("expone PAID si hay cobro completado aunque booking aún no procesó el evento", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "COMPLETED" }));
    const status = await getPaymentStatus(guest, BOOKING_ID);
    expect(status.payment_status).toBe("PAID");
    expect(status.transaction?.status).toBe("COMPLETED");
  });

  it("sin cobro: PENDING con el monto adeudado", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    const status = await getPaymentStatus(guest, BOOKING_ID);
    expect(status).toMatchObject({ payment_status: "PENDING", amount_due: 1260, transaction: null });
  });

  it("expone REFUNDED tras el reembolso simulado", async () => {
    asService.mockResolvedValue(booking({ status: "cancelled" }));
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "REFUNDED" }));
    const status = await getPaymentStatus(guest, BOOKING_ID);
    expect(status.payment_status).toBe("REFUNDED");
  });
});

describe("refundBooking (booking.cancelled)", () => {
  it("COMPLETED: pasa a REFUNDED y encola payment.refunded", async () => {
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "COMPLETED" }));
    db.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });
    db.paymentTransaction.findUniqueOrThrow.mockResolvedValue(tx({ status: "REFUNDED", refunded_at: new Date() }));

    await expect(refundBooking(BOOKING_ID)).resolves.toBe("refunded");
    expect(db.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { booking_id: BOOKING_ID, status: "COMPLETED" },
      data: expect.objectContaining({ status: "REFUNDED", refunded_at: expect.any(Date) }),
    });
    expect(db.eventOutbox.create).toHaveBeenCalledWith({
      data: {
        event_type: "payment.refunded",
        payload: { booking_id: BOOKING_ID, transaction_id: TX_ID, amount: 1260, currency: "COP" },
      },
    });
  });

  it("PROCESSING: agenda la reversión para cuando termine el cobro", async () => {
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "PROCESSING" }));
    db.paymentTransaction.updateMany.mockResolvedValue({ count: 1 });

    await expect(refundBooking(BOOKING_ID)).resolves.toBe("scheduled");
    expect(db.paymentTransaction.updateMany).toHaveBeenCalledWith({
      where: { booking_id: BOOKING_ID, status: "PROCESSING" },
      data: { refund_requested: true },
    });
    expect(db.eventOutbox.create).not.toHaveBeenCalled();
  });

  it("idempotente: un cobro ya reembolsado o fallido se ignora", async () => {
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "REFUNDED" }));
    await expect(refundBooking(BOOKING_ID)).resolves.toBe("ignored");
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "FAILED" }));
    await expect(refundBooking(BOOKING_ID)).resolves.toBe("ignored");
    expect(db.eventOutbox.create).not.toHaveBeenCalled();
  });

  it("sin transacción (reserva nunca cobrada): no-op", async () => {
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    await expect(refundBooking(BOOKING_ID)).resolves.toBe("ignored");
  });

  it("entrega duplicada: el update condicional evita un segundo evento", async () => {
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "COMPLETED" }));
    db.paymentTransaction.updateMany.mockResolvedValue({ count: 0 });

    await expect(refundBooking(BOOKING_ID)).resolves.toBe("ignored");
    expect(db.eventOutbox.create).not.toHaveBeenCalled();
  });

  it("cobro en vuelo: al completarse se revierte y emite payment.refunded, no payment.completed", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx());
    db.paymentTransaction.findUniqueOrThrow.mockResolvedValue(tx({ refund_requested: true }));

    const result = await processWebPayment(guest, BOOKING_ID, GOOD_CARD);

    expect(result.transaction.status).toBe("REFUNDED");
    const events = db.eventOutbox.create.mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(events).toContain("payment.refunded");
    expect(events).not.toContain("payment.completed");
  });
});
