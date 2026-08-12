/**
 * Stripe over the REST API — no SDK.
 *
 * Keeps the package dependency-free and runs on any runtime with `fetch`,
 * including Workers where the official SDK's Node assumptions do not hold.
 */
import type { Order } from '../orders/index.ts';
import { verifyStripeSignature, type SignatureResult } from './signature.ts';

const DEFAULT_BASE_URL = 'https://api.stripe.com';
const DEFAULT_API_VERSION = '2025-08-27.basil';

export type StripeConfig = {
	/** Restricted or secret key. Never ship this to a browser. */
	secretKey: string;
	/** Endpoint signing secret (`whsec_...`). Required to accept webhooks. */
	webhookSecret?: string;
	apiVersion?: string;
	/**
	 * What the buyer sees on their card statement.
	 *
	 * Worth setting whenever the Stripe account is not named after the store the
	 * customer thinks they bought from: an unrecognised descriptor is one of the
	 * most common causes of a chargeback, and the customer disputing it is
	 * behaving reasonably.
	 *
	 * `statementDescriptor` replaces the account default outright.
	 * `statementDescriptorSuffix` appends to the account's *prefix*, and only
	 * works if one is configured — an account whose full descriptor is already
	 * at Stripe's 22-character limit has no room, so prefer the full form there.
	 * Stripe caps both at 22 characters and rejects `<>'"\` and `*`.
	 */
	statementDescriptor?: string;
	statementDescriptorSuffix?: string;
	/**
	 * Which payment methods to offer, as a Stripe payment method configuration
	 * id. Without one Stripe uses the account default — which is the wrong knob
	 * when one account serves several businesses, because changing it changes
	 * them all.
	 */
	paymentMethodConfiguration?: string;
	/** Override for a proxy or a test double. */
	baseUrl?: string;
	/** Injected so tests never touch the network. */
	fetch?: typeof fetch;
};

export class StripeError extends Error {
	readonly status: number;
	readonly type?: string;
	readonly code?: string;

	constructor(status: number, message: string, type?: string, code?: string) {
		super(message);
		this.name = 'StripeError';
		this.status = status;
		this.type = type;
		this.code = code;
	}
}

/**
 * Stripe takes form-encoded bodies with bracketed paths for nesting, not JSON:
 * `line_items[0][price_data][unit_amount]=1500`.
 */
export function encodeForm(value: unknown, prefix = ''): string {
	const parts: string[] = [];

	const walk = (val: unknown, path: string) => {
		if (val === undefined || val === null) return;

		if (Array.isArray(val)) {
			val.forEach((item, i) => walk(item, `${path}[${i}]`));
			return;
		}

		if (typeof val === 'object') {
			for (const [key, sub] of Object.entries(val as Record<string, unknown>)) {
				walk(sub, path ? `${path}[${key}]` : key);
			}
			return;
		}

		parts.push(`${encodeURIComponent(path)}=${encodeURIComponent(String(val))}`);
	};

	walk(value, prefix);
	return parts.join('&');
}

export type CheckoutSession = {
	id: string;
	/** Set in hosted mode: the Stripe-hosted page to send the customer to. */
	url: string | null;
	/**
	 * Set in embedded mode: hand this to Stripe.js and the card form mounts on
	 * your own page. Card data still goes straight to Stripe from an iframe, so
	 * the PCI position is the same as the hosted page — the customer just never
	 * leaves the site.
	 */
	clientSecret: string | null;
	status: string;
	paymentIntentId: string | null;
	amountTotal: number | null;
	currency: string | null;
};

export interface StripeClient {
	createCheckoutSession(input: {
		order: Order;
		/** Hosted mode only: where Stripe returns a paying customer. */
		successUrl?: string;
		/** Hosted mode only: where Stripe returns someone who backed out. */
		cancelUrl?: string;
		/** Embedded mode only: where Stripe returns after the on-page form. */
		returnUrl?: string;
		/** Defaults to 'hosted' so existing callers are unaffected. */
		uiMode?: 'hosted' | 'embedded';
		storeId: string;
		/** Extra metadata copied onto the session and the payment intent. */
		metadata?: Record<string, string>;
	}): Promise<CheckoutSession>;
	getCheckoutSession(id: string): Promise<CheckoutSession>;
	/**
	 * A payment intent for the order total, for mounting Stripe's Payment
	 * Element directly in your own checkout form. Unlike a Checkout Session
	 * this is a single amount, so an order discount needs no coupon to
	 * reconcile — the intent is simply the amount owed.
	 */
	createPaymentIntent(input: {
		order: Order;
		storeId: string;
		metadata?: Record<string, string>;
		idempotencyKey?: string;
	}): Promise<{ id: string; clientSecret: string; amountCents: number }>;
	/** Fixed-amount, single-use coupon. Used to carry an order's discount. */
	createCoupon(input: {
		amountOffCents: number;
		currency: string;
		name?: string;
		idempotencyKey?: string;
	}): Promise<{ id: string }>;
	refund(input: {
		paymentIntentId: string;
		amountCents?: number;
		reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
		idempotencyKey?: string;
	}): Promise<{ id: string; status: string; amountCents: number }>;
	verifyWebhook(payload: string, header: string | null): Promise<SignatureResult>;
}

function toSession(body: Record<string, unknown>): CheckoutSession {
	const intent = body.payment_intent;
	return {
		id: String(body.id),
		url: body.url === null || body.url === undefined ? null : String(body.url),
		clientSecret:
			body.client_secret === null || body.client_secret === undefined
				? null
				: String(body.client_secret),
		status: String(body.status ?? 'open'),
		paymentIntentId:
			intent === null || intent === undefined
				? null
				: typeof intent === 'string'
					? intent
					: String((intent as { id?: unknown }).id ?? ''),
		amountTotal: body.amount_total === null || body.amount_total === undefined
			? null
			: Number(body.amount_total),
		currency: body.currency === null || body.currency === undefined ? null : String(body.currency)
	};
}

export function createStripeClient(config: StripeConfig): StripeClient {
	const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
	const doFetch = config.fetch ?? fetch;

	async function request(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
		idempotencyKey?: string
	): Promise<Record<string, unknown>> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${config.secretKey}`,
			'stripe-version': config.apiVersion ?? DEFAULT_API_VERSION
		};
		if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
		// Stripe deduplicates retries on this key for 24h, so a network timeout
		// during checkout cannot create two charges.
		if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

		const response = await doFetch(`${baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : encodeForm(body)
		});

		const text = await response.text();
		let parsed: Record<string, unknown> = {};
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			throw new StripeError(response.status, `Unparseable response: ${text.slice(0, 200)}`);
		}

		if (!response.ok) {
			const error = (parsed.error ?? {}) as Record<string, unknown>;
			throw new StripeError(
				response.status,
				String(error.message ?? `Stripe returned ${response.status}`),
				error.type === undefined ? undefined : String(error.type),
				error.code === undefined ? undefined : String(error.code)
			);
		}

		return parsed;
	}

	return {
		async createPaymentIntent({ order, storeId, metadata, idempotencyKey }) {
			const sharedMetadata = {
				order_number: order.orderNumber,
				store_id: storeId,
				...metadata
			};
			const body = await request(
				'POST',
				'/v1/payment_intents',
				{
					amount: order.totalCents,
					currency: order.currency.toLowerCase(),
					// Lets Stripe decide which methods to offer from the dashboard
					// settings rather than hard-coding cards here.
					automatic_payment_methods: { enabled: true },
					...(config.paymentMethodConfiguration
						? { payment_method_configuration: config.paymentMethodConfiguration }
						: {}),
					receipt_email: order.email,
					metadata: sharedMetadata,
					...(config.statementDescriptor
						? { statement_descriptor: config.statementDescriptor }
						: {})
				},
				idempotencyKey
			);
			return {
				id: String(body.id),
				clientSecret: String(body.client_secret),
				amountCents: Number(body.amount)
			};
		},

		async createCoupon({ amountOffCents, currency, name, idempotencyKey }) {
			const body = await request(
				'POST',
				'/v1/coupons',
				{
					amount_off: amountOffCents,
					currency: currency.toLowerCase(),
					duration: 'once',
					...(name ? { name } : {})
				},
				idempotencyKey
			);
			return { id: String(body.id) };
		},

		async createCheckoutSession({
			order,
			successUrl,
			cancelUrl,
			returnUrl,
			uiMode = 'hosted',
			storeId,
			metadata
		}) {
			const currency = order.currency.toLowerCase();

			const lineItems = order.items.map((item) => ({
				quantity: item.quantity,
				price_data: {
					currency,
					unit_amount: item.unitPriceCents,
					product_data: {
						name: item.title,
						// Options describe the variant; Stripe shows this under the name.
						description: [item.sku, ...item.options.filter(Boolean)].join(' · ')
					}
				}
			}));

			// Shipping as a line item keeps the session total equal to the order
			// total, which is what the webhook asserts on.
			if (order.shippingCents > 0) {
				lineItems.push({
					quantity: 1,
					price_data: {
						currency,
						unit_amount: order.shippingCents,
						product_data: { name: 'Shipping', description: order.orderNumber }
					}
				});
			}

			const sharedMetadata = {
				order_number: order.orderNumber,
				store_id: storeId,
				...metadata
			};

			const paymentIntentData: Record<string, unknown> = { metadata: sharedMetadata };
			if (config.statementDescriptor) {
				paymentIntentData.statement_descriptor = config.statementDescriptor;
			}
			if (config.statementDescriptorSuffix) {
				paymentIntentData.statement_descriptor_suffix = config.statementDescriptorSuffix;
			}

			// Stripe rejects success_url/cancel_url in embedded mode and return_url
			// in hosted mode, so the two shapes are built separately rather than
			// merged and filtered.
			const urls =
				uiMode === 'embedded'
					? { ui_mode: 'embedded', return_url: returnUrl }
					: { success_url: successUrl, cancel_url: cancelUrl };

			// Line items sum to subtotal + shipping. An order with a discount totals
			// less than that, and the webhook asserts the two match — so without
			// this the customer is charged the undiscounted amount and the payment
			// is then rejected as a mismatch. A single-use coupon closes the gap
			// exactly, with no rounding to distribute across lines.
			let discounts: { coupon: string }[] | undefined;
			if (order.discountCents > 0) {
				const coupon = await this.createCoupon({
					amountOffCents: order.discountCents,
					currency,
					name: `Bundle discount · ${order.orderNumber}`,
					idempotencyKey: `coupon:${storeId}:${order.orderNumber}`
				});
				discounts = [{ coupon: coupon.id }];
			}

			const body = await request(
				'POST',
				'/v1/checkout/sessions',
				{
					mode: 'payment',
					...urls,
					...(discounts ? { discounts } : {}),
					client_reference_id: order.orderNumber,
					customer_email: order.email,
					line_items: lineItems,
					metadata: sharedMetadata,
					payment_intent_data: paymentIntentData
				},
				`checkout:${storeId}:${order.orderNumber}`
			);

			return toSession(body);
		},

		async getCheckoutSession(id) {
			return toSession(await request('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`));
		},

		async refund({ paymentIntentId, amountCents, reason, idempotencyKey }) {
			const body = await request(
				'POST',
				'/v1/refunds',
				{
					payment_intent: paymentIntentId,
					amount: amountCents,
					reason
				},
				idempotencyKey
			);
			return {
				id: String(body.id),
				status: String(body.status),
				amountCents: Number(body.amount ?? 0)
			};
		},

		verifyWebhook(payload, header) {
			if (!config.webhookSecret) {
				return Promise.resolve({ valid: false, reason: 'missing_header' as const });
			}
			return verifyStripeSignature({
				payload,
				header,
				secret: config.webhookSecret
			});
		}
	};
}
