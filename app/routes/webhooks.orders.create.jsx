import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request);

  console.log(`ORDER WEBHOOK TRIGGERED for ${shop}`);
  console.log(`Order ID: ${payload.id}`);
  console.log(`Total Price: ${payload.total_price}`);
  console.log(`Customer:`, payload.customer);
  console.log(`Created At: ${payload.created_at}`);
  console.log(`Order created for ${shop}:`, payload);

  try {
    // Find or create tenant
    let tenant = await prisma.tenant.findUnique({ where: { shop } });
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { shop, name: shop } });
    }

    // Find or create customer if customer data exists
    let customerId = null;
    if (payload.customer && payload.customer.id) {
      let customer = await prisma.customer.findUnique({ 
        where: { shopifyId: payload.customer.id.toString() } 
      });
      
      if (!customer && payload.customer.email) {
        // Create customer if doesn't exist
        customer = await prisma.customer.create({
          data: {
            shopifyId: payload.customer.id.toString(),
            email: payload.customer.email,
            name: payload.customer.first_name && payload.customer.last_name 
              ? `${payload.customer.first_name} ${payload.customer.last_name}`.trim()
              : null,
            tenantId: tenant.id,
          }
        });
        console.log(`Created new customer: ${customer.email}`);
      }
      
      customerId = customer?.id;
    }

    // Store the new order with customer link
    await prisma.order.upsert({
      where: { shopifyId: payload.id.toString() },
      update: {
        totalPrice: parseFloat(payload.total_price),
        createdAt: new Date(payload.created_at),
        customerId: customerId,
        tenantId: tenant.id,
      },
      create: {
        shopifyId: payload.id.toString(),
        totalPrice: parseFloat(payload.total_price),
        createdAt: new Date(payload.created_at),
        customerId: customerId,
        tenantId: tenant.id,
      },
    });

    console.log(`Order ${payload.id} synced successfully`);
  } catch (error) {
    console.error("Error syncing order:", error);
  }

  return new Response();
};
