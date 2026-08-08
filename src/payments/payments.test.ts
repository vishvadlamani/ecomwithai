/**
 * Payments, tested against a mock Stripe — no keys, no network.
 *
 * The webhook endpoint is the highest-value target in a commerce system: anyone
 * can POST to it, and a handler that trusts the body marks orders paid for free.
 * Most of what follows is an attacker's checklist.
 *
 *   node --experimental-strip-types src/payments/payments.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommerce, createStoreService } from '../index.ts';
import { createTestDb, seedProduct, seedStore } from '../testing.ts';
import type { Store } from '../stores/index.ts';
import { encodeForm } from './stripe.ts';
import { signStripePayload, verifyStripeSignature } from './signature.ts';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
	if (!ok) {
		console.log(`      expected ${JSON.stringify(expected)}`);
		console.log(`      actual   ${JSON.stringify(actual)}`);
		failures += 1;
	}
}

const SECRET = 'whsec_test_secret';
const NOW = 1786200000;

// --- form encoding ---
check(
	'nested objects use bracket paths',
	decodeURIComponent(encodeForm({ price_data: { currency: 'usd', unit_amount: 1500 } })),
	'price_data[currency]=usd&price_data[unit_amount]=1500'
);
check(
	'arrays are indexed',
	decodeURIComponent(encodeForm({ line_items: [{ quantity: 2 }, { quantity: 1 }] })),
	'line_items[0][quantity]=2&line_items[1][quantity]=1'
);
check('undefined and null are omitted', encodeForm({ a: 1, b: undefined, c: null }), 'a=1');
check(
	'values are percent-encoded',
	encodeForm({ name: 'Tee & Mug' }),
	'name=Tee%20%26%20Mug'
);

// --- signature verification ---
const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
const goodHeader = await signStripePayload(SECRET, payload, NOW);

check('a valid signature verifies',
	(await verifyStripeSignature({ payload, header: goodHeader, secret: SECRET, nowSeconds: NOW })).valid,
	true);

check('a tampered payload fails',
	await verifyStripeSignature({
		payload: payload.replace('evt_1', 'evt_2'),
		header: goodHeader, secret: SECRET, nowSeconds: NOW
	}).then((r) => (r.valid ? 'valid' : r.reason)),
	'no_matching_signature');

check('the wrong secret fails',
	await verifyStripeSignature({ payload, header: goodHeader, secret: 'whsec_other', nowSeconds: NOW })
		.then((r) => (r.valid ? 'valid' : r.reason)),
	'no_matching_signature');

check('an old signature is rejected (replay)',
	await verifyStripeSignature({ payload, header: goodHeader, secret: SECRET, nowSeconds: NOW + 3600 })
		.then((r) => (r.valid ? 'valid' : r.reason)),
	'timestamp_out_of_tolerance');

check('a far-future signature is rejected',
	await verifyStripeSignature({ payload, header: goodHeader, secret: SECRET, nowSeconds: NOW - 3600 })
		.then((r) => (r.valid ? 'valid' : r.reason)),
	'timestamp_out_of_tolerance');

check('a missing header is rejected',
	await verifyStripeSignature({ payload, header: null, secret: SECRET, nowSeconds: NOW })
		.then((r) => (r.valid ? 'valid' : r.reason)),
	'missing_header');

check('a header with no v1 is rejected',
	await verifyStripeSignature({ payload, header: `t=${NOW}`, secret: SECRET, nowSeconds: NOW })
		.then((r) => (r.valid ? 'valid' : r.reason)),
	'no_signatures');

check('a header with no timestamp is rejected',
	await verifyStripeSignature({ payload, header: 'v1=abc', secret: SECRET, nowSeconds: NOW })
		.then((r) => (r.valid ? 'valid' : r.reason)),
	'missing_timestamp');

// Stripe sends one v1 per active secret while a secret is being rotated.
const rotated = `${goodHeader},v1=${'0'.repeat(64)}`;
check('any matching signature among several is accepted',
	(await verifyStripeSignature({ payload, header: rotated, secret: SECRET, nowSeconds: NOW })).valid,
	true);

// --- store fixture ---
const dir = await mkdtemp(join(tmpdir(), 'ecomwithai-pay-'));
const db = await createTestDb(`file:${join(dir, 'pay.db')}`);
await seedStore(db, { id: 'shop', domain: 'shop.test' });
const seed = await seedProduct(db, 'shop', {
	slug: 'tee',
	title: 'Cotton Tee',
	variants: [{ sku: 'TEE-1', priceCents: 2000, stock: 10 }]
});

const requests: { path: string; body: string; headers: Record<string, string> }[] = [];
let sessionCounter = 0;

const mockStripe: typeof fetch = async (input, init) => {
	const url = String(input);
	const path = url.replace('https://api.stripe.com', '');
	const headers = Object.fromEntries(
		Object.entries((init?.headers ?? {}) as Record<string, string>)
	);
	requests.push({ path, body: String(init?.body ?? ''), headers });

	if (path === '/v1/checkout/sessions') {
		sessionCounter += 1;
		return new Response(
			JSON.stringify({
				id: `cs_test_${sessionCounter}`,
				url: `https://checkout.stripe.com/pay/cs_test_${sessionCounter}`,
				status: 'open',
				payment_intent: `pi_test_${sessionCounter}`
			}),
			{ status: 200 }
		);
	}
	if (path === '/v1/refunds') {
		return new Response(
			JSON.stringify({ id: 're_test_1', status: 'succeeded', amount: 2000 }),
			{ status: 200 }
		);
	}
	return new Response(JSON.stringify({ error: { message: 'not mocked', type: 'invalid_request_error' } }), {
		status: 404
	});
};

const stores = createStoreService(db);
const commerce = createCommerce({
	db,
	store: (await stores.byId('shop')) as Store,
	stripe: { secretKey: 'sk_test_x', webhookSecret: SECRET, fetch: mockStripe }
});
const payments = commerce.payments!;

check('payments are null without config',
	createCommerce({ db, store: (await stores.byId('shop')) as Store }).payments, null);

const shipping = {
	email: 'buyer@example.com',
	firstName: 'Sam',
	lastName: 'Doe',
	address1: '1 Main St',
	city: 'Lisbon',
	postalCode: '1100',
	country: 'PT'
};

const order = await commerce.orders.create({
	lines: [{ variantId: seed.variantIds['TEE-1'], quantity: 2 }],
	method: 'express',
	shipping
});
check('order total is 2x2000 + 1200 shipping', order.totalCents, 5200);

// --- checkout session ---
const checkout = await payments.startCheckout({
	orderNumber: order.orderNumber,
	successUrl: 'https://shop.test/thanks',
	cancelUrl: 'https://shop.test/cart'
});
check('checkout returns a hosted URL', checkout.url.startsWith('https://checkout.stripe.com/'), true);

const sessionRequest = requests.find((r) => r.path === '/v1/checkout/sessions')!;
const body = decodeURIComponent(sessionRequest.body);
check('line item carries the unit price', body.includes('line_items[0][price_data][unit_amount]=2000'), true);
check('line item carries the quantity', body.includes('line_items[0][quantity]=2'), true);
check('shipping is its own line item', body.includes('line_items[1][price_data][unit_amount]=1200'), true);
check('order number travels as metadata', body.includes(`metadata[order_number]=${order.orderNumber}`), true);
check('store id travels as metadata', body.includes('metadata[store_id]=shop'), true);
check('metadata is copied onto the payment intent',
	body.includes(`payment_intent_data[metadata][order_number]=${order.orderNumber}`), true);
check('request is idempotent', sessionRequest.headers['idempotency-key'],
	`checkout:shop:${order.orderNumber}`);
check('secret key is sent as a bearer token',
	sessionRequest.headers['authorization'], 'Bearer sk_test_x');
check('payment row recorded as pending', (await payments.byOrderNumber(order.orderNumber))?.status, 'pending');

// --- webhooks ---
const webhook = async (event: unknown, opts: { secret?: string; now?: number } = {}) => {
	const raw = JSON.stringify(event);
	const header = await signStripePayload(opts.secret ?? SECRET, raw, opts.now ?? Math.floor(Date.now() / 1000));
	return payments.handleWebhook(raw, header);
};

const completed = (overrides: Record<string, unknown> = {}, id = 'evt_paid_1') => ({
	id,
	type: 'checkout.session.completed',
	data: {
		object: {
			id: checkout.sessionId,
			amount_total: 5200,
			currency: 'usd',
			client_reference_id: order.orderNumber,
			metadata: { order_number: order.orderNumber, store_id: 'shop' },
			...overrides
		}
	}
});

const forged = await payments.handleWebhook(JSON.stringify(completed()), 't=1,v1=deadbeef');
check('a forged signature is rejected', forged.handled === false && forged.reason, 'invalid_signature');

const unsigned = await payments.handleWebhook(JSON.stringify(completed()), null);
check('an unsigned request is rejected', unsigned.handled === false && unsigned.reason, 'invalid_signature');

const wrongSecret = await webhook(completed(), { secret: 'whsec_attacker' });
check('a signature from the wrong secret is rejected',
	wrongSecret.handled === false && wrongSecret.reason, 'invalid_signature');

const short = await webhook(completed({ amount_total: 100 }), {});
check('underpayment does not mark the order paid',
	short.handled === false && short.reason, 'amount_mismatch');
check('order still unpaid after underpayment',
	(await commerce.orders.byNumber(order.orderNumber))?.status, 'pending_payment');

const wrongCurrency = await webhook(completed({ currency: 'jpy' }, 'evt_ccy'), {});
check('a currency swap does not mark the order paid',
	wrongCurrency.handled === false && wrongCurrency.reason, 'amount_mismatch');

const otherStore = await webhook(
	completed({ metadata: { order_number: order.orderNumber, store_id: 'someone_else' } }, 'evt_tenant')
);
check('an event for another tenant is refused',
	otherStore.handled === false && otherStore.reason, 'wrong_store');

const paid = await webhook(completed({}, 'evt_paid_ok'));
check('a valid event marks the order paid', paid.handled === true && paid.action, 'order_paid');
check('order status is paid', (await commerce.orders.byNumber(order.orderNumber))?.status, 'paid');
check('payment status is succeeded', (await payments.byOrderNumber(order.orderNumber))?.status, 'succeeded');

const replay = await webhook(completed({}, 'evt_paid_ok'));
check('redelivery of the same event is a no-op',
	replay.handled === false && replay.reason, 'duplicate');

const concurrent = await Promise.all(
	Array.from({ length: 4 }, () => webhook(completed({}, 'evt_concurrent')))
);
check('concurrent redelivery applies exactly once',
	concurrent.filter((r) => r.handled).length, 1);

const ignored = await webhook({ id: 'evt_other', type: 'customer.created', data: { object: {} } });
check('unrelated event types are ignored', ignored.handled === false && ignored.reason, 'ignored');

check('stock is not restored for a paid order',
	(await commerce.catalog.findVariant(seed.productId, []))?.stock, 8);

const lateExpiry = await webhook({
	id: 'evt_expired_late',
	type: 'checkout.session.expired',
	data: {
		object: {
			id: checkout.sessionId,
			metadata: { order_number: order.orderNumber, store_id: 'shop' }
		}
	}
});
check('an expiry after payment does not restock',
	lateExpiry.handled === false && lateExpiry.reason, 'ignored');
check('stock unchanged by the late expiry',
	(await commerce.catalog.findVariant(seed.productId, []))?.stock, 8);

// --- abandoned checkout returns stock ---
const abandoned = await commerce.orders.create({
	lines: [{ variantId: seed.variantIds['TEE-1'], quantity: 3 }],
	method: 'standard',
	shipping
});
check('stock taken by the new order', (await commerce.catalog.findVariant(seed.productId, []))?.stock, 5);

const expired = await webhook({
	id: 'evt_expired',
	type: 'checkout.session.expired',
	data: {
		object: {
			id: 'cs_test_abandoned',
			metadata: { order_number: abandoned.orderNumber, store_id: 'shop' }
		}
	}
});
check('expiry releases the reserved stock',
	expired.handled === true && expired.action, 'stock_released:expired');
check('stock returned', (await commerce.catalog.findVariant(seed.productId, []))?.stock, 8);
check('order marked cancelled',
	(await commerce.orders.byNumber(abandoned.orderNumber))?.status, 'cancelled');

const expiredAgain = await webhook({
	id: 'evt_expired',
	type: 'checkout.session.expired',
	data: { object: { id: 'cs_test_abandoned', metadata: { order_number: abandoned.orderNumber, store_id: 'shop' } } }
});
check('a replayed expiry does not restock twice',
	expiredAgain.handled === false && expiredAgain.reason, 'duplicate');
check('stock still correct after replay',
	(await commerce.catalog.findVariant(seed.productId, []))?.stock, 8);

// --- refunds ---
const refund = await payments.refund({ orderNumber: order.orderNumber, reason: 'requested_by_customer' });
check('refund returns an id', refund.refundId, 're_test_1');
const refundRequest = requests.find((r) => r.path === '/v1/refunds')!;
check('refund targets the payment intent',
	decodeURIComponent(refundRequest.body).includes('payment_intent=cs_test_1'), true);
check('refund is idempotent',
	refundRequest.headers['idempotency-key'], `refund:shop:${order.orderNumber}:full`);

let refundUnpaid = 'no error';
try {
	await payments.refund({ orderNumber: abandoned.orderNumber });
} catch (e) {
	refundUnpaid = (e as Error).message;
}
check('refunding an order that never paid is refused', refundUnpaid !== 'no error', true);

const refunded = await webhook({
	id: 'evt_refund',
	type: 'charge.refunded',
	data: { object: { id: 'ch_1', metadata: { order_number: order.orderNumber, store_id: 'shop' } } }
});
check('refund webhook releases stock',
	refunded.handled === true && refunded.action, 'stock_released:refunded');
check('order marked refunded',
	(await commerce.orders.byNumber(order.orderNumber))?.status, 'refunded');
check('refunded stock returned', (await commerce.catalog.findVariant(seed.productId, []))?.stock, 10);

db.close();
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nPayments hold.');
process.exitCode = failures ? 1 : 0;
