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

/** Splits the schema into executable statements, dropping comment-only chunks. */
export function schemaStatements(sql: string = SCHEMA): string[] {
	return sql
		.split(';')
		.map((s) => s.trim())
		.filter((s) => s && !s.split('\n').every((line) => line.trim().startsWith('--')));
}

/** Idempotent — every statement is `create ... if not exists`. */
export async function applySchema(db: Client, sql: string = SCHEMA): Promise<number> {
	const statements = schemaStatements(sql);
	for (const statement of statements) {
		await db.execute(statement);
	}
	return statements.length;
}
