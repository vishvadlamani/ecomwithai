import type { AgentToolkit } from './index.ts';

/**
 * Model Context Protocol server, transport-agnostic.
 *
 * Implemented directly against the JSON-RPC wire format rather than pulling in
 * an SDK: it is a few hundred lines, it keeps this package dependency-free, and
 * it means the same handler runs on Workers, Node, Deno and Bun.
 */

const PROTOCOL_VERSION = '2025-06-18';

export type JsonRpcRequest = {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

export type McpServerInfo = {
	name: string;
	version: string;
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result };
}

function err(
	id: string | number | null,
	code: number,
	message: string,
	data?: unknown
): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message, data } };
}

export interface McpHandler {
	/** Returns null for notifications, which take no response. */
	handle(message: unknown): Promise<JsonRpcResponse | null>;
}

export function createMcpHandler(
	toolkit: AgentToolkit,
	info: McpServerInfo = { name: 'ecomwithai', version: '0.1.0' }
): McpHandler {
	return {
		async handle(message) {
			if (typeof message !== 'object' || message === null) {
				return err(null, INVALID_REQUEST, 'Request must be a JSON-RPC object');
			}

			const request = message as JsonRpcRequest;
			const id = request.id ?? null;
			const isNotification = request.id === undefined;

			if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
				return isNotification ? null : err(id, INVALID_REQUEST, 'Malformed JSON-RPC request');
			}

			try {
				switch (request.method) {
					case 'initialize': {
						const requested = request.params?.protocolVersion;
						return ok(id, {
							// Echo a client's version when it sends one, so an older client
							// isn't rejected over a field neither side actually varies on.
							protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
							capabilities: { tools: { listChanged: false } },
							serverInfo: info
						});
					}

					case 'notifications/initialized':
					case 'notifications/cancelled':
						return null;

					case 'ping':
						return ok(id, {});

					case 'tools/list':
						return ok(id, {
							tools: toolkit.list().map((tool) => ({
								name: tool.name,
								title: tool.title,
								description: tool.description,
								inputSchema: tool.inputSchema,
								annotations: { readOnlyHint: tool.readOnly }
							}))
						});

					case 'tools/call': {
						const name = request.params?.name;
						if (typeof name !== 'string') {
							return err(id, INVALID_REQUEST, 'tools/call requires a "name"');
						}
						const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
						const result = await toolkit.call(name, args);

						// Tool failures are results, not transport errors — the model is
						// meant to read the message and correct its next call.
						return ok(id, {
							content: [
								{
									type: 'text',
									text: result.ok
										? JSON.stringify(result.result, null, 2)
										: `${result.code}: ${result.error}`
								}
							],
							isError: !result.ok
						});
					}

					default:
						return isNotification
							? null
							: err(id, METHOD_NOT_FOUND, `Unknown method "${request.method}"`);
				}
			} catch (error) {
				return err(
					id,
					INTERNAL_ERROR,
					error instanceof Error ? error.message : 'Internal error'
				);
			}
		}
	};
}

/**
 * MCP over HTTP POST — one JSON-RPC message per request. Drop this into a
 * Worker's fetch handler to expose a store to remote agents.
 */
export function createMcpFetchHandler(handler: McpHandler) {
	return async function fetchHandler(request: Request): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json(err(null, PARSE_ERROR, 'Invalid JSON'), { status: 400 });
		}

		// Batches are valid JSON-RPC and some clients send them.
		if (Array.isArray(body)) {
			const responses = (await Promise.all(body.map((m) => handler.handle(m)))).filter(
				(r): r is JsonRpcResponse => r !== null
			);
			return responses.length === 0
				? new Response(null, { status: 202 })
				: Response.json(responses);
		}

		const response = await handler.handle(body);
		return response === null ? new Response(null, { status: 202 }) : Response.json(response);
	};
}
