import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`Product updated for ${shop}:`, payload);

  try {
    // Find or create tenant
    let tenant = await prisma.tenant.findUnique({ where: { shop } });
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { shop, name: shop } });
    }

    // Update the product
    await prisma.product.upsert({
      where: { shopifyId: payload.id.toString() },
      update: {
        title: payload.title,
        handle: payload.handle,
        vendor: payload.vendor,
        productType: payload.product_type,
        price: parseFloat(payload.variants?.[0]?.price || "0"),
        inventory: parseInt(payload.variants?.[0]?.inventory_quantity || "0"),
        createdAt: new Date(payload.created_at),
        tenantId: tenant.id,
      },
      create: {
        shopifyId: payload.id.toString(),
        title: payload.title,
        handle: payload.handle,
        vendor: payload.vendor,
        productType: payload.product_type,
        price: parseFloat(payload.variants?.[0]?.price || "0"),
        inventory: parseInt(payload.variants?.[0]?.inventory_quantity || "0"),
        createdAt: new Date(payload.created_at),
        tenantId: tenant.id,
      },
    });

    console.log(`Product ${payload.id} updated successfully`);
  } catch (error) {
    console.error("Error syncing product update:", error);
  }

  return new Response(null, { status: 200 });
};
