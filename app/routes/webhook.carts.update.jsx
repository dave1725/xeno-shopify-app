import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Cart updated for ${shop}:`, payload);

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

    // Calculate cart value
    const cartValue = payload.line_items?.reduce((total, item) => 
      total + (parseFloat(item.price) * item.quantity), 0) || 0;

    // Store the cart updated event
    await prisma.event.create({
      data: {
        type: "cart_updated",
        shopifyId: payload.id?.toString(),
        customerEmail: payload.email,
        data: JSON.stringify({
          cartId: payload.id,
          itemCount: payload.line_items?.length || 0,
          totalValue: cartValue,
          lineItems: payload.line_items?.map(item => ({
            productId: item.product_id,
            variantId: item.variant_id,
            quantity: item.quantity,
            price: item.price
          }))
        }),
        tenantId: tenant.id,
        customerId: customer?.id
      }
    });

    console.log(`Cart update event stored for cart ${payload.id}`);
  } catch (error) {
    console.error("Error storing cart update event:", error);
  }

  return new Response(null, { status: 200 });
};