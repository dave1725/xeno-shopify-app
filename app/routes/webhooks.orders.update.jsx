import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Order updated for ${shop}:`, payload);

  try {
    // Find or create tenant
    let tenant = await prisma.tenant.findUnique({ where: { shop } });
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { shop, name: shop } });
    }

    // Update the order
    await prisma.order.upsert({
      where: { shopifyId: payload.id.toString() },
      update: {
        totalPrice: parseFloat(payload.total_price),
        createdAt: new Date(payload.created_at),
        tenantId: tenant.id,
      },
      create: {
        shopifyId: payload.id.toString(),
        totalPrice: parseFloat(payload.total_price),
        createdAt: new Date(payload.created_at),
        tenantId: tenant.id,
      },
    });

    console.log(`Order ${payload.id} updated successfully`);
  } catch (error) {
    console.error("Error syncing order update:", error);
  }

  return new Response(null, { status: 200 });
};
