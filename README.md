# Xeno Retail — Shopify App (Multi‑Tenant)

![DB Design](public/db_design.png)

Deployable Shopify app that ingests Shopify store data to MySQL (Railway) for one or more tenants (stores).

![Remix](https://img.shields.io/badge/Remix-2.x-5c6ac4?logo=remix&logoColor=white)
![Shopify](https://img.shields.io/badge/Shopify-App-7AB55C?logo=shopify&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?logo=prisma&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-Railway-00618A?logo=mysql&logoColor=white)

---

## About this repo
See the ER diagram and DB design below for a visual overview of the schema and relationships. The image is located at `public/db_design.png`.
This repository contains the Shopify app that you install into your stores (tenants). It authenticates with Shopify, receives webhooks for ongoing updates, and supports manual historical ingestion. Data is stored in a shared MySQL database on Railway with a multi‑tenant schema.

## Labels at a glance
- **Framework:** Remix (embedded Shopify app)
- **Data:** Prisma ORM + MySQL (Railway)
- **Shopify:** App OAuth, Admin GraphQL, Webhooks

## Tech stack
- Remix 2.x + Vite dev server
- @shopify/shopify-app-remix for OAuth/session/webhooks
- Prisma ORM targeting MySQL (Railway)

## Getting started
> Prerequisites: Node 18+, Shopify Partner account, a dev store, Railway MySQL.

Install dependencies

```bash
npm install
```

Configure environment in a `.env` file

```bash
# .env
DATABASE_URL=mysql://user:password@host:port/db
```

Prepare the database

```bash
npx prisma generate
npx prisma db push
```

Run the app (dev)

```bash
shopify app dev --store your-store.myshopify.com
```

> Tip: If the preview opens too early and fails, press `p` after the server URL appears to re‑open it.

Ingest data

- Trigger manual ingestion for Products, Customers, and Orders from within the app.
- Live updates arrive via webhooks once installed.

Notes
- Multi‑tenant: When you install into another store, a new Tenant row is created automatically by domain.

## Database Design

The database schema is fully normalized and designed for multi-tenant analytics:

- **Relationships:**
  - Each `Tenant` (Shopify store) owns its own `Customers`, `Products`, `Orders`, and `Events`.
  - `Customer` and `Order` are linked, so you can track purchases per customer.
  - `Event` logs all webhook-driven activity (cart, checkout, etc.), linked to both tenant and customer.
  - Foreign keys enforce referential integrity between entities.

- **Normalization:**
  - All tables are normalized to at least 3NF (Third Normal Form): no redundant data, atomic fields, and all relationships managed via foreign keys.
  - Composite keys (e.g., `[tenantId, shopifyId]`) ensure uniqueness per store, supporting multi-tenant isolation.
  - No transitive dependencies—customer details are stored only in `Customer`, not duplicated in `Order` or `Event`.

- **Benefits for analytics:**
  - Clean joins and queries: You can easily aggregate metrics (e.g., top customers, product sales, abandoned carts) without worrying about data duplication or inconsistency.
  - Data integrity: Updates to a customer or product propagate everywhere, so insights are always accurate.
  - Scalability: Each store’s data is isolated, so you can onboard new tenants without risk of cross-store contamination.
  - Flexibility: Normalized design makes it easy to add new features (e.g., new event types, advanced segmentation) without schema rewrites.

This design enables powerful, real-time analytics and insights for any number of Shopify stores, with guaranteed data quality and performance.

## Features and webhooks
### Features
- Multi‑tenant data model keyed by store domain
- Manual historical ingestion of Products, Customers, Orders
- Live updates via Shopify webhooks

### How ingestion works
- Historical: Trigger manual ingestion in the app to pull from Shopify Admin GraphQL and persist via Prisma.
- Automatic: Webhooks for products/customers/orders create or update rows in the database on every change.

### Webhooks (examples)
- products/create, products/update
- customers/create, customers/update
- orders/create, orders/update

## Known limitations / assumptions
- Requires proper Admin API scopes (read_products, read_customers, read_orders, etc.).
- Manual ingestion currently performs full scans. For very large stores, consider adding cursored batching and/or background workers.
- Webhook processing runs in‑process. For bursty traffic, consider using a queue (Redis/RabbitMQ) and a worker.
- Always filter queries by tenantId to maintain data isolation across stores.

## Author
> Made by Dave Meshak | [Portfolio](https://iamdave.vercel.app/)

## License
GNU GENERAL PUBLIC LICENSE. See [LICENSE](./LICENSE) file for more details.

