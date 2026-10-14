import { Request, Response, NextFunction } from "express";
import { getPaymentStatus, processFrontDeskPayment } from "../services/payment.service";
import type { FrontDeskPaymentInput } from "../validators/payment";

/** POST /v1/admin/payments — pago manual de recepción. 201 nuevo, 200 si ya estaba pagada. */
export const registerManualPayment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { booking_id, method, received_by } = req.body as FrontDeskPaymentInput;
    const result = await processFrontDeskPayment(req.user!, booking_id, method, received_by);
    res.status(result.replay ? 200 : 201).json({ data: result.transaction, replay: result.replay });
  } catch (error) {
    next(error);
  }
};

/** GET /v1/admin/payments/:bookingId — estado de pago para recepción. */
export const paymentStatusForStaff = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await getPaymentStatus({ user: req.user }, req.params.bookingId) });
  } catch (error) {
    next(error);
  }
};
