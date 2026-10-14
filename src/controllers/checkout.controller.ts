import { Request, Response, NextFunction } from "express";
import { getPaymentStatus, processWebPayment } from "../services/payment.service";
import { payerFrom } from "../middleware/auth";
import type { CheckoutInput } from "../validators/payment";

/** POST /v1/checkout — 201 cobro nuevo, 200 si ya estaba cobrada (idempotencia). */
export const checkout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { booking_id, card } = req.body as CheckoutInput;
    const result = await processWebPayment(payerFrom(req), booking_id, card);
    res.status(result.replay ? 200 : 201).json({ data: result.transaction, replay: result.replay });
  } catch (error) {
    next(error);
  }
};

/** GET /v1/checkout/:bookingId — estado de pago (huésped dueño, manage token o staff del hotel). */
export const checkoutStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = await getPaymentStatus(payerFrom(req), req.params.bookingId);
    res.json({ data: status });
  } catch (error) {
    next(error);
  }
};
