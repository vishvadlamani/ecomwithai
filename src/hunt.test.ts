/**
 * Adversarial probes. Written to break the implementation rather than confirm
 * it: concurrency, case handling, cross-tenant writes, pagination, and the
 * places where a plausible-looking result is quietly wrong.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyQuantityBreak, createCommerce, createStoreService, resolveQuantityBreak } from './index.ts';
import { createTestDb, seedProduct, seedStore } from './testing.ts';
import type { Store } from './stores/index.ts';
import { createAgentToolkit } from './agent/index.ts';

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

const dir = await mkdtemp(join(tmpdir(), 'ecomwithai-hunt-'));
const db = await createTestDb(`file:${join(dir, 'hunt.db')}`);
const stores = createStoreService(db);

await seedStore(db, { id: 's1', domain: 's1.test' });
await seedStore(db, { id: 's2', domain: 's2.test' });

const seed = await seedProduct(db, 's1', {
	slug: 'hoodie',
	title: 'Hoodie',
	options: [
		{ name: 'Color', values: [{ value: 'Black' }, { value: 'Grey' }] },
		{ name: 'Size', values: [{ value: 'M' }] },
		{ name: 'Fit', values: [{ value: 'Regular' }] }
	],
	variants: [
		{ sku: 'H-BLK', priceCents: 5000, stock: 10, options: ['Black', 'M', 'Regular'] },
		{ sku: 'H-GRY', priceCents: 4000, stock: 1, options: ['Grey', 'M', 'Regular'] }
	],
	media: [
		{ url: '/black.jpg', optionValue: 'Black' },
		{ url: '/generic.jpg' }
	],
	metafields: [
		{ namespace: 'ns', key: 'k', value: 'fallback' },
		{ namespace: 'ns', key: 'k', value: 'french', locale: 'fr' }
	]
});

const other = await seedProduct(db, 's2', {
	slug: 'cap',
	title: 'Cap',
	variants: [{ sku: 'CAP-1', priceCents: 2000, stock: 5 }]
});

const s1 = createCommerce({ db, store: (await stores.byId('s1')) as Store });
const s2 = createCommerce({ db, store: (await stores.byId('s2')) as Store });

const addr = (email: string) => ({
	email,
	firstName: 'A',
	lastName: 'B',
	address1: '1 St',
	city: 'Lisbon',
	postalCode: '1100',
	country: 'PT'
});

// --- media attribution ---
const hoodie = await s1.catalog.getProduct('hoodie');
check(
	'media rows report which option value they belong to',
	hoodie?.media.find((m) => m.url === '/black.jpg')?.optionValue,
	'Black'
);
check(
	'unattached media has no option value',
	hoodie?.media.find((m) => m.url === '/generic.jpg')?.optionValue,
	null
);

// --- three option axes ---
check('third option axis survives round-trip', hoodie?.options.map((o) => o.name), [
	'Color',
	'Size',
	'Fit'
]);
check(
	'variant carries all three values',
	(await s1.catalog.findVariant(seed.productId, ['Black', 'M', 'Regular']))?.sku,
	'H-BLK'
);

// --- metafield locale precedence ---
check('locale-specific metafield wins', (await s1.catalog.getProduct('hoodie', 'fr'))?.metafields['ns.k'], 'french');
check('null-locale metafield is the fallback', hoodie?.metafields['ns.k'], 'fallback');

// --- order email casing ---
await s1.orders.create({
	lines: [{ variantId: seed.variantIds['H-BLK'], quantity: 1 }],
	method: 'standard',
	shipping: addr('Mixed.Case@Example.COM')
});
check(
	'orders are findable by email regardless of case',
	(await s1.orders.list({ email: 'mixed.case@example.com' })).length,
	1
);
check(
	'customer and order agree on the email',
	(await s1.orders.list({ email: 'mixed.case@example.com' }))[0]?.email,
	(await s1.customers.byEmail('mixed.case@example.com'))?.email
);

// --- concurrency: the last unit ---
const contended = await Promise.allSettled(
	Array.from({ length: 5 }, () =>
		s1.orders.create({
			lines: [{ variantId: seed.variantIds['H-GRY'], quantity: 1 }],
			method: 'standard',
			shipping: addr('race@example.com')
		})
	)
);
check(
	'exactly one of five racing orders wins the last unit',
	contended.filter((r) => r.status === 'fulfilled').length,
	1
);
check(
	'stock did not go negative under contention',
	(await s1.catalog.findVariant(seed.productId, ['Grey', 'M', 'Regular']))?.stock,
	0
);

// --- concurrency: idempotency key ---
await s1.catalog.adjustStock(seed.variantIds['H-GRY'], 10);
const replayed = await Promise.allSettled(
	Array.from({ length: 4 }, () =>
		s1.orders.create({
			lines: [{ variantId: seed.variantIds['H-GRY'], quantity: 1 }],
			method: 'standard',
			shipping: addr('idem@example.com'),
			idempotencyKey: 'same-key'
		})
	)
);
const numbers = new Set(
	replayed.flatMap((r) => (r.status === 'fulfilled' ? [r.value.orderNumber] : []))
);
check('concurrent replays collapse to one order', numbers.size, 1);
check(
	'concurrent replays consumed one unit, not four',
	(await s1.catalog.findVariant(seed.productId, ['Grey', 'M', 'Regular']))?.stock,
	9
);

// --- cross-tenant writes ---
let crossAdjust = 'no error';
try {
	await s1.catalog.adjustStock(other.variantIds['CAP-1'], -1);
} catch {
	crossAdjust = 'rejected';
}
check("cannot adjust another store's stock", crossAdjust, 'rejected');
check(
	"other store's stock untouched",
	(await s2.catalog.getProduct('cap'))?.variants[0].stock,
	5
);
check(
	"cannot set status on another store's order",
	await s2.orders.setStatus((await s1.orders.list())[0].orderNumber, 'cancelled'),
	false
);

// --- pagination ---
for (let i = 0; i < 3; i += 1) {
	await seedProduct(db, 's1', {
		slug: `extra-${i}`,
		title: `Extra ${i}`,
		variants: [{ sku: `EX-${i}`, priceCents: 100, stock: 1 }]
	});
}
const page1 = await s1.catalog.listProducts({ limit: 2, offset: 0 });
const page2 = await s1.catalog.listProducts({ limit: 2, offset: 2 });
check('pagination returns the requested page size', page1.length, 2);
check('pages do not overlap', page1.some((p) => page2.some((q) => q.id === p.id)), false);

// --- agent surface edge cases ---
const toolkit = createAgentToolkit(s1, { allowWrites: true });
const nested = await toolkit.call('create_order', {
	lines: [{ variantId: seed.variantIds['H-BLK'], quantity: 'two' }],
	shipping: addr('x@example.com'),
	method: 'standard'
});
check('non-numeric quantity is caught in nested array items', nested.ok === false && nested.code, 'invalid_arguments');

const missingNested = await toolkit.call('create_order', {
	lines: [{ variantId: seed.variantIds['H-BLK'] }],
	shipping: addr('x@example.com'),
	method: 'standard'
});
check('missing nested required field is caught', missingNested.ok === false && missingNested.code, 'invalid_arguments');

const partialAddress = await toolkit.call('create_order', {
	lines: [{ variantId: seed.variantIds['H-BLK'], quantity: 1 }],
	shipping: { email: 'x@example.com' },
	method: 'standard'
});
check('incomplete shipping address is caught', partialAddress.ok === false && partialAddress.code, 'invalid_arguments');

const defaulted = await toolkit.call('list_orders', {});
check('omitted optional args fall back to defaults', defaulted.ok, true);

const emptyLines = await toolkit.call('create_order', {
	lines: [],
	shipping: addr('x@example.com'),
	method: 'standard'
});
check('empty cart is rejected by schema minItems', emptyLines.ok === false && emptyLines.code, 'invalid_arguments');

db.close();
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} finding(s)` : '\nNo findings.');
process.exitCode = failures ? 1 : 0;

// --- quantity breaks -------------------------------------------------------
// Bundle pricing decides what a customer is charged, so the cases that matter
// are the ones where a client could push the total the wrong way.
{
	const TIERS = [
		{ minQuantity: 2, percentOff: 7 },
		{ minQuantity: 3, percentOff: 9 }
	];

	check('below the first tier nothing is discounted', applyQuantityBreak(TIERS, 4497, 1), {
		applied: null,
		discountCents: 0,
		totalCents: 4497
	});

	check(
		'the highest qualifying tier wins',
		applyQuantityBreak(TIERS, 13491, 3).applied?.percentOff,
		9
	);

	check(
		'a table written out of order still picks the best tier',
		resolveQuantityBreak(
			[
				{ minQuantity: 3, percentOff: 9 },
				{ minQuantity: 2, percentOff: 7 }
			],
			5
		)?.percentOff,
		9
	);

	check(
		'quantities above the top tier keep the top discount',
		resolveQuantityBreak(TIERS, 50)?.percentOff,
		9
	);

	// Rounding the total instead of the discount leaves an order whose parts do
	// not sum to what was charged — which resurfaces as a webhook amount
	// mismatch that is very hard to read.
	check(
		'discount plus total always equals the subtotal',
		[1, 99, 4497, 13491, 99999, 100003].every((subtotal) =>
			[1, 2, 3, 7].every((qty) => {
				const r = applyQuantityBreak(TIERS, subtotal, qty);
				return r.discountCents + r.totalCents === subtotal;
			})
		),
		true
	);

	check(
		'a discount can never exceed the subtotal',
		applyQuantityBreak([{ minQuantity: 1, percentOff: 100 }], 4497, 1),
		{ applied: { minQuantity: 1, percentOff: 100 }, discountCents: 4497, totalCents: 0 }
	);

	check(
		'nonsense tiers are ignored rather than applied',
		resolveQuantityBreak(
			[
				{ minQuantity: 2, percentOff: 0 },
				{ minQuantity: 2, percentOff: -20 },
				{ minQuantity: 2, percentOff: 500 },
				{ minQuantity: Number.NaN, percentOff: 50 }
			],
			10
		),
		null
	);

	check(
		'a zero or negative quantity discounts nothing',
		[resolveQuantityBreak(TIERS, 0), resolveQuantityBreak(TIERS, -5)],
		[null, null]
	);

	check('an empty tier table is a no-op, not a crash', applyQuantityBreak([], 4497, 9), {
		applied: null,
		discountCents: 0,
		totalCents: 4497
	});
}
