import { withBusyRetry, type Client } from '../db/index.ts';
import type { InValue } from '@libsql/client';
import type { CatalogService } from '../catalog/index.ts';
import { normalizeEmail, type CustomerService } from '../customers/index.ts';
import { DEFAULT_SHIPPING_RATES, resolveShippingCents, type ShippingRate } from '../shipping.ts';

export type CartLine = { variantId: number; quantity: number };

export type ShippingDetails = {
	email: string;
	phone?: string;
	firstName: string;
	lastName: string;
	address1: string;
	address2?: string;
	city: string;
	province?: string;
	postalCode: string;
	country: string;
};

export type CreateOrderInput = {
	lines: CartLine[];
	shipping: ShippingDetails;
	/** Must match a configured shipping rate id. */
	method: string;
	locale?: string;
	marketingConsent?: boolean;
	/**
	 * Supply a stable key to make retries safe. A second call with the same key
	 * returns the original order instead of charging stock twice — the single
	 * most important guard when an autonomous agent is placing the order.
	 */
	idempotencyKey?: string;
};

export type OrderItem = {
	sku: string;
	title: string;
	options: (string | null)[];
	quantity: number;
	unitPriceCents: number;
};

export type Order = {
	orderNumber: string;
	customerId: number | null;
	email: string;
	status: string;
	subtotalCents: number;
	shippingCents: number;
	totalCents: number;
	currency: string;
	items: OrderItem[];
	createdAt?: string;
	/** True when an existing order was returned via the idempotency key. */
	deduplicated?: boolean;
};

export type CheckoutErrorCode =
	| 'cart_empty'
	| 'variant_unavailable'
	| 'insufficient_stock'
	| 'unknown_shipping_method'
	| 'quantity_invalid';

export class CheckoutError extends Error {
	// Assigned explicitly rather than via constructor parameter properties: this
	// package ships as source and Node's type stripping rejects that syntax.
	readonly code: CheckoutErrorCode;
	readonly detail?: string;

	constructor(code: CheckoutErrorCode, detail?: string) {
		super(detail ? `${code}: ${detail}` : code);
		this.name = 'CheckoutError';
		this.code = code;
		this.detail = detail;
	}
}

export interface OrderService {
	create(input: CreateOrderInput): Promise<Order>;
	byNumber(orderNumber: string): Promise<Order | null>;
	list(opts?: { limit?: number; offset?: number; email?: string }): Promise<Order[]>;
	setStatus(orderNumber: string, status: string): Promise<boolean>;
}

const MAX_QUANTITY = 1000;

export function createOrderService(deps: {
	db: Client;
	storeId: string;
	currency: string;
	catalog: CatalogService;
	customers: CustomerService;
	defaultLocale?: string;
	shippingRates?: ShippingRate[];
	/** Injected so tests can produce deterministic order numbers. */
	orderNumber?: () => string;
	orderNumberPrefix?: string;
}): OrderService {
	const { db, storeId, currency, catalog, customers } = deps;
	const rates = deps.shippingRates ?? DEFAULT_SHIPPING_RATES;
	const prefix = deps.orderNumberPrefix ?? 'ORD';
	const nextOrderNumber =
		deps.orderNumber ??
		(() => `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`);

	async function loadOrder(where: string, args: InValue[]): Promise<Order | null> {
		const result = await db.execute({
			sql: `select id, order_number, customer_id, email, status, subtotal_cents,
			             shipping_cents, total_cents, currency, created_at
			      from orders where store_id = ? and ${where}`,
			args: [storeId, ...args]
		});
		const row = result.rows[0];
		if (!row) return null;

		const items = await db.execute({
			sql: `select sku, title, option1, option2, option3, quantity, unit_price_cents
			      from order_items where store_id = ? and order_id = ? order by id`,
			args: [storeId, Number(row.id)]
		});

		return {
			orderNumber: String(row.order_number),
			customerId: row.customer_id === null ? null : Number(row.customer_id),
			email: String(row.email),
			status: String(row.status),
			subtotalCents: Number(row.subtotal_cents),
			shippingCents: Number(row.shipping_cents),
			totalCents: Number(row.total_cents),
			currency: String(row.currency),
			createdAt: String(row.created_at),
			items: items.rows.map((i) => ({
				sku: String(i.sku),
				title: String(i.title),
				options: [i.option1, i.option2, i.option3].map((o) =>
					o === null || o === undefined ? null : String(o)
				),
				quantity: Number(i.quantity),
				unitPriceCents: Number(i.unit_price_cents)
			}))
		};
	}

	return {
		async create(input) {
			// Input problems fail immediately — only contention is worth retrying.
			for (const line of input.lines) {
				if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) {
					throw new CheckoutError('quantity_invalid', String(line.quantity));
				}
			}
			if (input.lines.length === 0) throw new CheckoutError('cart_empty');

			const shippingCents = resolveShippingCents(rates, input.method);
			if (shippingCents === null) {
				throw new CheckoutError('unknown_shipping_method', input.method);
			}

			// Stored normalized so `list({ email })` and the customer record agree.
			const email = normalizeEmail(input.shipping.email);
			const locale = input.locale ?? deps.defaultLocale ?? 'en';

			// Merge duplicate lines so the stock guard sees the true total; two lines
			// of the same variant would otherwise each pass a check for one.
			const merged = new Map<number, number>();
			for (const line of input.lines) {
				merged.set(line.variantId, (merged.get(line.variantId) ?? 0) + line.quantity);
			}

			// SQLite serializes writers and hands the losers SQLITE_BUSY. Concurrent
			// checkouts are ordinary traffic, so retry rather than surface a lock
			// error. Re-checking the idempotency key on each attempt keeps it safe.
			return withBusyRetry(async () => {
				if (input.idempotencyKey) {
					const existing = await loadOrder('idempotency_key = ?', [input.idempotencyKey]);
					if (existing) return { ...existing, deduplicated: true };
				}

				const priced = await catalog.priceVariants([...merged.keys()]);

				let subtotalCents = 0;
				const resolved = [...merged.entries()].map(([variantId, quantity]) => {
					const variant = priced.get(variantId);
					if (!variant) throw new CheckoutError('variant_unavailable', String(variantId));
					subtotalCents += variant.unitPriceCents * quantity;
					return { ...variant, quantity };
				});

				const totalCents = subtotalCents + shippingCents;
				const orderNumber = nextOrderNumber();

				const tx = await db.transaction('write');
				try {
					// Guarded decrement: if another order took the last unit between
					// pricing and here, rowsAffected is 0 and we fail rather than oversell.
					for (const item of resolved) {
						const result = await tx.execute({
							sql: `update product_variants set stock = stock - ?
							      where id = ? and store_id = ? and stock >= ?`,
							args: [item.quantity, item.variantId, storeId, item.quantity]
						});
						if (result.rowsAffected === 0) {
							throw new CheckoutError('insufficient_stock', item.sku);
						}
					}

					const customerId = await customers.upsert(
						{
							email,
							firstName: input.shipping.firstName,
							lastName: input.shipping.lastName,
							phone: input.shipping.phone,
							marketingConsent: input.marketingConsent
						},
						tx
					);

					const inserted = await tx.execute({
						sql: `insert into orders (
						        store_id, customer_id, order_number, email, phone,
						        first_name, last_name, address1, address2, city, province,
						        postal_code, country, shipping_method, subtotal_cents,
						        shipping_cents, discount_cents, total_cents, currency, locale,
						        status, idempotency_key
						      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
						args: [
							storeId,
							customerId,
							orderNumber,
							email,
							input.shipping.phone ?? null,
							input.shipping.firstName,
							input.shipping.lastName,
							input.shipping.address1,
							input.shipping.address2 ?? null,
							input.shipping.city,
							input.shipping.province ?? null,
							input.shipping.postalCode,
							input.shipping.country,
							input.method,
							subtotalCents,
							shippingCents,
							0,
							totalCents,
							currency,
							locale,
							'pending_payment',
							input.idempotencyKey ?? null
						]
					});

					const orderId = Number(inserted.lastInsertRowid);

					for (const item of resolved) {
						await tx.execute({
							sql: `insert into order_items (
							        store_id, order_id, variant_id, product_slug, title, sku,
							        option1, option2, option3, unit_price_cents, quantity
							      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							args: [
								storeId,
								orderId,
								item.variantId,
								item.productSlug,
								item.title,
								item.sku,
								item.options[0],
								item.options[1],
								item.options[2],
								item.unitPriceCents,
								item.quantity
							]
						});
					}

					await customers.recordOrder(customerId, totalCents, tx);
					await tx.commit();

					return {
						orderNumber,
						customerId,
						email,
						status: 'pending_payment',
						subtotalCents,
						shippingCents,
						totalCents,
						currency,
						items: resolved.map((item) => ({
							sku: item.sku,
							title: item.title,
							options: item.options,
							quantity: item.quantity,
							unitPriceCents: item.unitPriceCents
						}))
					};
				} catch (error) {
					// Rolling back an already-closed transaction throws; letting that
					// escape would replace the real cause with a confusing one.
					try {
						await tx.rollback();
					} catch {
						/* already closed */
					}

					// A concurrent call with the same key won the unique constraint;
					// return its order rather than surfacing a database error.
					if (input.idempotencyKey) {
						const existing = await loadOrder('idempotency_key = ?', [input.idempotencyKey]);
						if (existing) return { ...existing, deduplicated: true };
					}
					throw error;
				}
			});
		},

		byNumber(orderNumber) {
			return loadOrder('order_number = ?', [orderNumber]);
		},

		async list(opts = {}) {
			const limit = Math.max(1, Math.min(250, Math.trunc(opts.limit ?? 50)));
			const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
			const filter = opts.email ? 'and email = ?' : '';
			const args: InValue[] = [storeId];
			if (opts.email) args.push(normalizeEmail(opts.email));
			args.push(limit, offset);

			const result = await db.execute({
				sql: `select order_number from orders
				      where store_id = ? ${filter}
				      order by created_at desc, id desc limit ? offset ?`,
				args
			});

			const orders = await Promise.all(
				result.rows.map((r) => loadOrder('order_number = ?', [String(r.order_number)]))
			);
			return orders.filter((o): o is Order => o !== null);
		},

		setStatus(orderNumber, status) {
			return withBusyRetry(async () => {
				const result = await db.execute({
					sql: `update orders set status = ? where store_id = ? and order_number = ?`,
					args: [status, storeId, orderNumber]
				});
				return result.rowsAffected > 0;
			});
		}
	};
}
