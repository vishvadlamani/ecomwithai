import type { Client } from '../db/index.ts';

export type Store = {
	id: string;
	domain: string;
	name: string;
	defaultLocale: string;
	currency: string;
};

export interface StoreService {
	byDomain(domain: string): Promise<Store | null>;
	byId(id: string): Promise<Store | null>;
	list(): Promise<Store[]>;
	/** Free-form per-store config: analytics ids, feature flags, and so on. */
	settings(storeId: string): Promise<Record<string, string>>;
	setSetting(storeId: string, key: string, value: string | null): Promise<void>;
}

function toStore(row: Record<string, unknown>): Store {
	return {
		id: String(row.id),
		domain: String(row.domain),
		name: String(row.name),
		defaultLocale: String(row.default_locale),
		currency: String(row.currency)
	};
}

const SELECT = `select id, domain, name, default_locale, currency
                from stores where active = 1`;

export function createStoreService(db: Client): StoreService {
	return {
		async byDomain(domain) {
			// Host headers carry a port in development; stored domains never do.
			const host = domain.toLowerCase().split(':')[0];
			const result = await db.execute({ sql: `${SELECT} and domain = ?`, args: [host] });
			const row = result.rows[0];
			return row ? toStore(row as Record<string, unknown>) : null;
		},

		async byId(id) {
			const result = await db.execute({ sql: `${SELECT} and id = ?`, args: [id] });
			const row = result.rows[0];
			return row ? toStore(row as Record<string, unknown>) : null;
		},

		async list() {
			const result = await db.execute(`${SELECT} order by id`);
			return result.rows.map((r) => toStore(r as Record<string, unknown>));
		},

		async settings(storeId) {
			const result = await db.execute({
				sql: 'select key, value from store_settings where store_id = ?',
				args: [storeId]
			});
			return Object.fromEntries(
				result.rows.map((r) => [String(r.key), r.value === null ? '' : String(r.value)])
			);
		},

		async setSetting(storeId, key, value) {
			if (value === null) {
				await db.execute({
					sql: 'delete from store_settings where store_id = ? and key = ?',
					args: [storeId, key]
				});
				return;
			}
			await db.execute({
				sql: `insert into store_settings (store_id, key, value) values (?, ?, ?)
				      on conflict (store_id, key) do update set value = excluded.value`,
				args: [storeId, key, value]
			});
		}
	};
}
