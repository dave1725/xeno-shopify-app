import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Draft order created for ${shop}:`, payload?.id);

  try {
    // Find or create tenant
    let tenant = await prisma.tenant.findUnique({ where: { shop } });
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { shop, name: shop } });
    }

    // Try to find customer by email
    const email = payload?.email || payload?.customer?.email || null;
    let customer = null;
    if (email) {
      customer = await prisma.customer.findFirst({
        where: { email, tenantId: tenant.id },
      });
    }

    const itemCount = payload?.line_items?.length || 0;
    const total = parseFloat(payload?.total_price || payload?.subtotal_price || 0);

    await prisma.event.create({
      data: {
        type: "draft_order_created",
        shopifyId: payload.id?.toString(),
        customerEmail: email,
        data: {
          draftOrderId: payload.id,
          name: payload.name,
          itemCount,
          total,
          currency: payload?.currency,
          createdAt: payload?.created_at,
          invoiceUrl: payload?.invoice_url,
          status: payload?.status,
          lineItems:
            payload?.line_items?.map((li) => ({
              title: li.title,
              quantity: li.quantity,
              price: li.price || li.applied_discount?.value,
              productId: li.product_id,
              variantId: li.variant_id,
            })) || [],
        },
        tenantId: tenant.id,
        customerId: customer?.id || null,
      },
    });
  } catch (error) {
    console.error("Error storing draft order create event:", error);
  }

  return new Response(null, { status: 200 });
};
