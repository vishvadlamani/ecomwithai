/**
 * Minimal JSON Schema validation for tool arguments.
 *
 * Deliberately dependency-free and deliberately strict. Tool arguments arrive
 * from a language model, which means they are untrusted input that happens to
 * look well-formed most of the time: wrong types, invented fields, numbers as
 * strings, quantities of -1. Everything below assumes that.
 */

export type JsonSchema = {
	type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: string[];
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	default?: unknown;
	additionalProperties?: boolean;
};

export class ValidationError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(path ? `${path}: ${message}` : message);
		this.name = 'ValidationError';
		this.path = path;
	}
}

function fail(path: string, message: string): never {
	throw new ValidationError(path, message);
}

export function validate(schema: JsonSchema, value: unknown, path = ''): unknown {
	if (value === undefined || value === null) {
		if (schema.default !== undefined) return schema.default;
		fail(path, 'is required');
	}

	switch (schema.type) {
		case 'object': {
			if (typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
			const input = value as Record<string, unknown>;
			const out: Record<string, unknown> = {};

			for (const key of schema.required ?? []) {
				if (input[key] === undefined || input[key] === null) {
					fail(path ? `${path}.${key}` : key, 'is required');
				}
			}
			for (const [key, sub] of Object.entries(schema.properties ?? {})) {
				const child = path ? `${path}.${key}` : key;
				if (input[key] === undefined || input[key] === null) {
					if (sub.default !== undefined) out[key] = sub.default;
					continue;
				}
				out[key] = validate(sub, input[key], child);
			}
			// Unknown keys are dropped rather than rejected: models routinely invent
			// plausible extras, and failing the whole call over one is unhelpful.
			return out;
		}

		case 'array': {
			if (!Array.isArray(value)) fail(path, 'must be an array');
			if (schema.minItems !== undefined && value.length < schema.minItems) {
				fail(path, `must have at least ${schema.minItems} item(s)`);
			}
			if (schema.maxItems !== undefined && value.length > schema.maxItems) {
				fail(path, `must have at most ${schema.maxItems} item(s)`);
			}
			return schema.items
				? value.map((item, i) => validate(schema.items!, item, `${path}[${i}]`))
				: value;
		}

		case 'integer':
		case 'number': {
			// Models often send "3" where 3 was meant; accept it, but only when the
			// string is unambiguously numeric.
			const n =
				typeof value === 'number'
					? value
					: typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
						? Number(value)
						: NaN;
			if (!Number.isFinite(n)) fail(path, 'must be a number');
			if (schema.type === 'integer' && !Number.isInteger(n)) fail(path, 'must be an integer');
			if (schema.minimum !== undefined && n < schema.minimum) {
				fail(path, `must be >= ${schema.minimum}`);
			}
			if (schema.maximum !== undefined && n > schema.maximum) {
				fail(path, `must be <= ${schema.maximum}`);
			}
			return n;
		}

		case 'boolean': {
			if (typeof value === 'boolean') return value;
			if (value === 'true') return true;
			if (value === 'false') return false;
			fail(path, 'must be a boolean');
			break;
		}

		case 'string':
		default: {
			if (typeof value !== 'string') fail(path, 'must be a string');
			if (schema.enum && !schema.enum.includes(value)) {
				fail(path, `must be one of: ${schema.enum.join(', ')}`);
			}
			if (schema.minLength !== undefined && value.length < schema.minLength) {
				fail(path, `must be at least ${schema.minLength} characters`);
			}
			if (schema.maxLength !== undefined && value.length > schema.maxLength) {
				fail(path, `must be at most ${schema.maxLength} characters`);
			}
			return value;
		}
	}
}
