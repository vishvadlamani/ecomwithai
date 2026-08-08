import { withBusyRetry, type Client } from '../db/index.ts';
import type { Transaction } from '@libsql/client';

/** Anything that can run a statement — the client, or an open transaction. */
export type Executor = Client | Transaction;

export type Customer = {
	id: number;
	storeId: string;
	email: string;
	firstName: string | null;
	lastName: string | null;
	phone: string | null;
	marketingConsent: boolean;
	ordersCount: number;
	totalSpentCents: number;
	createdAt: string;
};

export type UpsertCustomerInput = {
	email: string;
	firstName?: string;
	lastName?: string;
	phone?: string;
	marketingConsent?: boolean;
};

export interface CustomerService {
	/**
	 * Finds or creates the customer for an email. Takes an executor so it can run
	 * inside the order transaction — a customer must not survive an order that
	 * then rolls back.
	 */
	upsert(input: UpsertCustomerInput, executor?: Executor): Promise<number>;
	byEmail(email: string): Promise<Customer | null>;
	byId(id: number): Promise<Customer | null>;
	list(opts?: { limit?: number; offset?: number }): Promise<Customer[]>;
	/** Rolls up lifetime totals. Called inside the order transaction. */
	recordOrder(customerId: number, totalCents: number, executor?: Executor): Promise<void>;
}

/** Stored lowercase so the (store_id, email) unique constraint actually holds. */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function toCustomer(row: Record<string, unknown>): Customer {
	return {
		id: Number(row.id),
		storeId: String(row.store_id),
		email: String(row.email),
		firstName: row.first_name === null ? null : String(row.first_name),
		lastName: row.last_name === null ? null : String(row.last_name),
		phone: row.phone === null ? null : String(row.phone),
		marketingConsent: Number(row.marketing_consent) === 1,
		ordersCount: Number(row.orders_count),
		totalSpentCents: Number(row.total_spent_cents),
		createdAt: String(row.created_at)
	};
}

const COLUMNS = `id, store_id, email, first_name, last_name, phone,
                 marketing_consent, orders_count, total_spent_cents, created_at`;

export function createCustomerService(deps: { db: Client; storeId: string }): CustomerService {
	const { db, storeId } = deps;

	return {
		async upsert(input, executor = db) {
			const email = normalizeEmail(input.email);
			// Only a standalone call may retry: inside a transaction the caller owns
			// the retry, and re-running one statement would corrupt its sequencing.
			const run = executor === db ? withBusyRetry : (w: () => Promise<number>) => w();

			// Only overwrite names with non-empty values: a guest checkout that omits
			// a field must not blank out what an earlier order supplied.
			return run(async () => {
			const result = await executor.execute({
				sql: `insert into customers
				        (store_id, email, first_name, last_name, phone, marketing_consent)
				      values (?, ?, ?, ?, ?, ?)
				      on conflict (store_id, email) do update set
				        first_name = coalesce(excluded.first_name, customers.first_name),
				        last_name  = coalesce(excluded.last_name,  customers.last_name),
				        phone      = coalesce(excluded.phone,      customers.phone),
				        marketing_consent = max(customers.marketing_consent, excluded.marketing_consent),
				        updated_at = datetime('now')
				      returning id`,
				args: [
					storeId,
					email,
					input.firstName?.trim() || null,
					input.lastName?.trim() || null,
					input.phone?.trim() || null,
					input.marketingConsent ? 1 : 0
				]
			});

			return Number(result.rows[0].id);
			});
		},

		async byEmail(email) {
			const result = await db.execute({
				sql: `select ${COLUMNS} from customers where store_id = ? and email = ?`,
				args: [storeId, normalizeEmail(email)]
			});
			const row = result.rows[0];
			return row ? toCustomer(row as Record<string, unknown>) : null;
		},

		async byId(id) {
			const result = await db.execute({
				sql: `select ${COLUMNS} from customers where store_id = ? and id = ?`,
				args: [storeId, id]
			});
			const row = result.rows[0];
			return row ? toCustomer(row as Record<string, unknown>) : null;
		},

		async list(opts = {}) {
			const limit = Math.max(1, Math.min(250, Math.trunc(opts.limit ?? 50)));
			const offset = Math.max(0, Math.trunc(opts.offset ?? 0));
			const result = await db.execute({
				sql: `select ${COLUMNS} from customers where store_id = ?
				      order by created_at desc, id desc limit ? offset ?`,
				args: [storeId, limit, offset]
			});
			return result.rows.map((r) => toCustomer(r as Record<string, unknown>));
		},

		async recordOrder(customerId, totalCents, executor = db) {
			const run = executor === db ? withBusyRetry : (w: () => Promise<void>) => w();
			await run(async () => {
			await executor.execute({
				sql: `update customers
				      set orders_count = orders_count + 1,
				          total_spent_cents = total_spent_cents + ?,
				          updated_at = datetime('now')
				      where id = ? and store_id = ?`,
				args: [totalCents, customerId, storeId]
			});
			});
		}
	};
}
