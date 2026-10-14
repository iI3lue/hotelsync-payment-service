import { Router } from "express";
import { checkout, checkoutStatus } from "../controllers/checkout.controller";
import { requirePayer } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { BookingIdParamSchema, CheckoutSchema } from "../validators/payment";

const router = Router();
// Bearer del huésped o x-manage-token (reserva anónima). Nunca reintentar
// el POST en el cliente: la idempotencia vive en el servidor.
router.use(requirePayer);
router.post("/", validate(CheckoutSchema), checkout);
router.get("/:bookingId", validate(BookingIdParamSchema, "params"), checkoutStatus);
export { router as checkoutRouter };
