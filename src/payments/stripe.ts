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
	url: string | null;
	status: string;
	paymentIntentId: string | null;
	amountTotal: number | null;
	currency: string | null;
};

export interface StripeClient {
	createCheckoutSession(input: {
		order: Order;
		successUrl: string;
		cancelUrl: string;
		storeId: string;
		/** Extra metadata copied onto the session and the payment intent. */
		metadata?: Record<string, string>;
	}): Promise<CheckoutSession>;
	getCheckoutSession(id: string): Promise<CheckoutSession>;
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
		async createCheckoutSession({ order, successUrl, cancelUrl, storeId, metadata }) {
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

			const body = await request(
				'POST',
				'/v1/checkout/sessions',
				{
					mode: 'payment',
					success_url: successUrl,
					cancel_url: cancelUrl,
					client_reference_id: order.orderNumber,
					customer_email: order.email,
					line_items: lineItems,
					metadata: sharedMetadata,
					payment_intent_data: { metadata: sharedMetadata }
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
