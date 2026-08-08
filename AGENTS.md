# Working on ecomwithai

Orientation for an agent or contributor arriving cold. `README.md` covers what
it does; this covers how to change it without breaking things.

## Layout

```
src/db/         client, schema (as a TS string so it applies anywhere)
src/stores/     tenant resolution and per-store settings
src/catalog/    products, options, variants, media, metafields
src/customers/  identity and lifetime totals
src/orders/     order creation, stock safety, idempotency
src/marketing/  Meta Conversions API and advanced-matching hashing
src/agent/      tool definitions, validation, MCP server
src/testing.ts  fixtures for tests and demos
```

```sh
npm test        # everything, offline
```

## Rules

**No framework imports, no `process.env`, no host APIs in `src/` outside
`agent/mcp-stdio.ts`.** Configuration is injected. This is what lets the package
run on Workers, Node, Deno and Bun unchanged, and it is easy to break without
noticing.

**Everything is behind an interface.** Add a module as
`create<Name>Service({ db, storeId, ... })` returning an interface, then compose
it in `createCommerce()`. Callers depend on the interface so an implementation
can later move behind a network boundary.

**Every query filters by `store_id`.** A missing filter is a cross-tenant data
leak, not a display bug. Extend `src/commerce.test.ts` when you add a module.

## Invariants — breaking these is a bug, not a refactor

- Prices are re-read server-side. Never trust a price from a caller.
- Stock decrements stay guarded (`where stock >= ?` inside a transaction) and
  duplicate cart lines are merged before the check.
- The customer row is created inside the order transaction.
- `idempotencyKey` returns the existing order rather than creating a second one,
  including when a concurrent call wins the unique constraint.
- Agent tool arguments are validated before reaching the domain, and writes stay
  off unless `allowWrites` is set.

## Gotchas

**`:memory:` is not safe with libSQL transactions.** A transaction gets its own
connection, which for `:memory:` is a different database — the schema vanishes
mid-test with a baffling "no such table". `createTestDb` rejects it. Use a
`file:` URL.

**Local SQLite errors instead of waiting.** Default `busy_timeout` is 0 and the
journal mode is `delete`, so concurrent writers get `SQLITE_BUSY` immediately.
`applySchema` sets WAL and a timeout; `configureConnection` must be called per
client. Standalone writes are wrapped in `withBusyRetry`. When adding a write
path, wrap it — but never retry a statement *inside* someone else's transaction,
which is why `customers.upsert` only retries when the executor is the client.

**No parameter properties, enums or namespaces.** The package ships TypeScript
source and Node's type stripping rejects that syntax. `CheckoutError` assigns
its fields explicitly for this reason.

**stdout belongs to the MCP protocol.** In `agent/mcp-stdio.ts`, diagnostics go
to stderr or they corrupt the JSON-RPC stream.

**Tool failures are results, not exceptions.** `tools/call` returns `isError`
with a readable message so the model can correct itself; a JSON-RPC error means
the transport failed, which is different.

## Conventions

Tabs, single quotes. Comments explain *why* — several record constraints that
are invisible in the code. Verify with `npm test` before claiming done.
