import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Checkout updated for ${shop}:`, payload);

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

    // Determine the event type based on checkout state
    let eventType = "checkout_updated";
    if (payload.completed_at) {
      eventType = "checkout_completed";
    } else if (payload.abandoned_checkout_url) {
      eventType = "checkout_abandoned";
    }

    // Store the checkout updated event
    await prisma.event.create({
      data: {
        type: eventType,
        shopifyId: payload.id.toString(),
        customerEmail: payload.email,
        data: JSON.stringify({
          checkoutValue: payload.total_price,
          itemCount: payload.line_items?.length || 0,
          currency: payload.currency,
          updatedAt: payload.updated_at,
          completedAt: payload.completed_at,
          abandonedAt: payload.abandoned_checkout_url ? payload.updated_at : null,
          checkoutToken: payload.token,
          shippingAddress: payload.shipping_address,
          billingAddress: payload.billing_address,
          paymentGatewayNames: payload.payment_gateway_names,
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

    console.log(`${eventType} event stored for ${payload.email || 'guest'}`);
  } catch (error) {
    console.error("Error storing checkout updated event:", error);
  }

  return new Response(null, { status: 200 });
};