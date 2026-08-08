# ecomwithai

Headless commerce for the edge, built so **AI agents are first-class clients**.

Products, variants, customers and orders behind clean interfaces, plus a Model
Context Protocol server so an agent can browse a catalogue and place an order
without a browser, a scraper, or a Shopify subscription.

- **Runs anywhere** — Cloudflare Workers, Node, Deno, Bun. One dependency
  (`@libsql/client`), no framework, no `process.env` reads.
- **Multi-tenant from the first row** — one deployment serves many stores.
- **Agent-safe by construction** — schema-validated tool arguments, read-only by
  default, idempotent order creation.

> Early and honest about it: the domain is solid and tested, but there is no
> payment provider, tax engine or admin UI yet. See [Status](#status).

## Install

```sh
npm install ecomwithai
```

Ships TypeScript source. Node 22.6+ runs it directly with
`--experimental-strip-types`; bundlers transpile it like any other source.

## Quick start

```ts
import { applySchema, createCommerce, createDirectory } from 'ecomwithai';

const { db, stores } = createDirectory({ url: 'file:store.db' });
await applySchema(db);           // also enables WAL + busy_timeout

const store = await stores.byDomain('example.com');
const commerce = createCommerce({ db, store });

const product = await commerce.catalog.getProduct('cotton-tee');

const order = await commerce.orders.create({
  lines: [{ variantId: product.variants[0].id, quantity: 2 }],
  method: 'standard',
  shipping: {
    email: 'buyer@example.com',
    firstName: 'Sam', lastName: 'Doe',
    address1: '1 Main St', city: 'Lisbon',
    postalCode: '1100', country: 'PT'
  },
  idempotencyKey: 'checkout-session-abc'
});
```

## Agents

Wrap a store as tools and hand them to any agent:

```ts
import { createAgentToolkit } from 'ecomwithai/agent';

const toolkit = createAgentToolkit(commerce);            // read-only
const writable = createAgentToolkit(commerce, { allowWrites: true });

toolkit.list();                                          // JSON Schema per tool
await toolkit.call('get_product', { slug: 'cotton-tee' });
```

Tools: `list_products`, `get_product`, `find_variant`, `create_order`,
`get_order`, `list_orders`, `set_order_status`, `find_customer`, `adjust_stock`.

### MCP

Over stdio, for desktop AI clients:

```jsonc
{
  "mcpServers": {
    "my-store": {
      "command": "node",
      "args": ["--experimental-strip-types",
               "node_modules/ecomwithai/src/agent/mcp-stdio.ts"],
      "env": {
        "ECOMWITHAI_DATABASE_URL": "file:store.db",
        "ECOMWITHAI_STORE_ID": "my-store",
        "ECOMWITHAI_ALLOW_WRITES": "1"
      }
    }
  }
}
```

Or over HTTP, for remote agents — drop straight into a Worker:

```ts
import { createAgentToolkit } from 'ecomwithai/agent';
import { createMcpFetchHandler, createMcpHandler } from 'ecomwithai/agent/mcp';

const mcp = createMcpFetchHandler(createMcpHandler(createAgentToolkit(commerce)));
export default { fetch: (req) => mcp(req) };
```

### What makes it agent-safe

**Writes are off by default.** `createAgentToolkit(commerce)` exposes browsing
only. Placing orders and moving stock is an explicit opt-in.

**Arguments are validated before they reach the domain.** Tool input is model
output — it arrives well-formed *most* of the time. Quantities of `-3`, `"2"`
where `2` was meant, invented parameters and wrong types are all handled at the
boundary. Unknown fields are dropped rather than rejected, because failing a
whole call over one hallucinated key helps nobody.

**Order creation is idempotent.** Pass `idempotencyKey` and a retry returns the
original order instead of ordering twice. Agents retry; this is the difference
between a resilient integration and a double charge.

**Failures come back as values, not exceptions**, with messages written to be
read by a model: `insufficient_stock (TEE-M) — order not created, nothing was
charged`.

## Design

**Interfaces, not implementations.** `CatalogService`, `CustomerService`,
`OrderService`, `StoreService` each have a local in-process implementation.
Moving one behind a network boundary means writing a second implementation and
swapping it at `createCommerce()` — no call site changes.

**Configuration is injected.** Nothing reads `process.env` or imports a
framework, because a Worker, a Node process and a test read their environment
differently.

**Product-shape agnostic.** Options are generic name/value pairs with up to
three axes, so the same schema sells t-shirts, coffee subscriptions or
single-SKU hardware. Nothing in the core knows what a "size" is. Structured
extras — size charts, care instructions, FAQ blocks — live in metafields.

**Multi-tenant.** `store_id` is denormalized onto every table so each query
filters by tenant without a join. `src/commerce.test.ts` pins the isolation
guarantees: a store cannot read, price or order another's variants, and the
same email is a separate customer per store.

### Invariants

- **Prices are never trusted from a client.** `catalog.priceVariants()` re-reads
  them server-side; anything a caller sends for price is ignored.
- **Stock decrements are guarded.** `update ... where stock >= ?` inside a
  transaction, failing when `rowsAffected` is 0. Duplicate lines for the same
  variant are merged first, or each would pass a check for its own quantity and
  together oversell.
- **The customer row is created inside the order transaction.** No customer
  survives an order that rolls back.

## Status

Working: catalog with generic options, variants, media, metafields and
translations; customers with lifetime totals; orders with idempotency and stock
safety; multi-tenancy; the agent toolkit and MCP server; Meta Conversions API
with browser/server event deduplication.

Not built yet: payments (orders are written `pending_payment` and **no card
details are collected anywhere**), tax, an admin UI, transactional email,
refunds and returns.

## Concurrency

Local SQLite ships with `journal_mode=delete` and `busy_timeout=0`, so a second
writer fails instantly with `SQLITE_BUSY` rather than waiting — and two people
checking out at the same moment is ordinary traffic, not an exceptional
condition. `applySchema()` turns on WAL (a persistent property of the file) and
sets a busy timeout. Because the timeout is per-connection, call
`configureConnection(db)` once on every client you create:

```ts
import { configureConnection, createDirectory } from 'ecomwithai';

const { db, stores } = createDirectory({ url: 'file:store.db' });
await configureConnection(db);
```

Writes also retry on contention with jittered backoff. Domain failures are never
retried — only lock contention. Against remote Turso both are no-ops, since it
handles concurrency server-side.

## Testing

```sh
npm test
```

Offline, no network, no fixtures to maintain. Use a `file:` URL for test
databases, never `:memory:` — libSQL gives a transaction its own connection, and
with `:memory:` that is a different database, so your schema vanishes the moment
anything commits.

## Licence

Apache-2.0. Permissive like MIT, with an explicit patent grant — which
matters for a package you are putting in a checkout path.
