import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  Box,
  List,
  Link,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  ResponsiveContainer,
} from "recharts";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = formData.get("intent");

  const shop = session?.shop;

  async function ensureTenant(shopDomain) {
    if (!shopDomain) throw new Error("Missing shop domain for ingestion");
    let tenant = await prisma.tenant.findUnique({ where: { shop: shopDomain } });
    if (!tenant) {
      tenant = await prisma.tenant.create({ data: { shop: shopDomain, name: shopDomain } });
    }
    return tenant;
  }

  const gidToId = (gid) => (typeof gid === "string" ? gid.split("/").pop() : gid);

  // Helper: page through a connection and count nodes (read-only)
  async function countAll(query, connectionPath, variables = {}) {
    let hasNextPage = true;
    let after = undefined;
    let total = 0;

    while (hasNextPage) {
      const res = await admin.graphql(`#graphql\n${query}`, {
        variables: { first: 100, after, ...variables },
      });
      const json = await res.json();

      const parts = connectionPath.split(".");
      let node = json;
      for (const p of parts) node = node?.[p];
      const edges = node?.edges ?? [];
      total += edges.length;
      hasNextPage = node?.pageInfo?.hasNextPage ?? false;
      after = node?.pageInfo?.endCursor ?? undefined;
    }

    return total;
  }

  // Collect nodes for metrics aggregation
  async function collectAll(query, connectionPath, variables = {}, limit = 1000) {
    let hasNextPage = true;
    let after = undefined;
    const nodes = [];
    while (hasNextPage && nodes.length < limit) {
      const res = await admin.graphql(`#graphql\n${query}`, {
        variables: { first: 100, after, ...variables },
      });
      const json = await res.json();
      const parts = connectionPath.split(".");
      let node = json;
      for (const p of parts) node = node?.[p];
      const edges = node?.edges ?? [];
      for (const e of edges) nodes.push(e.node);
      hasNextPage = node?.pageInfo?.hasNextPage ?? false;
      after = node?.pageInfo?.endCursor ?? undefined;
    }
    return nodes;
  }

  // (No batch helper; ingestion uses full collectAll scans)

  if (intent === "metrics") {
    const startDate = String(formData.get("startDate") || "");
    const endDate = String(formData.get("endDate") || "");
    const toISODate = (d) => new Date(d).toISOString().slice(0, 10);
    const now = new Date();
    const defaultEnd = toISODate(now);
    const defaultStart = toISODate(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));
    const start = startDate || defaultStart;
    const end = endDate || defaultEnd;

    const queryStr = `created_at:>=${start} created_at:<=${end}`;
    const ordersQuery = `
      query listOrders($first: Int!, $after: String, $query: String) {
        orders(first: $first, after: $after, sortKey: CREATED_AT, query: $query) {
          edges {
            cursor
            node {
              id
              createdAt
              totalPriceSet { shopMoney { amount } }
              customer { id displayName email }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const orders = await collectAll(ordersQuery, "data.orders", { query: queryStr }, 2000);

    // Customers from orders in range (unique count)
    const customersSet = new Set();
    // Totals and series
    const byDate = new Map();
    const byCustomer = new Map();
    let totalRevenue = 0;

    for (const o of orders) {
      const date = o.createdAt.slice(0, 10);
      const amount = parseFloat(o.totalPriceSet?.shopMoney?.amount || "0");
      totalRevenue += amount;
      byDate.set(date, {
        date,
        orders: (byDate.get(date)?.orders || 0) + 1,
        revenue: (byDate.get(date)?.revenue || 0) + amount,
      });

      const custKey = o.customer?.id || o.customer?.email || undefined;
      if (custKey) {
        customersSet.add(custKey);
        if (!byCustomer.has(custKey)) {
          byCustomer.set(custKey, {
            id: custKey,
            name: o.customer?.displayName || o.customer?.email || "Unknown",
            email: o.customer?.email || "",
            total: 0,
          });
        }
        byCustomer.get(custKey).total += amount;
      }
    }

    const series = Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
    const topCustomers = Array.from(byCustomer.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    return {
      metrics: {
        totals: {
          customers: customersSet.size,
          orders: orders.length,
          revenue: Number(totalRevenue.toFixed(2)),
        },
        series,
        topCustomers,
        range: { start, end },
      },
    };
  }

  if (intent === "ingest_products" || intent === "ingest_all") {
    const tenant = await ensureTenant(shop);
    const productsQuery = `
      query listProducts($first: Int!, $after: String) {
        products(first: $first, after: $after) {
          edges { cursor node { id title handle vendor productType createdAt variants(first:1){edges{node{price}}} } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    let productsCount = 0;
    const handleProducts = async (nodes) => {
      for (const p of nodes) {
      const price = parseFloat(p?.variants?.edges?.[0]?.node?.price ?? "0");
      await prisma.product.upsert({
        where: { shopifyId: gidToId(p.id) },
        update: {
          title: p.title,
          handle: p.handle,
          vendor: p.vendor,
          productType: p.productType,
          price,
          createdAt: new Date(p.createdAt),
          tenantId: tenant.id,
        },
        create: {
          shopifyId: gidToId(p.id),
          title: p.title,
          handle: p.handle,
          vendor: p.vendor,
          productType: p.productType,
          price,
          createdAt: new Date(p.createdAt),
          tenantId: tenant.id,
        },
      });
        productsCount++;
      }
    };
    const products = await collectAll(productsQuery, "data.products");
    await handleProducts(products);

    if (intent === "ingest_products") {
      return { ingested: { products: productsCount }, ok: true };
    }

    // Fall through to also ingest customers/orders when ingest_all
    const customersQuery = `
      query listCustomers($first: Int!, $after: String) {
        customers(first: $first, after: $after) {
          edges { cursor node { id email displayName createdAt } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    let customersCount = 0;
    const handleCustomers = async (nodes) => {
      for (const c of nodes) {
        await prisma.customer.upsert({
          where: { shopifyId: gidToId(c.id) },
          update: {
            email: c.email ?? "",
            name: c.displayName ?? null,
            createdAt: new Date(c.createdAt),
            tenantId: tenant.id,
          },
          create: {
            shopifyId: gidToId(c.id),
            email: c.email ?? "",
            name: c.displayName ?? null,
            createdAt: new Date(c.createdAt),
            tenantId: tenant.id,
          },
        });
        customersCount++;
      }
    };
    const customers = await collectAll(customersQuery, "data.customers");
    await handleCustomers(customers);

    const ordersQuery = `
      query listOrders($first: Int!, $after: String) {
        orders(first: $first, after: $after, sortKey: CREATED_AT) {
          edges { cursor node { id createdAt totalPriceSet { shopMoney { amount } } customer { id email displayName } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    let ordersCount = 0;
    const handleOrders = async (nodes) => {
      for (const o of nodes) {
      let customerId = null;
      if (o.customer?.id) {
        const shopifyCustId = gidToId(o.customer.id);
        const customer = await prisma.customer.upsert({
          where: { shopifyId: shopifyCustId },
          update: {
            email: o.customer.email ?? "",
            name: o.customer.displayName ?? null,
            tenantId: tenant.id,
          },
          create: {
            shopifyId: shopifyCustId,
            email: o.customer.email ?? "",
            name: o.customer.displayName ?? null,
            tenantId: tenant.id,
          },
        });
        customerId = customer.id;
      }

      await prisma.order.upsert({
        where: { shopifyId: gidToId(o.id) },
        update: {
          totalPrice: parseFloat(o.totalPriceSet?.shopMoney?.amount ?? "0"),
          createdAt: new Date(o.createdAt),
          customerId,
          tenantId: tenant.id,
        },
        create: {
          shopifyId: gidToId(o.id),
          totalPrice: parseFloat(o.totalPriceSet?.shopMoney?.amount ?? "0"),
          createdAt: new Date(o.createdAt),
          customerId,
          tenantId: tenant.id,
        },
      });
        ordersCount++;
      }
    };
    const orders = await collectAll(ordersQuery, "data.orders");
    await handleOrders(orders);

    return { ingested: { products: productsCount, customers: customersCount, orders: ordersCount }, ok: true };
  }

  if (intent === "ingest_customers") {
    const tenant = await ensureTenant(shop);
    const customersQuery = `
      query listCustomers($first: Int!, $after: String) {
        customers(first: $first, after: $after) {
          edges { cursor node { id email displayName createdAt } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    let customersCount = 0;
    const handleCustomers = async (nodes) => {
      for (const c of nodes) {
        await prisma.customer.upsert({
          where: { shopifyId: gidToId(c.id) },
          update: {
            email: c.email ?? "",
            name: c.displayName ?? null,
            createdAt: new Date(c.createdAt),
            tenantId: tenant.id,
          },
          create: {
            shopifyId: gidToId(c.id),
            email: c.email ?? "",
            name: c.displayName ?? null,
            createdAt: new Date(c.createdAt),
            tenantId: tenant.id,
          },
        });
        customersCount++;
      }
    };
    const customers = await collectAll(customersQuery, "data.customers");
    await handleCustomers(customers);
    return { ingested: { customers: customersCount }, ok: true };
  }

  if (intent === "ingest_orders") {
    const tenant = await ensureTenant(shop);
    const ordersQuery = `
      query listOrders($first: Int!, $after: String) {
        orders(first: $first, after: $after, sortKey: CREATED_AT) {
          edges { cursor node { id createdAt totalPriceSet { shopMoney { amount } } customer { id email displayName } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    let ordersCount = 0;
    const handleOrders = async (nodes) => {
      for (const o of nodes) {
        let customerId = null;
        if (o.customer?.id) {
          const shopifyCustId = gidToId(o.customer.id);
          const customer = await prisma.customer.upsert({
            where: { shopifyId: shopifyCustId },
            update: {
              email: o.customer.email ?? "",
              name: o.customer.displayName ?? null,
              tenantId: tenant.id,
            },
            create: {
              shopifyId: shopifyCustId,
              email: o.customer.email ?? "",
              name: o.customer.displayName ?? null,
              tenantId: tenant.id,
            },
          });
          customerId = customer.id;
        }
        await prisma.order.upsert({
          where: { shopifyId: gidToId(o.id) },
          update: {
            totalPrice: parseFloat(o.totalPriceSet?.shopMoney?.amount ?? "0"),
            createdAt: new Date(o.createdAt),
            customerId,
            tenantId: tenant.id,
          },
          create: {
            shopifyId: gidToId(o.id),
            totalPrice: parseFloat(o.totalPriceSet?.shopMoney?.amount ?? "0"),
            createdAt: new Date(o.createdAt),
            customerId,
            tenantId: tenant.id,
          },
        });
        ordersCount++;
      }
    };
    const orders = await collectAll(ordersQuery, "data.orders");
    await handleOrders(orders);
    return { ingested: { orders: ordersCount }, ok: true };
  }

  // Default path: keep original demo to create a product
  const color = ["Red", "Orange", "Yellow", "Green"][
    Math.floor(Math.random() * 4)
  ];
  const response = await admin.graphql(
    `#graphql
      mutation populateProduct($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            title
            handle
            status
            variants(first: 10) {
              edges {
                node {
                  id
                  price
                  barcode
                  createdAt
                }
              }
            }
          }
        }
      }`,
    {
      variables: {
        product: {
          title: `${color} Snowboard`,
        },
      },
    },
  );
  const responseJson = await response.json();
  const product = responseJson.data.productCreate.product;
  const variantId = product.variants.edges[0].node.id;
  const variantResponse = await admin.graphql(
    `#graphql
    mutation shopifyRemixTemplateUpdateVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          price
          barcode
          createdAt
        }
      }
    }`,
    {
      variables: {
        productId: product.id,
        variants: [{ id: variantId, price: "100.00" }],
      },
    },
  );
  const variantResponseJson = await variantResponse.json();

  return {
    product: responseJson.data.productCreate.product,
    variant: variantResponseJson.data.productVariantsBulkUpdate.productVariants,
  };
};

export default function Index() {
  const fetcher = useFetcher();
  const ingestFetcher = useFetcher();
  const metricsFetcher = useFetcher();
  const shopify = useAppBridge();
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  const isIngesting = ["loading", "submitting"].includes(ingestFetcher.state);
  const isLoadingMetrics = ["loading", "submitting"].includes(metricsFetcher.state);
  const productId = fetcher.data?.product?.id.replace(
    "gid://shopify/Product/",
    "",
  );
  const [startDate, setStartDate] = useState(() => {
    const d = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isHydrated, setIsHydrated] = useState(false);
  // Ingestion filters (batching removed)
  const [ingestSince, setIngestSince] = useState("");

  useEffect(() => {
    if (productId) {
      shopify.toast.show("Product created");
    }
  }, [productId, shopify]);
  const generateProduct = () => fetcher.submit({}, { method: "POST" });
  const ingest = (intent) => ingestFetcher.submit({ intent }, { method: "POST" });
  const loadMetrics = () =>
    metricsFetcher.submit(
      { intent: "metrics", startDate, endDate },
      { method: "POST" },
    );

  // Auto-load metrics on mount
  useEffect(() => {
    loadMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mark client hydration to safely render client-only charts
  useEffect(() => {
    setIsHydrated(true);
  }, []);

  // batching removed

  const metrics = metricsFetcher.data?.metrics;
  const totals = metrics?.totals;
  const series = metrics?.series || [];
  const topCustomers = metrics?.topCustomers || [];
  const revenueMax = useMemo(() => Math.max(0, ...series.map((d) => d.revenue)), [series]);
  const ordersMax = useMemo(() => Math.max(0, ...series.map((d) => d.orders)), [series]);

  return (
    <Page>
      <TitleBar title="Insights Dashboard" />
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" gap="300">
              <Text as="h2" variant="headingMd">
                Overview {metrics?.range ? `(${metrics.range.start} → ${metrics.range.end})` : ""}
              </Text>
            </InlineStack>
            <InlineStack gap="300" align="start">
              <div>
                <label>
                  <Text as="span" variant="bodySm">Start date</Text>
                  <input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    style={{ display: "block", padding: 8 }}
                  />
                </label>
              </div>
              <div>
                <label>
                  <Text as="span" variant="bodySm">End date</Text>
                  <input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    style={{ display: "block", padding: 8 }}
                  />
                </label>
              </div>
              <Button loading={isLoadingMetrics} onClick={loadMetrics}>
                Refresh
              </Button>
            </InlineStack>
            {totals && (
              <InlineStack gap="300" align="start">
                <Card>
                  <Box padding="400">
                    <Text as="h3" variant="headingSm">Total Customers</Text>
                    <Text as="p" variant="headingLg">{totals.customers.toLocaleString()}</Text>
                  </Box>
                </Card>
                <Card>
                  <Box padding="400">
                    <Text as="h3" variant="headingSm">Total Orders</Text>
                    <Text as="p" variant="headingLg">{totals.orders.toLocaleString()}</Text>
                  </Box>
                </Card>
                <Card>
                  <Box padding="400">
                    <Text as="h3" variant="headingSm">Revenue</Text>
                    <Text as="p" variant="headingLg">${totals.revenue.toLocaleString()}</Text>
                  </Box>
                </Card>
              </InlineStack>
            )}
          </BlockStack>
        </Card>

        <Layout>
          <Layout.Section>
            <Card>
              <Box padding="400">
                <Text as="h3" variant="headingMd">Orders & Revenue by date</Text>
              </Box>
              <div style={{ width: "100%", height: 320 }}>
                {isHydrated ? (
                  <ResponsiveContainer>
                    <LineChart data={series} margin={{ left: 16, right: 16, top: 8, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                      <YAxis yAxisId="left" domain={[0, Math.max(5, ordersMax)]} tick={{ fontSize: 12 }} />
                      <YAxis yAxisId="right" orientation="right" domain={[0, Math.max(10, revenueMax)]} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Line yAxisId="left" type="monotone" dataKey="orders" name="Orders" stroke="#5c6ac4" strokeWidth={2} dot={false} />
                      <Line yAxisId="right" type="monotone" dataKey="revenue" name="Revenue" stroke="#008060" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <Box padding="400"><Text as="p" variant="bodyMd">Loading chart…</Text></Box>
                )}
              </div>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <Box padding="400">
                <Text as="h3" variant="headingMd">Top 5 customers by spend</Text>
              </Box>
              <div style={{ width: "100%", height: 320 }}>
                {isHydrated ? (
                  <ResponsiveContainer>
                    <BarChart data={topCustomers} layout="vertical" margin={{ left: 16, right: 16, top: 8, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" tick={{ fontSize: 12 }} />
                      <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Bar dataKey="total" name="Spend" fill="#5c6ac4" />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <Box padding="400"><Text as="p" variant="bodyMd">Loading chart…</Text></Box>
                )}
              </div>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
      {/* Manual ingestion controls remain available to aid historical fetches */}
      <TitleBar title="Ingestion Tools">
        <button
          variant="primary"
          onClick={() => ingest("ingest_all")}
          disabled={isIngesting}
        >
          Ingest All (Products, Customers, Orders)
        </button>
      </TitleBar>
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Manual ingestion controls</Text>
            <InlineStack gap="300" align="start">
              <div>
                <label>
                  <Text as="span" variant="bodySm">Since (optional)</Text>
                  <input
                    type="date"
                    value={ingestSince}
                    onChange={(e) => setIngestSince(e.target.value)}
                    style={{ display: "block", padding: 8 }}
                  />
                </label>
              </div>
              <Button onClick={() => ingest("ingest_products", { since: ingestSince || "" })} loading={isIngesting}>
                Ingest Products
              </Button>
              <Button onClick={() => ingest("ingest_customers", { since: ingestSince || "" })} loading={isIngesting}>
                Ingest Customers
              </Button>
              <Button onClick={() => ingest("ingest_orders", { since: ingestSince || "" })} loading={isIngesting}>
                Ingest Orders
              </Button>
            </InlineStack>
            {/* batch controls removed */}
            {ingestFetcher.data?.ingested && (
              <>
                <Text as="h3" variant="headingMd">
                  Ingestion result
                </Text>
                <Box
                  padding="400"
                  background="bg-surface-active"
                  borderWidth="025"
                  borderRadius="200"
                  borderColor="border"
                  overflowX="scroll"
                >
                  <pre style={{ margin: 0 }}>
                    <code>{JSON.stringify(ingestFetcher.data.ingested, null, 2)}</code>
                  </pre>
                </Box>
              </>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
      <TitleBar title="Remix app template">
        <button variant="primary" onClick={generateProduct}>
          Generate a product
        </button>
      </TitleBar>
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Congrats on creating a new Shopify app 🎉
                  </Text>
                  <Text variant="bodyMd" as="p">
                    This embedded app template uses{" "}
                    <Link
                      url="https://shopify.dev/docs/apps/tools/app-bridge"
                      target="_blank"
                      removeUnderline
                    >
                      App Bridge
                    </Link>{" "}
                    interface examples like an{" "}
                    <Link url="/app/additional" removeUnderline>
                      additional page in the app nav
                    </Link>
                    , as well as an{" "}
                    <Link
                      url="https://shopify.dev/docs/api/admin-graphql"
                      target="_blank"
                      removeUnderline
                    >
                      Admin GraphQL
                    </Link>{" "}
                    mutation demo, to provide a starting point for app
                    development.
                  </Text>
                </BlockStack>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Get started with products
                  </Text>
                  <Text as="p" variant="bodyMd">
                    Generate a product with GraphQL and get the JSON output for
                    that product. Learn more about the{" "}
                    <Link
                      url="https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate"
                      target="_blank"
                      removeUnderline
                    >
                      productCreate
                    </Link>{" "}
                    mutation in our API references.
                  </Text>
                </BlockStack>
                <InlineStack gap="300">
                  <Button loading={isLoading} onClick={generateProduct}>
                    Generate a product
                  </Button>
                  {fetcher.data?.product && (
                    <Button
                      url={`shopify:admin/products/${productId}`}
                      target="_blank"
                      variant="plain"
                    >
                      View product
                    </Button>
                  )}
                </InlineStack>
                {fetcher.data?.product && (
                  <>
                    <Text as="h3" variant="headingMd">
                      {" "}
                      productCreate mutation
                    </Text>
                    <Box
                      padding="400"
                      background="bg-surface-active"
                      borderWidth="025"
                      borderRadius="200"
                      borderColor="border"
                      overflowX="scroll"
                    >
                      <pre style={{ margin: 0 }}>
                        <code>
                          {JSON.stringify(fetcher.data.product, null, 2)}
                        </code>
                      </pre>
                    </Box>
                    <Text as="h3" variant="headingMd">
                      {" "}
                      productVariantsBulkUpdate mutation
                    </Text>
                    <Box
                      padding="400"
                      background="bg-surface-active"
                      borderWidth="025"
                      borderRadius="200"
                      borderColor="border"
                      overflowX="scroll"
                    >
                      <pre style={{ margin: 0 }}>
                        <code>
                          {JSON.stringify(fetcher.data.variant, null, 2)}
                        </code>
                      </pre>
                    </Box>
                  </>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    App template specs
                  </Text>
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Framework
                      </Text>
                      <Link
                        url="https://remix.run"
                        target="_blank"
                        removeUnderline
                      >
                        Remix
                      </Link>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Database
                      </Text>
                      <Link
                        url="https://www.prisma.io/"
                        target="_blank"
                        removeUnderline
                      >
                        Prisma
                      </Link>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        Interface
                      </Text>
                      <span>
                        <Link
                          url="https://polaris.shopify.com"
                          target="_blank"
                          removeUnderline
                        >
                          Polaris
                        </Link>
                        {", "}
                        <Link
                          url="https://shopify.dev/docs/apps/tools/app-bridge"
                          target="_blank"
                          removeUnderline
                        >
                          App Bridge
                        </Link>
                      </span>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" variant="bodyMd">
                        API
                      </Text>
                      <Link
                        url="https://shopify.dev/docs/api/admin-graphql"
                        target="_blank"
                        removeUnderline
                      >
                        GraphQL API
                      </Link>
                    </InlineStack>
                  </BlockStack>
                </BlockStack>
              </Card>
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Next steps
                  </Text>
                  <List>
                    <List.Item>
                      Build an{" "}
                      <Link
                        url="https://shopify.dev/docs/apps/getting-started/build-app-example"
                        target="_blank"
                        removeUnderline
                      >
                        {" "}
                        example app
                      </Link>{" "}
                      to get started
                    </List.Item>
                    <List.Item>
                      Explore Shopify’s API with{" "}
                      <Link
                        url="https://shopify.dev/docs/apps/tools/graphiql-admin-api"
                        target="_blank"
                        removeUnderline
                      >
                        GraphiQL
                      </Link>
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
