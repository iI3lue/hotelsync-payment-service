import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Seed opcional de demostración. Un cobro COMPLETED deja ver el pago en
// `GET /v1/checkout/:bookingId` y `GET /v1/admin/payments/:bookingId` sin pasar
// por un checkout real. Es idempotente por `booking_id` (unique).
const DEMO_BOOKING_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10";
const DEMO_USER_ID = "11111111-1111-4111-8111-111111111111";

async function main() {
  console.log("Seeding payment database...");

  const bookingId = process.env.SEED_BOOKING_ID ?? DEMO_BOOKING_ID;
  const amount = Number(process.env.SEED_AMOUNT ?? "250000");
  const currency = process.env.PAYMENT_CURRENCY ?? "COP";

  await prisma.paymentTransaction.upsert({
    where: { booking_id: bookingId },
    update: {},
    create: {
      booking_id: bookingId,
      user_id: process.env.SEED_USER_ID ?? DEMO_USER_ID,
      hotel_id: process.env.SEED_HOTEL_ID ?? null,
      amount,
      currency,
      method: "CREDIT_CARD",
      status: "COMPLETED",
      channel: "WEB",
      auth_code: "DEMO-AUTH-0001",
      card_brand: "VISA",
      card_last4: "4242",
    },
  });

  console.log(
    `Seeded demo COMPLETED payment for booking ${bookingId} (${amount} ${currency}).`
  );
  console.log("Seed completed successfully.");
}

main()
  .catch((error) => {
    console.error("Payment seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
