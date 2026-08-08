import { buildUserData, type CapiUserInput } from './hash.ts';

export * from './hash.ts';

const DEFAULT_API_VERSION = 'v25.0';
const DEFAULT_ENDPOINT = 'https://graph.facebook.com';

export type MetaEventName =
	| 'PageView'
	| 'ViewContent'
	| 'AddToCart'
	| 'InitiateCheckout'
	| 'Purchase';

export type MetaCustomData = {
	currency?: string;
	value?: string;
	content_type?: 'product' | 'product_group';
	content_ids?: string[];
	contents?: { id: string; quantity: number; item_price?: number }[];
	num_items?: number;
};

/** Per-store: every storefront has its own pixel and its own access token. */
export type MetaConfig = {
	pixelId: string;
	accessToken?: string;
	apiVersion?: string;
	/** Override for a CAPI Gateway, a proxy, or a test capture server. */
	endpoint?: string;
	testEventCode?: string;
	attributionShare?: string;
};

export type CapiEvent = {
	eventName: MetaEventName;
	eventId: string;
	eventTime?: number;
	eventSourceUrl?: string;
	user: CapiUserInput;
	customData?: MetaCustomData;
};

export type CapiResult =
	| { sent: true; response: unknown }
	| { sent: false; reason: 'not_configured' | 'request_failed'; detail?: string };

export interface MetaService {
	isConfigured(): boolean;
	/** Split out so tests can assert the body without a network call. */
	buildEventPayload(event: CapiEvent): Promise<Record<string, unknown>>;
	send(event: CapiEvent): Promise<CapiResult>;
}

/** Meta wants value as a decimal string, and cents-to-currency must not drift. */
export function toAmount(cents: number): string {
	return (cents / 100).toFixed(2);
}

/**
 * Shared id for one logical conversion. The browser and the server both send the
 * event with this id so Meta counts it once instead of twice.
 */
export function newEventId(): string {
	return crypto.randomUUID();
}

/** The `fbc` value Meta expects when a visitor lands with `?fbclid=`. */
export function buildFbc(fbclid: string, createdAt: number): string {
	return `fb.1.${createdAt}.${fbclid}`;
}

export function createMetaService(config: MetaConfig): MetaService {
	return {
		isConfigured() {
			return Boolean(config.accessToken);
		},

		async buildEventPayload(event) {
			const eventTime = event.eventTime ?? Math.floor(Date.now() / 1000);

			const payload: Record<string, unknown> = {
				event_name: event.eventName,
				event_time: eventTime,
				event_id: event.eventId,
				action_source: 'website',
				user_data: await buildUserData(event.user),
				original_event_data: { event_name: event.eventName, event_time: eventTime }
			};

			if (event.eventSourceUrl) payload.event_source_url = event.eventSourceUrl;
			if (event.customData) payload.custom_data = event.customData;
			if (config.attributionShare) {
				payload.attribution_data = { attribution_share: config.attributionShare };
			}

			return payload;
		},

		/** Never throws: a marketing pixel must not be able to fail an order. */
		async send(event) {
			if (!config.accessToken) return { sent: false, reason: 'not_configured' };

			const version = config.apiVersion || DEFAULT_API_VERSION;
			const endpoint = config.endpoint || DEFAULT_ENDPOINT;
			const payload = await this.buildEventPayload(event);

			const body: Record<string, unknown> = {
				data: [payload],
				access_token: config.accessToken
			};
			if (config.testEventCode) body.test_event_code = config.testEventCode;

			try {
				const response = await fetch(`${endpoint}/${version}/${config.pixelId}/events`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				});
				const parsed = await response.json().catch(() => null);

				if (!response.ok) {
					console.error('Meta CAPI rejected event', response.status, parsed);
					return { sent: false, reason: 'request_failed', detail: `HTTP ${response.status}` };
				}
				return { sent: true, response: parsed };
			} catch (error) {
				console.error('Meta CAPI request failed', error);
				return { sent: false, reason: 'request_failed', detail: String(error) };
			}
		}
	};
}
