import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Checkout abandoned for ${shop}:`, payload);

  try {
    // Find or create tenant
    let tenant = await prisma.tenant.findUnique({ where: { shop } });
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { shop, name: shop } });
    }

    // Find customer
    let customer = null;
    if (payload.customer?.email) {
      customer = await prisma.customer.findFirst({
        where: { 
          email: payload.customer.email,
          tenantId: tenant.id 
        }
      });
    }

    // Calculate abandonment data
    const abandonedValue = parseFloat(payload.total_price || 0);
    const abandonedItems = payload.line_items?.length || 0;
    const timeToAbandon = payload.updated_at ? 
      new Date(payload.updated_at) - new Date(payload.created_at) : null;

    // Store abandonment event with rich data
    await prisma.event.create({
      data: {
        type: "checkout_abandoned",
        shopifyId: payload.id?.toString(),
        customerEmail: payload.customer?.email,
        data: JSON.stringify({
          checkoutId: payload.id,
          abandonedValue,
          abandonedItems,
          timeToAbandonMs: timeToAbandon,
          shippingAddress: payload.shipping_address,
          paymentMethod: payload.gateway,
          discountCodes: payload.discount_codes,
          lineItems: payload.line_items?.map(item => ({
            productId: item.product_id,
            variantId: item.variant_id,
            quantity: item.quantity,
            price: item.price,
            title: item.title
          }))
        }),
        tenantId: tenant.id,
        customerId: customer?.id
      }
    });

    console.log(`Checkout abandonment tracked: $${abandonedValue}`);
  } catch (error) {
    console.error("Error tracking checkout abandonment:", error);
  }

  return new Response(null, { status: 200 });
};