/**
 * MCP server over stdio — the transport desktop AI clients use.
 *
 *   ECOMWITHAI_DATABASE_URL=file:store.db \
 *   ECOMWITHAI_STORE_ID=demo \
 *   ECOMWITHAI_ALLOW_WRITES=1 \
 *   node --experimental-strip-types node_modules/ecomwithai/src/agent/mcp-stdio.ts
 *
 * Reads newline-delimited JSON-RPC on stdin, writes responses on stdout. Nothing
 * else may write to stdout — diagnostics go to stderr or they corrupt the stream.
 */
import { createInterface } from 'node:readline';
import { createCommerce, createDirectory } from '../index.ts';
import { createAgentToolkit } from './index.ts';
import { createMcpHandler } from './mcp.ts';

const url = process.env.ECOMWITHAI_DATABASE_URL;
const storeId = process.env.ECOMWITHAI_STORE_ID;

if (!url || !storeId) {
	console.error('ECOMWITHAI_DATABASE_URL and ECOMWITHAI_STORE_ID are required');
	process.exit(1);
}

const { db, stores } = createDirectory({
	url,
	authToken: process.env.ECOMWITHAI_AUTH_TOKEN
});

const store = await stores.byId(storeId);
if (!store) {
	console.error(`No active store "${storeId}"`);
	process.exit(1);
}

const commerce = createCommerce({ db, store });
const toolkit = createAgentToolkit(commerce, {
	// Off unless explicitly enabled: an agent that can place orders and move
	// stock should be an opt-in, never a default.
	allowWrites: process.env.ECOMWITHAI_ALLOW_WRITES === '1'
});
const handler = createMcpHandler(toolkit);

console.error(
	`ecomwithai MCP ready — store "${store.id}", ${toolkit.list().length} tools, ` +
		`writes ${process.env.ECOMWITHAI_ALLOW_WRITES === '1' ? 'enabled' : 'disabled'}`
);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
	const trimmed = line.trim();
	if (!trimmed) continue;

	let message: unknown;
	try {
		message = JSON.parse(trimmed);
	} catch {
		process.stdout.write(
			JSON.stringify({
				jsonrpc: '2.0',
				id: null,
				error: { code: -32700, message: 'Invalid JSON' }
			}) + '\n'
		);
		continue;
	}

	const response = await handler.handle(message);
	if (response) process.stdout.write(JSON.stringify(response) + '\n');
}
