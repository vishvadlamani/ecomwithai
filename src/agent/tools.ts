import type { Commerce } from '../index.ts';
import { CheckoutError } from '../orders/index.ts';
import type { JsonSchema } from './validate.ts';

export type ToolDefinition = {
	name: string;
	title: string;
	description: string;
	/** Read-only tools can be exposed to an agent without write permission. */
	readOnly: boolean;
	inputSchema: JsonSchema;
	handler: (commerce: Commerce, args: Record<string, unknown>) => Promise<unknown>;
};

const ADDRESS: Record<string, JsonSchema> = {
	email: { type: 'string', description: 'Customer email address.', maxLength: 320 },
	firstName: { type: 'string', maxLength: 100 },
	lastName: { type: 'string', maxLength: 100 },
	address1: { type: 'string', maxLength: 200 },
	address2: { type: 'string', maxLength: 200 },
	city: { type: 'string', maxLength: 100 },
	province: { type: 'string', maxLength: 100 },
	postalCode: { type: 'string', maxLength: 32 },
	country: {
		type: 'string',
		description: 'ISO 3166-1 alpha-2 country code, e.g. "US".',
		minLength: 2,
		maxLength: 2
	},
	phone: { type: 'string', maxLength: 32 }
};

export const TOOLS: ToolDefinition[] = [
	{
		name: 'list_products',
		title: 'List products',
		description:
			'List active products in the store with their price, image and stock status. Use this to discover what is for sale before looking up details.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			properties: {
				locale: { type: 'string', description: 'BCP-47 locale, e.g. "en".', maxLength: 16 },
				limit: { type: 'integer', minimum: 1, maximum: 250, default: 50 },
				offset: { type: 'integer', minimum: 0, default: 0 }
			}
		},
		handler: (c, a) =>
			c.catalog.listProducts({
				locale: a.locale as string | undefined,
				limit: a.limit as number,
				offset: a.offset as number
			})
	},

	{
		name: 'get_product',
		title: 'Get product',
		description:
			'Full detail for one product: options (such as size or colour), every variant with its own price and stock, media and metafields. Call this before creating an order so you can pick a real variant id.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			required: ['slug'],
			properties: {
				slug: { type: 'string', description: 'Product slug.', maxLength: 200 },
				locale: { type: 'string', maxLength: 16 }
			}
		},
		handler: async (c, a) => {
			const product = await c.catalog.getProduct(a.slug as string, a.locale as string | undefined);
			if (!product) throw new Error(`No product with slug "${a.slug}"`);
			return product;
		}
	},

	{
		name: 'find_variant',
		title: 'Find variant by options',
		description:
			'Resolve a specific variant from its option values, given in the same order as the product options. Returns the variant id needed to place an order.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			required: ['slug', 'options'],
			properties: {
				slug: { type: 'string', maxLength: 200 },
				options: {
					type: 'array',
					description: 'Option values in product option order, e.g. ["Blue", "M"].',
					maxItems: 3,
					items: { type: 'string', maxLength: 100 }
				}
			}
		},
		handler: async (c, a) => {
			const product = await c.catalog.getProduct(a.slug as string);
			if (!product) throw new Error(`No product with slug "${a.slug}"`);
			const variant = await c.catalog.findVariant(product.id, a.options as string[]);
			if (!variant) {
				throw new Error(
					`No variant of "${a.slug}" with options [${(a.options as string[]).join(', ')}]`
				);
			}
			return variant;
		}
	},

	{
		name: 'create_order',
		title: 'Create order',
		description:
			'Place an order. Prices and stock are re-checked server-side; anything you pass for price is ignored. Always supply idempotencyKey — retrying with the same key returns the original order instead of ordering twice.',
		readOnly: false,
		inputSchema: {
			type: 'object',
			required: ['lines', 'shipping', 'method'],
			properties: {
				lines: {
					type: 'array',
					minItems: 1,
					maxItems: 100,
					items: {
						type: 'object',
						required: ['variantId', 'quantity'],
						properties: {
							variantId: { type: 'integer', minimum: 1 },
							quantity: { type: 'integer', minimum: 1, maximum: 1000 }
						}
					}
				},
				shipping: {
					type: 'object',
					required: [
						'email',
						'firstName',
						'lastName',
						'address1',
						'city',
						'postalCode',
						'country'
					],
					properties: ADDRESS
				},
				method: { type: 'string', description: 'Shipping rate id.', maxLength: 64 },
				locale: { type: 'string', maxLength: 16 },
				marketingConsent: { type: 'boolean', default: false },
				idempotencyKey: {
					type: 'string',
					description: 'Stable key making retries safe. Strongly recommended.',
					maxLength: 200
				}
			}
		},
		handler: async (c, a) => {
			try {
				return await c.orders.create({
					lines: a.lines as { variantId: number; quantity: number }[],
					shipping: a.shipping as never,
					method: a.method as string,
					locale: a.locale as string | undefined,
					marketingConsent: a.marketingConsent as boolean,
					idempotencyKey: a.idempotencyKey as string | undefined
				});
			} catch (error) {
				// Turn domain failures into something an agent can act on rather than
				// an opaque stack trace.
				if (error instanceof CheckoutError) {
					throw new Error(
						`${error.code}${error.detail ? ` (${error.detail})` : ''} — order not created, nothing was charged`
					);
				}
				throw error;
			}
		}
	},

	{
		name: 'get_order',
		title: 'Get order',
		description: 'Look up one order by its order number, including line items.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			required: ['orderNumber'],
			properties: { orderNumber: { type: 'string', maxLength: 64 } }
		},
		handler: async (c, a) => {
			const order = await c.orders.byNumber(a.orderNumber as string);
			if (!order) throw new Error(`No order "${a.orderNumber}"`);
			return order;
		}
	},

	{
		name: 'list_orders',
		title: 'List orders',
		description: 'Recent orders, newest first, optionally filtered to one customer email.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			properties: {
				email: { type: 'string', maxLength: 320 },
				limit: { type: 'integer', minimum: 1, maximum: 250, default: 20 },
				offset: { type: 'integer', minimum: 0, default: 0 }
			}
		},
		handler: (c, a) =>
			c.orders.list({
				email: a.email as string | undefined,
				limit: a.limit as number,
				offset: a.offset as number
			})
	},

	{
		name: 'set_order_status',
		title: 'Set order status',
		description:
			'Move an order to a new status, e.g. paid, fulfilled, cancelled. Does not move money.',
		readOnly: false,
		inputSchema: {
			type: 'object',
			required: ['orderNumber', 'status'],
			properties: {
				orderNumber: { type: 'string', maxLength: 64 },
				status: {
					type: 'string',
					enum: ['pending_payment', 'paid', 'fulfilled', 'cancelled', 'refunded']
				}
			}
		},
		handler: async (c, a) => {
			const ok = await c.orders.setStatus(a.orderNumber as string, a.status as string);
			if (!ok) throw new Error(`No order "${a.orderNumber}"`);
			return { orderNumber: a.orderNumber, status: a.status };
		}
	},

	{
		name: 'find_customer',
		title: 'Find customer',
		description:
			'Look up a customer by email, with lifetime order count and spend. Returns null when unknown.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			required: ['email'],
			properties: { email: { type: 'string', maxLength: 320 } }
		},
		handler: (c, a) => c.customers.byEmail(a.email as string)
	},

	{
		name: 'start_checkout',
		title: 'Start checkout',
		description:
			'Create a hosted payment page for an existing order and return its URL. Card details are collected by the payment provider, never by this store. Give the URL to the customer; the order is only marked paid once the provider confirms it.',
		readOnly: false,
		inputSchema: {
			type: 'object',
			required: ['orderNumber', 'successUrl', 'cancelUrl'],
			properties: {
				orderNumber: { type: 'string', maxLength: 64 },
				successUrl: { type: 'string', maxLength: 2000 },
				cancelUrl: { type: 'string', maxLength: 2000 }
			}
		},
		handler: async (c, a) => {
			if (!c.payments) throw new Error('No payment provider is configured for this store');
			return c.payments.startCheckout({
				orderNumber: a.orderNumber as string,
				successUrl: a.successUrl as string,
				cancelUrl: a.cancelUrl as string
			});
		}
	},

	{
		name: 'get_payment',
		title: 'Get payment status',
		description:
			'Payment state for an order: pending, succeeded, failed, expired, refunded, or amount_mismatch. Returns null when checkout has not started.',
		readOnly: true,
		inputSchema: {
			type: 'object',
			required: ['orderNumber'],
			properties: { orderNumber: { type: 'string', maxLength: 64 } }
		},
		handler: async (c, a) => {
			if (!c.payments) throw new Error('No payment provider is configured for this store');
			return c.payments.byOrderNumber(a.orderNumber as string);
		}
	},

	{
		name: 'refund_order',
		title: 'Refund an order',
		description:
			'Refund a paid order, fully or partially. This moves real money — only call it when a human has asked for this specific refund. Omit amountCents for a full refund.',
		readOnly: false,
		inputSchema: {
			type: 'object',
			required: ['orderNumber'],
			properties: {
				orderNumber: { type: 'string', maxLength: 64 },
				amountCents: { type: 'integer', minimum: 1 },
				reason: {
					type: 'string',
					enum: ['duplicate', 'fraudulent', 'requested_by_customer']
				}
			}
		},
		handler: async (c, a) => {
			if (!c.payments) throw new Error('No payment provider is configured for this store');
			return c.payments.refund({
				orderNumber: a.orderNumber as string,
				amountCents: a.amountCents as number | undefined,
				reason: a.reason as 'duplicate' | 'fraudulent' | 'requested_by_customer' | undefined
			});
		}
	},

	{
		name: 'adjust_stock',
		title: 'Adjust stock',
		description:
			'Add to or remove from a variant stock level. Rejected if it would take stock below zero.',
		readOnly: false,
		inputSchema: {
			type: 'object',
			required: ['variantId', 'delta'],
			properties: {
				variantId: { type: 'integer', minimum: 1 },
				delta: { type: 'integer', minimum: -1000000, maximum: 1000000 }
			}
		},
		handler: async (c, a) => ({
			variantId: a.variantId,
			stock: await c.catalog.adjustStock(a.variantId as number, a.delta as number)
		})
	}
];
