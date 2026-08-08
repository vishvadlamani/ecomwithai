/**
 * Core guarantees: tenant isolation, server-side pricing, stock safety and
 * idempotent order creation. A failure here is a data-integrity bug, not a
 * cosmetic one.
 *
 *   node --experimental-strip-types src/commerce.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommerce, createStoreService } from './index.ts';
import { createTestDb, seedProduct, seedStore } from './testing.ts';
import type { Store } from './stores/index.ts';

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

const dir = await mkdtemp(join(tmpdir(), 'ecomwithai-'));
const db = await createTestDb(`file:${join(dir, 'test.db')}`);
const stores = createStoreService(db);

await seedStore(db, { id: 'alpha', domain: 'alpha.test' });
await seedStore(db, { id: 'bravo', domain: 'bravo.test' });

const alphaSeed = await seedProduct(db, 'alpha', {
	slug: 'tee',
	title: 'Cotton Tee',
	description: 'A shirt.',
	options: [
		{ name: 'Color', values: [{ value: 'Blue', swatchHex: '#00f' }, { value: 'Red' }] },
		{ name: 'Size', values: [{ value: 'S' }, { value: 'M' }] }
	],
	variants: [
		{ sku: 'TEE-BLUE-S', priceCents: 1000, stock: 5, options: ['Blue', 'S'] },
		{ sku: 'TEE-BLUE-M', priceCents: 1200, stock: 0, options: ['Blue', 'M'] },
		{ sku: 'TEE-RED-S', priceCents: 1000, stock: 3, options: ['Red', 'S'] }
	],
	media: [{ url: '/img/blue.jpg', optionValue: 'Blue' }],
	metafields: [{ namespace: 'specs', key: 'care', value: { wash: 'cold' } }]
});

const bravoSeed = await seedProduct(db, 'bravo', {
	slug: 'mug',
	title: 'Enamel Mug',
	variants: [{ sku: 'MUG-1', priceCents: 2500, stock: 9 }]
});

const alpha = createCommerce({ db, store: (await stores.byId('alpha')) as Store });
const bravo = createCommerce({ db, store: (await stores.byId('bravo')) as Store });

const shipping = {
	email: 'Buyer@Example.com',
	firstName: 'Sam',
	lastName: 'Doe',
	address1: '1 Main St',
	city: 'Lisbon',
	postalCode: '1100',
	country: 'PT'
};

// --- catalog shape ---
const tee = await alpha.catalog.getProduct('tee');
check('product title comes from translations', tee?.title, 'Cotton Tee');
check('options are generic and ordered', tee?.options.map((o) => o.name), ['Color', 'Size']);
check('option values carry swatches', tee?.options[0].values[0].swatchHex, '#00f');
check('option value picks up its media', tee?.options[0].values[0].imageUrl, '/img/blue.jpg');
check('price is the cheapest variant', tee?.priceCents, 1000);
check('metafields are parsed JSON', (tee?.metafields['specs.care'] as { wash: string })?.wash, 'cold');
check('single-variant product needs no options', (await bravo.catalog.getProduct('mug'))?.options, []);

const found = await alpha.catalog.findVariant(alphaSeed.productId, ['Red', 'S']);
check('findVariant resolves by option values', found?.sku, 'TEE-RED-S');
check('findVariant returns null for a nonexistent combo',
	await alpha.catalog.findVariant(alphaSeed.productId, ['Red', 'M']), null);

const listed = await alpha.catalog.listProducts();
check('listProducts returns only this store', listed.map((p) => p.slug), ['tee']);
check('listProducts reports stock', listed[0].inStock, true);

// --- tenant isolation ---
check("another store's product is invisible", await alpha.catalog.getProduct('mug'), null);
check(
	"another store's variant cannot be priced",
	(await alpha.catalog.priceVariants([bravoSeed.variantIds['MUG-1']])).size,
	0
);

let crossStore = 'no error';
try {
	await alpha.orders.create({
		lines: [{ variantId: bravoSeed.variantIds['MUG-1'], quantity: 1 }],
		method: 'standard',
		shipping
	});
} catch (e) {
	crossStore = (e as { code?: string }).code ?? 'unknown';
}
check("ordering another store's variant is rejected", crossStore, 'variant_unavailable');
check(
	'rejected cross-store order left stock untouched',
	(await bravo.catalog.getProduct('mug'))?.variants[0].stock,
	9
);

// --- pricing and totals ---
const order = await alpha.orders.create({
	lines: [{ variantId: alphaSeed.variantIds['TEE-BLUE-S'], quantity: 2 }],
	method: 'express',
	shipping
});
check('subtotal uses server-side prices', order.subtotalCents, 2000);
check('shipping rate resolved from id', order.shippingCents, 1200);
check('total is subtotal plus shipping', order.totalCents, 3200);
check('order number uses the default prefix', order.orderNumber.startsWith('ORD-'), true);
check('line item snapshots its options', order.items[0].options.slice(0, 2), ['Blue', 'S']);
check('stock decremented', (await alpha.catalog.getProduct('tee'))?.variants[0].stock, 3);

let badMethod = 'no error';
try {
	await alpha.orders.create({ lines: [{ variantId: alphaSeed.variantIds['TEE-RED-S'], quantity: 1 }], method: 'teleport', shipping });
} catch (e) {
	badMethod = (e as { code?: string }).code ?? 'unknown';
}
check('unknown shipping method is rejected', badMethod, 'unknown_shipping_method');

// --- stock safety ---
let oversell = 'no error';
try {
	await alpha.orders.create({
		lines: [{ variantId: alphaSeed.variantIds['TEE-BLUE-S'], quantity: 99 }],
		method: 'standard',
		shipping
	});
} catch (e) {
	oversell = (e as { code?: string }).code ?? 'unknown';
}
check('overselling is rejected', oversell, 'insufficient_stock');

// Two lines of the same variant must be summed before the stock check, or each
// passes a check for its own quantity and together they oversell.
let split = 'no error';
try {
	await alpha.orders.create({
		lines: [
			{ variantId: alphaSeed.variantIds['TEE-RED-S'], quantity: 2 },
			{ variantId: alphaSeed.variantIds['TEE-RED-S'], quantity: 2 }
		],
		method: 'standard',
		shipping
	});
} catch (e) {
	split = (e as { code?: string }).code ?? 'unknown';
}
check('duplicate lines are merged before the stock check', split, 'insufficient_stock');
check(
	'failed order left stock untouched',
	(await alpha.catalog.findVariant(alphaSeed.productId, ['Red', 'S']))?.stock,
	3
);

let badQty = 'no error';
try {
	await alpha.orders.create({
		lines: [{ variantId: alphaSeed.variantIds['TEE-RED-S'], quantity: 0 }],
		method: 'standard',
		shipping
	});
} catch (e) {
	badQty = (e as { code?: string }).code ?? 'unknown';
}
check('zero quantity is rejected', badQty, 'quantity_invalid');

// --- idempotency ---
const first = await alpha.orders.create({
	lines: [{ variantId: alphaSeed.variantIds['TEE-RED-S'], quantity: 1 }],
	method: 'standard',
	shipping,
	idempotencyKey: 'agent-run-1'
});
const replay = await alpha.orders.create({
	lines: [{ variantId: alphaSeed.variantIds['TEE-RED-S'], quantity: 1 }],
	method: 'standard',
	shipping,
	idempotencyKey: 'agent-run-1'
});
check('replay returns the original order', replay.orderNumber, first.orderNumber);
check('replay is flagged', replay.deduplicated, true);
check(
	'replay did not decrement stock twice',
	(await alpha.catalog.findVariant(alphaSeed.productId, ['Red', 'S']))?.stock,
	2
);

// --- customers ---
const customer = await alpha.customers.byEmail('buyer@example.com');
check('email normalized on write', customer?.email, 'buyer@example.com');
check('lifetime order count rolls up', customer?.ordersCount, 2);
check('lifetime spend rolls up', customer?.totalSpentCents, 3200 + 1000);

await bravo.orders.create({
	lines: [{ variantId: bravoSeed.variantIds['MUG-1'], quantity: 1 }],
	method: 'standard',
	shipping
});
const bravoCustomer = await bravo.customers.byEmail('buyer@example.com');
check('same email is a separate customer per store', bravoCustomer?.id !== customer?.id, true);
check("other store's history does not leak", bravoCustomer?.ordersCount, 1);

// --- order retrieval ---
check('order retrievable by number', (await alpha.orders.byNumber(order.orderNumber))?.totalCents, 3200);
check("another store cannot read the order", await bravo.orders.byNumber(order.orderNumber), null);
check('orders list is store-scoped', (await bravo.orders.list()).length, 1);
check('status update works', await alpha.orders.setStatus(order.orderNumber, 'paid'), true);
check('status persisted', (await alpha.orders.byNumber(order.orderNumber))?.status, 'paid');

// --- stock adjustment ---
check('stock can be added', await alpha.catalog.adjustStock(alphaSeed.variantIds['TEE-BLUE-M'], 5), 5);
let belowZero = 'no error';
try {
	await alpha.catalog.adjustStock(alphaSeed.variantIds['TEE-BLUE-M'], -50);
} catch {
	belowZero = 'rejected';
}
check('stock cannot go negative', belowZero, 'rejected');

db.close();
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nAll commerce guarantees hold.');
process.exitCode = failures ? 1 : 0;
