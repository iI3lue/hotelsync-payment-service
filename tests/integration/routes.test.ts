import request from "supertest";
import jwt from "jsonwebtoken";

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

import { createApp } from "../../src/app";
import { prisma } from "../../src/lib/prisma";
import { getBookingAsService, getBookingWithManageToken } from "../../src/lib/booking-client";
import { flushOutbox } from "../../src/lib/outbox";

const db = prisma as any;
const asService = getBookingAsService as jest.Mock;
const withToken = getBookingWithManageToken as jest.Mock;
const app = createApp();

const SECRET = "test-secret-for-unit-tests-only-32b!";
const BOOKING_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const HOTEL_ID = "c1b2c3d4-e5f6-4890-abcd-ef1234567890";
const GUEST_ID = "e1b2c3d4-e5f6-4890-abcd-ef1234567890";
const TX_ID = "f1b2c3d4-e5f6-4890-abcd-ef1234567890";

function token(claims: Record<string, unknown>, opts: jwt.SignOptions = {}) {
  return jwt.sign(claims, SECRET, { algorithm: "HS256", issuer: "hotelsync", audience: "hotelsync-api", expiresIn: 900, ...opts });
}
const GUEST = token({ sub: GUEST_ID, role: "GUEST", email: "ana@example.com" });
const RECEP = token({ sub: "11111111-2222-4333-8444-555555555555", role: "RECEPTIONIST", hotel_id: HOTEL_ID });

const card = { number: "4111 1111 1111 1111", exp_month: 12, exp_year: 2030, cvc: "123" };
const booking = (over: Record<string, unknown> = {}) => ({
  booking_id: BOOKING_ID,
  hotel_id: HOTEL_ID,
  status: "pending",
  total_amount: "1260.00",
  booked_by_user_id: GUEST_ID,
  payment_status: "PENDING",
  ...over,
});
const tx = (over: Record<string, unknown> = {}) => ({
  transaction_id: TX_ID,
  booking_id: BOOKING_ID,
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
  created_at: new Date(),
  updated_at: new Date(),
  refund_requested: false,
  refunded_at: null,
  ...over,
});

beforeEach(() => {
  jest.resetAllMocks();
  db.$transaction.mockImplementation(async (fn: any) => fn(db));
  db.paymentTransaction.update.mockImplementation(async ({ data }: any) => tx(data));
  db.paymentTransaction.findUniqueOrThrow.mockResolvedValue(tx());
});

describe("POST /v1/checkout", () => {
  it("401 sin Bearer ni manage token", async () => {
    const res = await request(app).post("/v1/checkout").send({ booking_id: BOOKING_ID, card });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("401 con un token firmado con otro secreto (o sin iss/aud)", async () => {
    const forged = jwt.sign({ sub: GUEST_ID, role: "GUEST" }, "otro-secreto-otro-secreto-otro-secreto!");
    const res = await request(app).post("/v1/checkout").set("Authorization", `Bearer ${forged}`).send({ booking_id: BOOKING_ID, card });
    expect(res.status).toBe(401);
  });

  it("400 de validación sin devolver el número de tarjeta", async () => {
    const res = await request(app)
      .post("/v1/checkout")
      .set("Authorization", `Bearer ${GUEST}`)
      .send({ booking_id: BOOKING_ID, card: { ...card, number: "4111-abc", cvc: "12" } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("4111");
  });

  it("201 al cobrar; normaliza espacios del número", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx());
    const res = await request(app).post("/v1/checkout").set("Authorization", `Bearer ${GUEST}`).send({ booking_id: BOOKING_ID, card });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "COMPLETED", card_last4: "1111", amount: 1260 });
    expect(res.body.replay).toBe(false);
  });

  it("200 + replay cuando la reserva ya estaba cobrada", async () => {
    asService.mockResolvedValue(booking({ payment_status: "PAID" }));
    db.paymentTransaction.findUnique.mockResolvedValue(tx({ status: "COMPLETED" }));
    const res = await request(app).post("/v1/checkout").set("Authorization", `Bearer ${GUEST}`).send({ booking_id: BOOKING_ID, card });
    expect(res.status).toBe(200);
    expect(res.body.replay).toBe(true);
  });

  it("402 con la tarjeta de rechazo", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx());
    const res = await request(app)
      .post("/v1/checkout")
      .set("Authorization", `Bearer ${GUEST}`)
      .send({ booking_id: BOOKING_ID, card: { ...card, number: "4000000000000002" } });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("PaymentDeclined");
  });

  it("acepta x-manage-token sin Bearer (reserva anónima)", async () => {
    withToken.mockResolvedValue(booking({ booked_by_user_id: null }));
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx());
    const res = await request(app).post("/v1/checkout").set("x-manage-token", "abc").send({ booking_id: BOOKING_ID, card });
    expect(res.status).toBe(201);
  });

  it("400 con JSON mal formado (sin 500)", async () => {
    const res = await request(app)
      .post("/v1/checkout")
      .set("Authorization", `Bearer ${GUEST}`)
      .set("Content-Type", "application/json")
      .send("{malformado");
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/checkout/:bookingId", () => {
  it("400 si el id no es UUID", async () => {
    const res = await request(app).get("/v1/checkout/123").set("Authorization", `Bearer ${GUEST}`);
    expect(res.status).toBe(400);
  });

  it("devuelve el estado de pago al dueño", async () => {
    asService.mockResolvedValue(booking());
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    const res = await request(app).get(`/v1/checkout/${BOOKING_ID}`).set("Authorization", `Bearer ${GUEST}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ payment_status: "PENDING", amount_due: 1260 });
  });
});

describe("/v1/admin/payments", () => {
  it("403 para un huésped", async () => {
    const res = await request(app)
      .post("/v1/admin/payments")
      .set("Authorization", `Bearer ${GUEST}`)
      .send({ booking_id: BOOKING_ID, method: "CASH" });
    expect(res.status).toBe(403);
  });

  it("201 para recepción de su hotel", async () => {
    asService.mockResolvedValue(booking({ status: "confirmed" }));
    db.paymentTransaction.findUnique.mockResolvedValue(null);
    db.paymentTransaction.create.mockResolvedValue(tx({ method: "CASH", channel: "FRONT_DESK" }));
    const res = await request(app)
      .post("/v1/admin/payments")
      .set("Authorization", `Bearer ${RECEP}`)
      .send({ booking_id: BOOKING_ID, method: "CASH" });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("COMPLETED");
    expect(db.paymentTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ method: "CASH", channel: "FRONT_DESK" }),
    });
  });

  it("400 con un método no permitido (tarjeta en recepción va por datáfono)", async () => {
    const res = await request(app)
      .post("/v1/admin/payments")
      .set("Authorization", `Bearer ${RECEP}`)
      .send({ booking_id: BOOKING_ID, method: "CREDIT_CARD" });
    expect(res.status).toBe(400);
  });
});

describe("outbox", () => {
  it("marca sent solo tras publicar y se detiene si el broker falla", async () => {
    db.eventOutbox.findMany.mockResolvedValue([
      { event_id: "e1", event_type: "payment.completed", payload: { a: 1 } },
      { event_id: "e2", event_type: "payment.completed", payload: { a: 2 } },
    ]);
    const publisher = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("down"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const delivered = await flushOutbox(100, publisher);

    expect(delivered).toBe(1);
    expect(db.eventOutbox.update).toHaveBeenCalledWith({
      where: { event_id: "e1" },
      data: expect.objectContaining({ status: "sent" }),
    });
    expect(db.eventOutbox.update).toHaveBeenCalledWith({
      where: { event_id: "e2" },
      data: { attempts: { increment: 1 } },
    });
  });
});
