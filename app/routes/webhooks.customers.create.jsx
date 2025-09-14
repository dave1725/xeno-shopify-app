import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Customer created for ${shop}:`, payload);

  try {
    // Find or create tenant
    let tenant = await prisma.tenant.findUnique({ where: { shop } });
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { shop, name: shop } });
    }

    // Store the new customer
    await prisma.customer.upsert({
      where: { shopifyId: payload.id.toString() },
      update: {
        email: payload.email,
        name: `${payload.first_name || ""} ${payload.last_name || ""}`.trim(),
        createdAt: new Date(payload.created_at),
        tenantId: tenant.id,
      },
      create: {
        shopifyId: payload.id.toString(),
        email: payload.email,
        name: `${payload.first_name || ""} ${payload.last_name || ""}`.trim(),
        createdAt: new Date(payload.created_at),
        tenantId: tenant.id,
      },
    });

    console.log(`Customer ${payload.id} synced successfully`);
  } catch (error) {
    console.error("Error syncing customer:", error);
  }

  return new Response();
};
