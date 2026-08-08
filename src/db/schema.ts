/**
 * Single source of truth for the schema, kept as a string rather than a .sql
 * file so it can be applied from a Worker, a Node script or a test without
 * filesystem access.
 *
 * Two properties everything else depends on:
 *
 * 1. Multi-tenant. store_id is denormalized onto every table so each query
 *    filters by tenant without a join, and so a module lifted into its own
 *    service never needs a cross-table lookup to scope its reads. A missing
 *    filter is a data breach, not a display bug.
 *
 * 2. Product-shape agnostic. Options are generic name/value pairs, so the same
 *    schema sells t-shirts, coffee subscriptions or single-SKU hardware.
 *    Nothing here knows what a "size" is.
 */
export const SCHEMA = `
create table if not exists stores (
	id text primary key,
	domain text not null unique,
	name text not null,
	default_locale text not null default 'en',
	currency text not null default 'USD',
	active integer not null default 1,
	created_at text not null default (datetime('now'))
);

-- Free-form per-store configuration: analytics ids, feature flags, whatever the
-- host app needs. Keeps store-specific columns out of the core table.
create table if not exists store_settings (
	store_id text not null references stores (id) on delete cascade,
	key text not null,
	value text,
	primary key (store_id, key)
);

create table if not exists products (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	slug text not null,
	status text not null default 'active',
	position integer not null default 0,
	created_at text not null default (datetime('now')),
	unique (store_id, slug)
);

-- Customer-facing text lives here, one row per locale, so adding a language is
-- data rather than a schema change.
create table if not exists product_translations (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	product_id integer not null references products (id) on delete cascade,
	locale text not null,
	title text not null,
	subtitle text,
	description text,
	unique (product_id, locale)
);

-- 'Color', 'Size', 'Grind', 'Length' -- the framework does not care.
create table if not exists product_options (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	product_id integer not null references products (id) on delete cascade,
	name text not null,
	position integer not null default 0,
	unique (product_id, name)
);

create table if not exists product_option_values (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	option_id integer not null references product_options (id) on delete cascade,
	value text not null,
	label text,
	swatch_hex text,
	position integer not null default 0,
	unique (option_id, value)
);

-- option1/2/3 mirror the option rows by position. Three axes is the ceiling
-- every major platform settled on, and it keeps variant lookup a single query.
create table if not exists product_variants (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	product_id integer not null references products (id) on delete cascade,
	sku text not null,
	price_cents integer not null,
	compare_at_cents integer,
	stock integer not null default 0,
	position integer not null default 0,
	option1 text,
	option2 text,
	option3 text,
	unique (store_id, sku),
	unique (product_id, option1, option2, option3)
);

create table if not exists product_media (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	product_id integer not null references products (id) on delete cascade,
	url text not null,
	alt text,
	position integer not null default 0,
	-- When set, this image represents that option value (a colour swatch photo).
	option_value_id integer references product_option_values (id) on delete set null
);

-- Structured extras the core does not model: size charts, care instructions,
-- FAQ blocks. A null locale means it applies to every locale.
create table if not exists product_metafields (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	product_id integer not null references products (id) on delete cascade,
	namespace text not null,
	key text not null,
	locale text,
	value_json text not null,
	unique (product_id, namespace, key, locale)
);

create table if not exists customers (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	email text not null,
	first_name text,
	last_name text,
	phone text,
	marketing_consent integer not null default 0,
	orders_count integer not null default 0,
	total_spent_cents integer not null default 0,
	created_at text not null default (datetime('now')),
	updated_at text not null default (datetime('now')),
	unique (store_id, email)
);

create table if not exists orders (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	customer_id integer references customers (id) on delete set null,
	order_number text not null unique,
	email text not null,
	phone text,
	first_name text not null,
	last_name text not null,
	address1 text not null,
	address2 text,
	city text not null,
	province text,
	postal_code text not null,
	country text not null,
	shipping_method text not null,
	subtotal_cents integer not null,
	shipping_cents integer not null,
	discount_cents integer not null default 0,
	total_cents integer not null,
	currency text not null default 'USD',
	locale text not null default 'en',
	status text not null default 'pending_payment',
	-- Set by the caller to make order creation safely retryable.
	idempotency_key text,
	created_at text not null default (datetime('now')),
	unique (store_id, idempotency_key)
);

create table if not exists order_items (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	order_id integer not null references orders (id) on delete cascade,
	variant_id integer not null references product_variants (id),
	product_slug text not null,
	title text not null,
	sku text not null,
	option1 text,
	option2 text,
	option3 text,
	unit_price_cents integer not null,
	quantity integer not null
);

-- One row per payment attempt against an order. Provider-neutral: 'stripe' is
-- the first implementation, not an assumption baked into the schema.
create table if not exists payments (
	id integer primary key autoincrement,
	store_id text not null references stores (id) on delete cascade,
	order_id integer not null references orders (id) on delete cascade,
	provider text not null default 'stripe',
	-- The provider's object id (a Checkout Session or PaymentIntent).
	provider_ref text,
	status text not null default 'pending',
	amount_cents integer not null,
	currency text not null,
	failure_reason text,
	created_at text not null default (datetime('now')),
	updated_at text not null default (datetime('now')),
	unique (provider, provider_ref)
);

-- Webhook idempotency. Providers retry aggressively and will redeliver an event
-- days later; the unique constraint is what stops an order being paid twice or
-- restocked twice.
create table if not exists payment_events (
	id integer primary key autoincrement,
	provider text not null,
	event_id text not null,
	type text not null,
	store_id text,
	received_at text not null default (datetime('now')),
	unique (provider, event_id)
);

create index if not exists idx_payments_order on payments (order_id);
create index if not exists idx_payments_store on payments (store_id, status);

create index if not exists idx_products_store on products (store_id, slug);
create index if not exists idx_translations_product on product_translations (product_id, locale);
create index if not exists idx_options_product on product_options (product_id);
create index if not exists idx_option_values_option on product_option_values (option_id);
create index if not exists idx_variants_product on product_variants (product_id);
create index if not exists idx_media_product on product_media (product_id);
create index if not exists idx_metafields_product on product_metafields (product_id);
create index if not exists idx_customers_store_email on customers (store_id, email);
create index if not exists idx_orders_store_created on orders (store_id, created_at);
create index if not exists idx_orders_customer on orders (customer_id);
create index if not exists idx_order_items_order on order_items (order_id);
`;
