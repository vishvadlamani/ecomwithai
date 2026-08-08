/**
 * The agent surface is called by a language model, so its arguments are
 * untrusted input that merely looks well-formed. These tests are mostly about
 * what happens when the model is wrong.
 *
 *   node --experimental-strip-types src/agent/agent.test.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommerce, createStoreService } from '../index.ts';
import { createTestDb, seedProduct, seedStore } from '../testing.ts';
import type { Store } from '../stores/index.ts';
import { createAgentToolkit } from './index.ts';
import { createMcpFetchHandler, createMcpHandler } from './mcp.ts';

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

const dir = await mkdtemp(join(tmpdir(), 'ecomwithai-agent-'));
const db = await createTestDb(`file:${join(dir, 'test.db')}`);
const stores = createStoreService(db);

await seedStore(db, { id: 'demo', domain: 'demo.test' });
const seed = await seedProduct(db, 'demo', {
	slug: 'tee',
	title: 'Cotton Tee',
	options: [{ name: 'Size', values: [{ value: 'S' }, { value: 'M' }] }],
	variants: [
		{ sku: 'TEE-S', priceCents: 1500, stock: 4, options: ['S'] },
		{ sku: 'TEE-M', priceCents: 1500, stock: 0, options: ['M'] }
	]
});

const commerce = createCommerce({ db, store: (await stores.byId('demo')) as Store });
const readOnly = createAgentToolkit(commerce);
const full = createAgentToolkit(commerce, { allowWrites: true });

const ADDRESS = {
	email: 'agent@example.com',
	firstName: 'A',
	lastName: 'B',
	address1: '1 St',
	city: 'Lisbon',
	postalCode: '1100',
	country: 'PT'
};

// --- permissions ---
check(
	'write tools hidden by default',
	readOnly.list().some((t) => !t.readOnly),
	false
);
check('read tools still exposed', readOnly.list().length > 0, true);
check(
	'writes appear when enabled',
	full.list().some((t) => t.name === 'create_order'),
	true
);
const blocked = await readOnly.call('create_order', { lines: [], shipping: ADDRESS, method: 'standard' });
check('calling a hidden write tool is refused', blocked.ok === false && blocked.code, 'unknown_tool');
check(
	'every tool declares a schema and description',
	full.list().every((t) => t.inputSchema.type === 'object' && t.description.length > 20),
	true
);

// --- reads ---
const list = await readOnly.call('list_products');
check('list_products works', (list as { result: unknown[] }).result.length, 1);

const product = await readOnly.call('get_product', { slug: 'tee' });
check('get_product returns options', (product as { result: { options: unknown[] } }).result.options.length, 1);

const missing = await readOnly.call('get_product', { slug: 'nope' });
check('missing product is a tool error, not a throw', missing.ok, false);

const variant = await readOnly.call('find_variant', { slug: 'tee', options: ['S'] });
check('find_variant resolves', (variant as { result: { sku: string } }).result.sku, 'TEE-S');

// --- argument validation ---
const noArgs = await full.call('get_product', {});
check('missing required arg is rejected', noArgs.ok === false && noArgs.code, 'invalid_arguments');
check('message names the field', noArgs.ok === false && noArgs.error.includes('slug'), true);

const coerced = await full.call('list_products', { limit: '2' });
check('numeric string is coerced', coerced.ok, true);

const badLimit = await full.call('list_products', { limit: 9999 });
check('out-of-range number is rejected', badLimit.ok === false && badLimit.code, 'invalid_arguments');

const negative = await full.call('create_order', {
	lines: [{ variantId: seed.variantIds['TEE-S'], quantity: -3 }],
	shipping: ADDRESS,
	method: 'standard'
});
check('negative quantity is rejected before reaching the domain', negative.ok === false && negative.code, 'invalid_arguments');

const wrongType = await full.call('create_order', {
	lines: 'everything',
	shipping: ADDRESS,
	method: 'standard'
});
check('wrong type is rejected', wrongType.ok === false && wrongType.code, 'invalid_arguments');

const badStatus = await full.call('set_order_status', { orderNumber: 'X', status: 'teleported' });
check('enum is enforced', badStatus.ok === false && badStatus.code, 'invalid_arguments');

const unknown = await full.call('drop_database', {});
check('unknown tool is refused', unknown.ok === false && unknown.code, 'unknown_tool');

const hallucinated = await full.call('get_product', { slug: 'tee', sortBy: 'vibes' });
check('invented arguments are ignored, not fatal', hallucinated.ok, true);

// --- writes ---
const placed = await full.call('create_order', {
	lines: [{ variantId: seed.variantIds['TEE-S'], quantity: 2 }],
	shipping: ADDRESS,
	method: 'standard',
	idempotencyKey: 'run-1'
});
check('order placed', placed.ok, true);
const orderNumber = (placed as { result: { orderNumber: string } }).result.orderNumber;

const replay = await full.call('create_order', {
	lines: [{ variantId: seed.variantIds['TEE-S'], quantity: 2 }],
	shipping: ADDRESS,
	method: 'standard',
	idempotencyKey: 'run-1'
});
check('retry with same key returns the same order',
	(replay as { result: { orderNumber: string } }).result.orderNumber, orderNumber);
check('stock only moved once',
	(await commerce.catalog.findVariant(seed.productId, ['S']))?.stock, 2);

const soldOut = await full.call('create_order', {
	lines: [{ variantId: seed.variantIds['TEE-M'], quantity: 1 }],
	shipping: ADDRESS,
	method: 'standard'
});
check('out-of-stock failure is actionable',
	soldOut.ok === false && soldOut.error.includes('insufficient_stock'), true);
check('failure says nothing was charged',
	soldOut.ok === false && soldOut.error.includes('nothing was charged'), true);

// --- MCP protocol ---
const mcp = createMcpHandler(full);

const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
check('initialize returns capabilities',
	(init?.result as { capabilities: { tools: unknown } })?.capabilities?.tools !== undefined, true);
check('initialize echoes the protocol version',
	(init?.result as { protocolVersion: string })?.protocolVersion, '2025-06-18');

check('notifications get no response',
	await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

const tools = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
const toolList = (tools?.result as { tools: { name: string; annotations: { readOnlyHint: boolean } }[] }).tools;
check('tools/list exposes every tool', toolList.length, full.list().length);
check('read-only hint is advertised',
	toolList.find((t) => t.name === 'list_products')?.annotations.readOnlyHint, true);

const called = await mcp.handle({
	jsonrpc: '2.0', id: 3, method: 'tools/call',
	params: { name: 'get_product', arguments: { slug: 'tee' } }
});
check('tools/call returns text content',
	(called?.result as { content: { type: string }[] }).content[0].type, 'text');
check('tools/call is not an error', (called?.result as { isError: boolean }).isError, false);

const failed = await mcp.handle({
	jsonrpc: '2.0', id: 4, method: 'tools/call',
	params: { name: 'get_product', arguments: {} }
});
check('tool failure is isError, not a JSON-RPC error',
	(failed?.result as { isError: boolean }).isError, true);
check('tool failure carries no transport error', failed?.error, undefined);

const unknownMethod = await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'nope' });
check('unknown method is a JSON-RPC error', unknownMethod?.error?.code, -32601);

const malformed = await mcp.handle({ id: 6, method: 'tools/list' });
check('missing jsonrpc field is rejected', malformed?.error?.code, -32600);
check('non-object message is rejected', (await mcp.handle('hello'))?.error?.code, -32600);

// --- MCP over HTTP ---
const fetchHandler = createMcpFetchHandler(mcp);
const httpRes = await fetchHandler(
	new Request('https://store.test/mcp', {
		method: 'POST',
		body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
	})
);
check('http transport responds 200', httpRes.status, 200);
check('http transport returns tools',
	((await httpRes.json()) as { result: { tools: unknown[] } }).result.tools.length, full.list().length);

check('GET is rejected',
	(await fetchHandler(new Request('https://store.test/mcp'))).status, 405);

const batch = await fetchHandler(
	new Request('https://store.test/mcp', {
		method: 'POST',
		body: JSON.stringify([
			{ jsonrpc: '2.0', id: 8, method: 'ping' },
			{ jsonrpc: '2.0', id: 9, method: 'ping' }
		])
	})
);
check('batches are supported', ((await batch.json()) as unknown[]).length, 2);

const badJson = await fetchHandler(
	new Request('https://store.test/mcp', { method: 'POST', body: '{ not json' })
);
check('invalid JSON returns a parse error', badJson.status, 400);

db.close();
await rm(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nAgent surface holds.');
process.exitCode = failures ? 1 : 0;
