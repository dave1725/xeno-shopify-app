import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Cart abandoned for ${shop}:`, payload);

  try {
    // Find or create tenant
    let tenant = await prisma.tenant.findUnique({ where: { shop } });
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { shop, name: shop } });
    }

    // Try to find customer by email
    let customer = null;
    if (payload.email) {
      customer = await prisma.customer.findFirst({
        where: {
          email: payload.email,
          tenantId: tenant.id,
        },
      });
    }

    // Store the cart abandoned event
    await prisma.event.create({
      data: {
        type: "cart_abandoned",
        shopifyId: payload.id.toString(),
        customerEmail: payload.email,
        data: {
          cartValue: payload.total_price,
          itemCount: payload.line_items?.length || 0,
          currency: payload.currency,
          abandonedAt: payload.updated_at,
          cartToken: payload.token,
          items:
            payload.line_items?.map((item) => ({
              title: item.title,
              quantity: item.quantity,
              price: item.price,
            })) || [],
        },
        tenantId: tenant.id,
        customerId: customer?.id || null,
      },
    });

    console.log(`Cart abandoned event stored for ${payload.email || "guest"}`);
  } catch (error) {
    console.error("Error storing cart abandoned event:", error);
  }

  return new Response(null, { status: 200 });
};
