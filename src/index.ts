/**
 * ecomwithai — headless commerce built so AI agents are first-class clients.
 *
 * Every module is exposed as an interface with a local, in-process
 * implementation. Callers depend on the interface, never the implementation, so
 * moving a module behind a network boundary later means writing a second
 * implementation and swapping it at this composition point — no call site
 * changes.
 *
 * Nothing here imports a framework or reads `process.env`: configuration is
 * injected, because a Worker, a Node process and a test read their environment
 * differently.
 */
import { createCatalogService, type CatalogService } from './catalog/index.ts';
import { createCustomerService, type CustomerService } from './customers/index.ts';
import { createDb, type Client, type DatabaseConfig } from './db/index.ts';
import { createMetaService, type MetaConfig, type MetaService } from './marketing/index.ts';
import { createOrderService, type OrderService } from './orders/index.ts';
import { createStoreService, type Store, type StoreService } from './stores/index.ts';
import type { ShippingRate } from './shipping.ts';

export type { Client, DatabaseConfig } from './db/index.ts';
export {
	createDb,
	applySchema,
	configureConnection,
	schemaStatements,
	withBusyRetry,
	isBusyError,
	SCHEMA
} from './db/index.ts';
export type { Store, StoreService } from './stores/index.ts';
export { createStoreService } from './stores/index.ts';
export type {
	CatalogService,
	Product,
	ProductSummary,
	ProductOption,
	OptionValue,
	Variant,
	PricedVariant
} from './catalog/index.ts';
export type { CustomerService, Customer } from './customers/index.ts';
export type { OrderService, Order, OrderItem, CreateOrderInput } from './orders/index.ts';
export { CheckoutError, type CheckoutErrorCode } from './orders/index.ts';
export {
	DEFAULT_SHIPPING_RATES,
	resolveShippingCents,
	type ShippingRate
} from './shipping.ts';
export {
	createMetaService,
	newEventId,
	toAmount,
	buildFbc,
	type MetaConfig,
	type MetaService
} from './marketing/index.ts';

export type Commerce = {
	db: Client;
	store: Store;
	catalog: CatalogService;
	customers: CustomerService;
	orders: OrderService;
	/** Null unless a pixel id is configured for this store. */
	meta: MetaService | null;
};

/**
 * Resolves which tenant a request belongs to. Called before `createCommerce`,
 * since the store is what scopes every other module.
 */
export function createDirectory(config: DatabaseConfig): {
	db: Client;
	stores: StoreService;
} {
	const db = createDb(config);
	return { db, stores: createStoreService(db) };
}

export type CommerceConfig = {
	db: Client;
	store: Store;
	shippingRates?: ShippingRate[];
	orderNumberPrefix?: string;
	meta?: Omit<MetaConfig, 'pixelId'> & { pixelId?: string };
};

export function createCommerce(config: CommerceConfig): Commerce {
	const { db, store } = config;
	const storeId = store.id;

	const catalog = createCatalogService({
		db,
		storeId,
		defaultLocale: store.defaultLocale,
		currency: store.currency
	});
	const customers = createCustomerService({ db, storeId });
	const orders = createOrderService({
		db,
		storeId,
		currency: store.currency,
		catalog,
		customers,
		defaultLocale: store.defaultLocale,
		shippingRates: config.shippingRates,
		orderNumberPrefix: config.orderNumberPrefix
	});

	const pixelId = config.meta?.pixelId;
	const meta = pixelId ? createMetaService({ ...config.meta, pixelId }) : null;

	return { db, store, catalog, customers, orders, meta };
}
