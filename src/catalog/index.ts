import type { Client } from '../db/index.ts';

export type OptionValue = {
	value: string;
	label: string | null;
	swatchHex: string | null;
	/** Media attached to this specific value, if any (a colour swatch photo). */
	imageUrl: string | null;
};

export type ProductOption = {
	name: string;
	position: number;
	values: OptionValue[];
};

export type Variant = {
	id: number;
	sku: string;
	priceCents: number;
	compareAtCents: number | null;
	stock: number;
	/** Positional, matching `Product.options`. */
	options: (string | null)[];
};

export type Media = {
	url: string;
	alt: string | null;
	position: number;
	optionValue: string | null;
};

export type Product = {
	id: number;
	slug: string;
	title: string;
	subtitle: string | null;
	description: string | null;
	currency: string;
	/** Lowest variant price, so a caller can render "from" pricing. */
	priceCents: number;
	compareAtCents: number | null;
	options: ProductOption[];
	variants: Variant[];
	media: Media[];
	/** Keyed `namespace.key`; values are parsed JSON. */
	metafields: Record<string, unknown>;
};

export type ProductSummary = {
	id: number;
	slug: string;
	title: string;
	currency: string;
	priceCents: number;
	compareAtCents: number | null;
	imageUrl: string | null;
	inStock: boolean;
};

export type PricedVariant = {
	variantId: number;
	productId: number;
	productSlug: string;
	title: string;
	sku: string;
	options: (string | null)[];
	unitPriceCents: number;
	currency: string;
	stock: number;
};

export interface CatalogService {
	getProduct(slug: string, locale?: string): Promise<Product | null>;
	listProducts(opts?: {
		locale?: string;
		limit?: number;
		offset?: number;
	}): Promise<ProductSummary[]>;
	/**
	 * Resolves variant ids to server-side prices. Callers must never trust a
	 * price supplied by a client — this is the only source of truth.
	 */
	priceVariants(variantIds: number[]): Promise<Map<number, PricedVariant>>;
	/** Finds a variant by its option values, in option order. */
	findVariant(productId: number, options: (string | null)[]): Promise<Variant | null>;
	adjustStock(variantId: number, delta: number): Promise<number>;
}

const MAX_PAGE = 250;

function clampLimit(limit: number | undefined): number {
	if (!Number.isFinite(limit) || limit === undefined) return 50;
	return Math.max(1, Math.min(MAX_PAGE, Math.trunc(limit)));
}

export function createCatalogService(deps: {
	db: Client;
	storeId: string;
	/** Fallback when a product has no translation for the requested locale. */
	defaultLocale: string;
	currency: string;
}): CatalogService {
	const { db, storeId, defaultLocale, currency } = deps;

	/** Requested locale, then store default, then whatever exists. */
	async function translation(productId: number, locale: string) {
		const result = await db.execute({
			sql: `select locale, title, subtitle, description
			      from product_translations
			      where store_id = ? and product_id = ?
			      order by case locale when ? then 0 when ? then 1 else 2 end
			      limit 1`,
			args: [storeId, productId, locale, defaultLocale]
		});
		return result.rows[0] ?? null;
	}

	return {
		async getProduct(slug, locale = defaultLocale) {
			const productRows = await db.execute({
				sql: `select id, slug from products
				      where store_id = ? and slug = ? and status = 'active'`,
				args: [storeId, slug]
			});
			const row = productRows.rows[0];
			if (!row) return null;
			const id = Number(row.id);

			const [t, options, values, variants, media, metafields] = await Promise.all([
				translation(id, locale),
				db.execute({
					sql: `select id, name, position from product_options
					      where store_id = ? and product_id = ? order by position, id`,
					args: [storeId, id]
				}),
				db.execute({
					sql: `select v.option_id, v.value, v.label, v.swatch_hex, v.position,
					             (select m.url from product_media m
					              where m.option_value_id = v.id order by m.position, m.id limit 1) as image_url
					      from product_option_values v
					      join product_options o on o.id = v.option_id
					      where o.store_id = ? and o.product_id = ? order by v.position, v.id`,
					args: [storeId, id]
				}),
				db.execute({
					sql: `select id, sku, price_cents, compare_at_cents, stock, option1, option2, option3
					      from product_variants
					      where store_id = ? and product_id = ? order by position, id`,
					args: [storeId, id]
				}),
				db.execute({
					sql: `select url, alt, position, option_value_id from product_media
					      where store_id = ? and product_id = ? order by position, id`,
					args: [storeId, id]
				}),
				db.execute({
					sql: `select namespace, key, locale, value_json from product_metafields
					      where store_id = ? and product_id = ? and (locale is null or locale = ?)
					      order by case when locale is null then 1 else 0 end`,
					args: [storeId, id, locale]
				})
			]);

			const valuesByOption = new Map<number, OptionValue[]>();
			for (const v of values.rows) {
				const optionId = Number(v.option_id);
				const list = valuesByOption.get(optionId) ?? [];
				list.push({
					value: String(v.value),
					label: v.label === null ? null : String(v.label),
					swatchHex: v.swatch_hex === null ? null : String(v.swatch_hex),
					imageUrl: v.image_url === null ? null : String(v.image_url)
				});
				valuesByOption.set(optionId, list);
			}

			const parsedVariants: Variant[] = variants.rows.map((v) => ({
				id: Number(v.id),
				sku: String(v.sku),
				priceCents: Number(v.price_cents),
				compareAtCents: v.compare_at_cents === null ? null : Number(v.compare_at_cents),
				stock: Number(v.stock),
				options: [v.option1, v.option2, v.option3].map((o) =>
					o === null || o === undefined ? null : String(o)
				)
			}));

			// A product with no variants has no price; guard rather than emit NaN.
			const prices = parsedVariants.map((v) => v.priceCents);
			const cheapest = prices.length ? Math.min(...prices) : 0;
			const cheapestVariant = parsedVariants.find((v) => v.priceCents === cheapest);

			const parsedMetafields: Record<string, unknown> = {};
			for (const m of metafields.rows) {
				const key = `${String(m.namespace)}.${String(m.key)}`;
				// Locale-specific rows sort first, so don't let a null-locale row win.
				if (key in parsedMetafields) continue;
				try {
					parsedMetafields[key] = JSON.parse(String(m.value_json));
				} catch {
					parsedMetafields[key] = String(m.value_json);
				}
			}

			return {
				id,
				slug: String(row.slug),
				title: t ? String(t.title) : String(row.slug),
				subtitle: t && t.subtitle !== null ? String(t.subtitle) : null,
				description: t && t.description !== null ? String(t.description) : null,
				currency,
				priceCents: cheapest,
				compareAtCents: cheapestVariant?.compareAtCents ?? null,
				options: options.rows.map((o) => ({
					name: String(o.name),
					position: Number(o.position),
					values: valuesByOption.get(Number(o.id)) ?? []
				})),
				variants: parsedVariants,
				media: media.rows.map((m) => ({
					url: String(m.url),
					alt: m.alt === null ? null : String(m.alt),
					position: Number(m.position),
					optionValue: null
				})),
				metafields: parsedMetafields
			};
		},

		async listProducts(opts = {}) {
			const locale = opts.locale ?? defaultLocale;
			const limit = clampLimit(opts.limit);
			const offset = Math.max(0, Math.trunc(opts.offset ?? 0));

			const result = await db.execute({
				sql: `select p.id, p.slug,
				             coalesce(tl.title, td.title, p.slug) as title,
				             (select min(v.price_cents) from product_variants v where v.product_id = p.id) as price_cents,
				             (select sum(v.stock) from product_variants v where v.product_id = p.id) as total_stock,
				             (select m.url from product_media m where m.product_id = p.id
				              order by m.position, m.id limit 1) as image_url
				      from products p
				      left join product_translations tl on tl.product_id = p.id and tl.locale = ?
				      left join product_translations td on td.product_id = p.id and td.locale = ?
				      where p.store_id = ? and p.status = 'active'
				      order by p.position, p.id
				      limit ? offset ?`,
				args: [locale, defaultLocale, storeId, limit, offset]
			});

			return result.rows.map((r) => ({
				id: Number(r.id),
				slug: String(r.slug),
				title: String(r.title),
				currency,
				priceCents: r.price_cents === null ? 0 : Number(r.price_cents),
				compareAtCents: null,
				imageUrl: r.image_url === null ? null : String(r.image_url),
				inStock: Number(r.total_stock ?? 0) > 0
			}));
		},

		async priceVariants(variantIds) {
			const unique = [...new Set(variantIds)].filter((id) => Number.isInteger(id) && id > 0);
			if (unique.length === 0) return new Map();

			const placeholders = unique.map(() => '?').join(', ');
			const result = await db.execute({
				sql: `select v.id, v.sku, v.price_cents, v.stock, v.option1, v.option2, v.option3,
				             p.id as product_id, p.slug,
				             coalesce(td.title, p.slug) as title
				      from product_variants v
				      join products p on p.id = v.product_id
				      left join product_translations td on td.product_id = p.id and td.locale = ?
				      where v.store_id = ? and v.id in (${placeholders}) and p.status = 'active'`,
				args: [defaultLocale, storeId, ...unique]
			});

			return new Map(
				result.rows.map((r) => [
					Number(r.id),
					{
						variantId: Number(r.id),
						productId: Number(r.product_id),
						productSlug: String(r.slug),
						title: String(r.title),
						sku: String(r.sku),
						options: [r.option1, r.option2, r.option3].map((o) =>
							o === null || o === undefined ? null : String(o)
						),
						unitPriceCents: Number(r.price_cents),
						currency,
						stock: Number(r.stock)
					}
				])
			);
		},

		async findVariant(productId, options) {
			const [o1 = null, o2 = null, o3 = null] = options;
			const result = await db.execute({
				sql: `select id, sku, price_cents, compare_at_cents, stock, option1, option2, option3
				      from product_variants
				      where store_id = ? and product_id = ?
				        and option1 is ? and option2 is ? and option3 is ?`,
				args: [storeId, productId, o1, o2, o3]
			});
			const r = result.rows[0];
			if (!r) return null;
			return {
				id: Number(r.id),
				sku: String(r.sku),
				priceCents: Number(r.price_cents),
				compareAtCents: r.compare_at_cents === null ? null : Number(r.compare_at_cents),
				stock: Number(r.stock),
				options: [r.option1, r.option2, r.option3].map((o) =>
					o === null || o === undefined ? null : String(o)
				)
			};
		},

		async adjustStock(variantId, delta) {
			// Guarded so a negative delta can never drive stock below zero.
			const result = await db.execute({
				sql: `update product_variants set stock = stock + ?
				      where id = ? and store_id = ? and stock + ? >= 0
				      returning stock`,
				args: [delta, variantId, storeId, delta]
			});
			const row = result.rows[0];
			if (!row) throw new Error(`Cannot adjust variant ${variantId} by ${delta}`);
			return Number(row.stock);
		}
	};
}
