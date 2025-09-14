import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Checkout started for ${shop}:`, payload);

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
          tenantId: tenant.id 
        }
      });
    }

    // Store the checkout started event
    await prisma.event.create({
      data: {
        type: "checkout_started",
        shopifyId: payload.id.toString(),
        customerEmail: payload.email,
        data: JSON.stringify({
          checkoutValue: payload.total_price,
          itemCount: payload.line_items?.length || 0,
          currency: payload.currency,
          startedAt: payload.created_at,
          checkoutToken: payload.token,
          shippingAddress: payload.shipping_address,
          items: payload.line_items?.map(item => ({
            title: item.title,
            quantity: item.quantity,
            price: item.price,
            variant_title: item.variant_title
          })) || []
        }),
        tenantId: tenant.id,
        customerId: customer?.id || null,
      },
    });

    console.log(`Checkout started event stored for ${payload.email || 'guest'}`);
  } catch (error) {
    console.error("Error storing checkout started event:", error);
  }

  return new Response(null, { status: 200 });
};