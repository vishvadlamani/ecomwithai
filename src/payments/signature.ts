/**
 * Stripe webhook signature verification.
 *
 * This is the boundary between "a request arrived" and "Stripe said this
 * happened". Anyone can POST to a webhook URL, so an unverified handler that
 * marks orders paid is a free-money bug. Implemented with Web Crypto so it runs
 * on Workers, Node, Deno and Bun alike.
 */

export type SignatureResult =
	| { valid: true; timestamp: number }
	| { valid: false; reason: SignatureFailure };

export type SignatureFailure =
	| 'missing_header'
	| 'malformed_header'
	| 'missing_timestamp'
	| 'no_signatures'
	| 'timestamp_out_of_tolerance'
	| 'no_matching_signature';

const DEFAULT_TOLERANCE_SECONDS = 300;

/** Length-independent comparison so a mismatch leaks no position information. */
function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verifies a `Stripe-Signature` header against the raw request body.
 *
 * The body must be the exact bytes received — parsing and re-serializing JSON
 * changes key order and whitespace, and the signature will never match.
 */
export async function verifyStripeSignature(input: {
	/** Raw request body, before any JSON parsing. */
	payload: string;
	/** The `Stripe-Signature` header value. */
	header: string | null | undefined;
	/** Endpoint signing secret (`whsec_...`). */
	secret: string;
	toleranceSeconds?: number;
	/** Injectable so tests do not depend on the wall clock. */
	nowSeconds?: number;
}): Promise<SignatureResult> {
	if (!input.header) return { valid: false, reason: 'missing_header' };

	let timestamp: number | null = null;
	// Stripe sends every active secret's signature during rotation, so more than
	// one v1 is normal and any single match is sufficient.
	const signatures: string[] = [];

	for (const part of input.header.split(',')) {
		const index = part.indexOf('=');
		if (index === -1) return { valid: false, reason: 'malformed_header' };
		const key = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (key === 't') {
			const parsed = Number(value);
			if (!Number.isFinite(parsed)) return { valid: false, reason: 'missing_timestamp' };
			timestamp = parsed;
		} else if (key === 'v1') {
			signatures.push(value);
		}
	}

	if (timestamp === null) return { valid: false, reason: 'missing_timestamp' };
	if (signatures.length === 0) return { valid: false, reason: 'no_signatures' };

	// Replay protection: a captured request stays validly signed forever without
	// a freshness bound.
	const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (Math.abs(now - timestamp) > tolerance) {
		return { valid: false, reason: 'timestamp_out_of_tolerance' };
	}

	const expected = await hmacSha256Hex(input.secret, `${timestamp}.${input.payload}`);

	// Compare against every candidate rather than short-circuiting on the first,
	// so the work done does not depend on which one matches.
	let matched = false;
	for (const candidate of signatures) {
		if (timingSafeEqual(expected, candidate)) matched = true;
	}

	return matched ? { valid: true, timestamp } : { valid: false, reason: 'no_matching_signature' };
}

/** Builds a header the way Stripe does — used by tests and local tooling. */
export async function signStripePayload(
	secret: string,
	payload: string,
	timestamp: number
): Promise<string> {
	const signature = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
	return `t=${timestamp},v1=${signature}`;
}
