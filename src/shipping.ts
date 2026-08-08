/**
 * Shipping rates are store configuration, not framework policy. A host app
 * supplies its own table; these are only the defaults so a fresh install can
 * take an order without configuring anything.
 */
export type ShippingRate = {
	id: string;
	priceCents: number;
};

export const DEFAULT_SHIPPING_RATES: ShippingRate[] = [
	{ id: 'standard', priceCents: 0 },
	{ id: 'express', priceCents: 1200 }
];

export function resolveShippingCents(
	rates: ShippingRate[],
	methodId: string
): number | null {
	const rate = rates.find((r) => r.id === methodId);
	return rate ? rate.priceCents : null;
}
