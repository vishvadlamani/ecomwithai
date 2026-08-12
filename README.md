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

> Early and honest about it: the domain and payments are tested, but there is no
> tax engine or admin UI yet. See [Status](#status).

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
`get_order`, `list_orders`, `set_order_status`, `find_customer`,
`start_checkout`, `get_payment`, `refund_order`, `adjust_stock`.

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

## Payments

Stripe, over the REST API — no SDK, so it runs on Workers like everything else.
**No card details ever reach your servers**: `startCheckout` returns a Stripe
hosted page and the order only becomes `paid` when a signed webhook says so.

```ts
const commerce = createCommerce({
  db, store,
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    // Set this whenever the Stripe account isn't named after the store the
    // buyer thinks they bought from. An unrecognised line on a card statement
    // is one of the most common causes of a chargeback, and the customer
    // disputing it is behaving reasonably.
    statementDescriptorSuffix: 'COTTONTEE'
  }
});

// Hosted: Stripe's own page.
const { url } = await commerce.payments.startCheckout({
  orderNumber: order.orderNumber,
  successUrl: 'https://example.com/thanks',
  cancelUrl: 'https://example.com/cart'
});

// Embedded: the form mounts on your page instead. Same PCI position — the
// card is still entered in a Stripe-owned iframe — but the customer never
// leaves the site, which is where redirects lose people.
const { clientSecret } = await commerce.payments.startCheckout({
  orderNumber: order.orderNumber,
  uiMode: 'embedded',
  returnUrl: 'https://example.com/thanks'
});
```

**A discounted order carries a coupon.** Line items sum to subtotal plus
shipping, and the webhook asserts the session total equals the order total — so
an order with a `quantityBreaks` discount and no coupon is charged the *full*
amount and then refused as a mismatch. `startCheckout` creates a single-use
coupon for exactly `order.discountCents`, which closes the gap with no rounding
to spread across lines.

Webhook endpoint — pass the **raw** body, never a re-serialized object:

```ts
const raw = await request.text();
const result = await commerce.payments.handleWebhook(
  raw,
  request.headers.get('stripe-signature')
);
return new Response(null, { status: result.handled ? 200 : 202 });
```

Return 2xx even when the event is ignored or duplicate, or Stripe will retry it
forever. Reserve non-2xx for genuine processing failures you want redelivered.

### What the webhook path guarantees

**Signatures are verified** with HMAC-SHA256, a constant-time comparison and a
five-minute freshness window. Anyone can POST to a webhook URL; a handler that
trusts the body is a free-money bug.

**Amounts are asserted, not assumed.** An event that settles for less than the
order total, or in a different currency, is recorded as `amount_mismatch` and
the order stays unpaid.

**Events apply exactly once.** The event id is inserted in the same transaction
as the state change, so redelivery — which Stripe does aggressively, sometimes
days later — is a no-op, and concurrent deliveries collapse to one.

**Abandoned checkouts return stock.** Stock is reserved when the order is
created, so `checkout.session.expired` gives it back and cancels the order. An
expiry arriving *after* payment is ignored rather than inflating inventory. A
refund restocks too, configurable via `restockOnRefund`.

**Tenancy is checked separately from authenticity.** A valid signature proves
Stripe sent the event, not that it belongs to this store. Events carry
`store_id` metadata; use `peekStripeEvent()` to route before handling.

Still missing: tax. Use Stripe Tax rather than building it.

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
safety; Stripe payments with verified webhooks, refunds and stock release;
multi-tenancy; the agent toolkit and MCP server; Meta Conversions API with
browser/server event deduplication.

Not built yet: tax, an admin UI, transactional email, returns handling beyond
refunds, and providers other than Stripe.

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
npm run typecheck
npm test
```

Both run in CI on Node 22 and 24. Tests are offline: no network, no keys, no
fixtures to maintain. Use a `file:` URL for test
databases, never `:memory:` — libSQL gives a transaction its own connection, and
with `:memory:` that is a different database, so your schema vanishes the moment
anything commits.

## Licence

Apache-2.0. Permissive like MIT, with an explicit patent grant — which
matters for a package you are putting in a checkout path.
