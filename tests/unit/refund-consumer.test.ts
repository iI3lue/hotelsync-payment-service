jest.mock("../../src/lib/broker", () => ({ connect: jest.fn() }));
jest.mock("../../src/services/payment.service", () => ({ refundBooking: jest.fn() }));

import { refundBooking } from "../../src/services/payment.service";
import { handleBookingCancelledMessage } from "../../src/lib/refund-consumer";

const BOOKING_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const refund = refundBooking as jest.Mock;

function message(payload: unknown) {
  return { content: Buffer.from(JSON.stringify(payload)) } as any;
}

function channel() {
  return { ack: jest.fn(), nack: jest.fn() };
}

beforeEach(() => jest.resetAllMocks());

describe("handleBookingCancelledMessage", () => {
  it("reembolsa y confirma el mensaje", async () => {
    refund.mockResolvedValue("refunded");
    const ch = channel();

    await handleBookingCancelledMessage(ch as any, message({ booking_id: BOOKING_ID, status: "cancelled" }));

    expect(refund).toHaveBeenCalledWith(BOOKING_ID);
    expect(ch.ack).toHaveBeenCalled();
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it("descarta un mensaje con JSON o payload inválido", async () => {
    const ch = channel();
    await handleBookingCancelledMessage(ch as any, { content: Buffer.from("no-json") } as any);
    await handleBookingCancelledMessage(ch as any, message({ booking_id: "no-uuid" }));

    expect(refund).not.toHaveBeenCalled();
    expect(ch.ack).toHaveBeenCalledTimes(2);
    expect(ch.nack).not.toHaveBeenCalled();
  });

  it("si el reembolso falla, reencola con delay", async () => {
    jest.useFakeTimers();
    refund.mockRejectedValue(new Error("db down"));
    const ch = channel();

    await handleBookingCancelledMessage(ch as any, message({ booking_id: BOOKING_ID }), 50);
    expect(ch.nack).not.toHaveBeenCalled();

    jest.advanceTimersByTime(50);
    expect(ch.nack).toHaveBeenCalledWith(expect.anything(), false, true);
    jest.useRealTimers();
  });
});
