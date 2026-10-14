import { Router } from "express";
import { paymentStatusForStaff, registerManualPayment } from "../controllers/admin.controller";
import { requireAuth, requireRole } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { BookingIdParamSchema, FrontDeskPaymentSchema } from "../validators/payment";
import { STAFF_ROLES } from "../types";

const router = Router();
router.use(requireAuth, requireRole(STAFF_ROLES));
router.post("/payments", validate(FrontDeskPaymentSchema), registerManualPayment);
router.get("/payments/:bookingId", validate(BookingIdParamSchema, "params"), paymentStatusForStaff);
export { router as adminRouter };
