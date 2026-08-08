/**
 * Fixtures for tests and demos. Exported because anyone adopting the framework
 * needs a way to stand up a store with realistic shape in one call.
 */
import { applySchema, createDb, type Client } from './db/index.ts';

export type SeedProductInput = {
	slug: string;
	title: string;
	description?: string;
	/** In option order; up to three axes. */
	options?: { name: string; values: { value: string; swatchHex?: string }[] }[];
	/** Option values in the same order as `options`; omit for a single-variant product. */
	variants: {
		sku: string;
		priceCents: number;
		compareAtCents?: number;
		stock: number;
		options?: (string | null)[];
	}[];
	media?: { url: string; alt?: string; optionValue?: string }[];
	metafields?: { namespace: string; key: string; value: unknown; locale?: string }[];
	locale?: string;
};

export async function seedStore(
	db: Client,
	store: { id: string; domain: string; name?: string; locale?: string; currency?: string }
): Promise<void> {
	await db.execute({
		sql: `insert into stores (id, domain, name, default_locale, currency)
		      values (?, ?, ?, ?, ?)
		      on conflict (id) do update set
		        domain = excluded.domain, name = excluded.name,
		        default_locale = excluded.default_locale, currency = excluded.currency`,
		args: [
			store.id,
			store.domain,
			store.name ?? store.id,
			store.locale ?? 'en',
			store.currency ?? 'USD'
		]
	});
}

export async function seedProduct(
	db: Client,
	storeId: string,
	input: SeedProductInput
): Promise<{ productId: number; variantIds: Record<string, number> }> {
	const locale = input.locale ?? 'en';

	await db.execute({
		sql: 'delete from products where store_id = ? and slug = ?',
		args: [storeId, input.slug]
	});

	const product = await db.execute({
		sql: `insert into products (store_id, slug, status) values (?, ?, 'active')`,
		args: [storeId, input.slug]
	});
	const productId = Number(product.lastInsertRowid);

	await db.execute({
		sql: `insert into product_translations (store_id, product_id, locale, title, description)
		      values (?, ?, ?, ?, ?)`,
		args: [storeId, productId, locale, input.title, input.description ?? null]
	});

	const valueIds = new Map<string, number>();
	for (const [i, option] of (input.options ?? []).entries()) {
		const row = await db.execute({
			sql: `insert into product_options (store_id, product_id, name, position) values (?, ?, ?, ?)`,
			args: [storeId, productId, option.name, i]
		});
		const optionId = Number(row.lastInsertRowid);
		for (const [j, value] of option.values.entries()) {
			const v = await db.execute({
				sql: `insert into product_option_values (store_id, option_id, value, swatch_hex, position)
				      values (?, ?, ?, ?, ?)`,
				args: [storeId, optionId, value.value, value.swatchHex ?? null, j]
			});
			valueIds.set(value.value, Number(v.lastInsertRowid));
		}
	}

	const variantIds: Record<string, number> = {};
	for (const [i, variant] of input.variants.entries()) {
		const [o1 = null, o2 = null, o3 = null] = variant.options ?? [];
		const row = await db.execute({
			sql: `insert into product_variants
			        (store_id, product_id, sku, price_cents, compare_at_cents, stock, position,
			         option1, option2, option3)
			      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			args: [
				storeId,
				productId,
				variant.sku,
				variant.priceCents,
				variant.compareAtCents ?? null,
				variant.stock,
				i,
				o1,
				o2,
				o3
			]
		});
		variantIds[variant.sku] = Number(row.lastInsertRowid);
	}

	for (const [i, media] of (input.media ?? []).entries()) {
		await db.execute({
			sql: `insert into product_media (store_id, product_id, url, alt, position, option_value_id)
			      values (?, ?, ?, ?, ?, ?)`,
			args: [
				storeId,
				productId,
				media.url,
				media.alt ?? null,
				i,
				media.optionValue ? (valueIds.get(media.optionValue) ?? null) : null
			]
		});
	}

	for (const meta of input.metafields ?? []) {
		await db.execute({
			sql: `insert into product_metafields (store_id, product_id, namespace, key, locale, value_json)
			      values (?, ?, ?, ?, ?, ?)`,
			args: [
				storeId,
				productId,
				meta.namespace,
				meta.key,
				meta.locale ?? null,
				JSON.stringify(meta.value)
			]
		});
	}

	return { productId, variantIds };
}

/**
 * A throwaway database with the schema applied.
 *
 * Pass a `file:` URL, not `:memory:`. libSQL gives a transaction its own
 * connection, and with `:memory:` that is a *different* database — the schema
 * vanishes the moment anything commits, which surfaces later as a baffling
 * "no such table" on a table you just used.
 */
export async function createTestDb(url: string): Promise<Client> {
	if (url === ':memory:' || url === 'file::memory:') {
		throw new Error(
			'createTestDb needs a file: URL — libSQL transactions do not share an in-memory database'
		);
	}
	const db = createDb({ url });
	await applySchema(db);
	return db;
}
