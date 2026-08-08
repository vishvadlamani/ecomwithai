import { createClient, type Client } from '@libsql/client';
import { SCHEMA } from './schema.ts';

export type { Client };
export { SCHEMA };

export type DatabaseConfig = {
	url: string;
	authToken?: string;
};

/**
 * Config is passed in rather than read from the environment: this package has to
 * run unchanged inside a Worker, a Node process and a test, and those three read
 * their environment differently.
 */
export function createDb(config: DatabaseConfig): Client {
	return createClient(
		config.authToken ? { url: config.url, authToken: config.authToken } : { url: config.url }
	);
}

/**
 * SQLite serializes writers, and a loser gets SQLITE_BUSY rather than waiting.
 * Two customers checking out at the same instant is normal traffic, so callers
 * must not see a raw lock error.
 */
export function isBusyError(error: unknown): boolean {
	const code = (error as { code?: string } | null)?.code;
	if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
	const message = error instanceof Error ? error.message : String(error ?? '');
	return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

/**
 * Retries a unit of work while the database reports contention. Only busy
 * errors are retried — a domain failure must surface on the first attempt.
 *
 * The work must be idempotent or self-checking: it runs from the top each time.
 */
export async function withBusyRetry<T>(
	work: () => Promise<T>,
	options: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
	const attempts = options.attempts ?? 5;
	const base = options.baseDelayMs ?? 20;

	for (let attempt = 0; ; attempt += 1) {
		try {
			return await work();
		} catch (error) {
			if (attempt >= attempts - 1 || !isBusyError(error)) throw error;
			// Jittered backoff, or every loser retries in lockstep and collides again.
			const delay = base * 2 ** attempt * (0.5 + Math.random());
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

/** Splits the schema into executable statements, dropping comment-only chunks. */
export function schemaStatements(sql: string = SCHEMA): string[] {
	return sql
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s && !s.split('\n').every((line) => line.trim().startsWith('--')));
}

/**
 * Local SQLite defaults to `journal_mode=delete` and `busy_timeout=0`, so a
 * second writer fails instantly with SQLITE_BUSY instead of waiting — two
 * simultaneous checkouts is ordinary traffic, not an exceptional condition.
 *
 * WAL is a property of the database file and persists; busy_timeout is
 * per-connection, so call this once per client at startup. Both are no-ops
 * against remote Turso, which handles concurrency server-side.
 */
export async function configureConnection(
	db: Client,
	options: { busyTimeoutMs?: number; wal?: boolean } = {}
): Promise<void> {
	const timeout = Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000));
	try {
		await db.execute(`PRAGMA busy_timeout = ${timeout}`);
	} catch {
		/* remote or unsupported */
	}
	if (options.wal !== false) {
		try {
			await db.execute('PRAGMA journal_mode = WAL');
		} catch {
			/* remote or unsupported */
		}
	}
}

/** Idempotent — every statement is `create ... if not exists`. */
export async function applySchema(db: Client, sql: string = SCHEMA): Promise<number> {
	await configureConnection(db);
	const statements = schemaStatements(sql);
	for (const statement of statements) {
		await db.execute(statement);
	}
	return statements.length;
}
