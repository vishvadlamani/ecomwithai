import type { Commerce } from '../index.ts';
import { TOOLS, type ToolDefinition } from './tools.ts';
import { validate, ValidationError, type JsonSchema } from './validate.ts';

export { TOOLS, ValidationError };
export type { ToolDefinition, JsonSchema };

/** Shape an MCP `tools/list` response expects — no handler, no internals. */
export type ToolManifestEntry = {
	name: string;
	title: string;
	description: string;
	readOnly: boolean;
	inputSchema: JsonSchema;
};

export type ToolResult =
	| { ok: true; result: unknown }
	| { ok: false; error: string; code: 'unknown_tool' | 'invalid_arguments' | 'failed' };

export type ToolkitOptions = {
	/**
	 * Defaults to false. Leaving writes off gives an agent a browsing-only view
	 * of the store, which is the right default for anything customer-facing.
	 */
	allowWrites?: boolean;
	/** Restrict to a named subset. */
	only?: string[];
};

export interface AgentToolkit {
	list(): ToolManifestEntry[];
	call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * Wraps a `Commerce` instance as a set of agent-callable tools.
 *
 * Arguments are validated against each tool's schema before reaching the domain
 * layer, and failures come back as values rather than exceptions so a caller can
 * hand the message straight to the model and let it retry.
 */
export function createAgentToolkit(
	commerce: Commerce,
	options: ToolkitOptions = {}
): AgentToolkit {
	const allowWrites = options.allowWrites ?? false;

	const available = TOOLS.filter((tool) => {
		if (!allowWrites && !tool.readOnly) return false;
		if (options.only && !options.only.includes(tool.name)) return false;
		return true;
	});

	const byName = new Map(available.map((tool) => [tool.name, tool]));

	return {
		list() {
			return available.map(({ name, title, description, readOnly, inputSchema }) => ({
				name,
				title,
				description,
				readOnly,
				inputSchema
			}));
		},

		async call(name, args = {}) {
			const tool = byName.get(name);
			if (!tool) {
				const known = [...byName.keys()].join(', ');
				return {
					ok: false,
					code: 'unknown_tool',
					error: `Unknown tool "${name}". Available: ${known || '(none)'}`
				};
			}

			let parsed: Record<string, unknown>;
			try {
				parsed = validate(tool.inputSchema, args ?? {}) as Record<string, unknown>;
			} catch (error) {
				if (error instanceof ValidationError) {
					return { ok: false, code: 'invalid_arguments', error: error.message };
				}
				throw error;
			}

			try {
				return { ok: true, result: await tool.handler(commerce, parsed) };
			} catch (error) {
				return {
					ok: false,
					code: 'failed',
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
	};
}
