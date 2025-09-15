# Xeno Retail — Shopify App (Multi‑Tenant)

Deployable Shopify app that ingests Shopify store data to MySQL (Railway) for one or more tenants (stores).

![Remix](https://img.shields.io/badge/Remix-2.x-5c6ac4?logo=remix&logoColor=white)
![Shopify](https://img.shields.io/badge/Shopify-App-7AB55C?logo=shopify&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?logo=prisma&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-Railway-00618A?logo=mysql&logoColor=white)

---

## About this repo
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
- Dave Meshak | [Portfolio](https://iamdave.vercel.app/)

## License
MIT — feel free to use and adapt. See LICENSE file if present.

