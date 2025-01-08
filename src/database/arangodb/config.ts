import { Database } from 'arangojs';
import { CreateCollectionOptions } from 'arangojs/collections';
import { ConfigOptions } from 'arangojs/configuration';
import { globalContext } from '../../config/global';
import { ProjectOptions } from '../../config/interfaces';
import { Logger } from '../../config/logging';
import { ArangoSearchConfiguration } from './schema-migration/arango-search-helpers';

export declare type KeyGeneratorType = 'traditional' | 'autoincrement' | 'uuid' | 'padded';

export const DEFAULT_RETRY_DELAY_BASE_MS = 100;
export const RETRY_DELAY_RANDOM_FRACTION = 0.5;

export interface ArangoDBConfig {
    /**
     * Additional configuration options that will be passed to the ArangoJS Database constructor
     */
    readonly arangoJSConfig?: Partial<ConfigOptions>;

    readonly url: string;
    readonly user?: string;
    readonly password?: string;

    /**
     * If set, this token will be sent using Authorization: Bearer
     */
    readonly authToken?: string;

    readonly databaseName: string;

    /**
     * Specifies if non mandatory migrations should be executed automatically. Defaults to true.
     */
    readonly doNonMandatoryMigrations?: boolean;

    /**
     * The memory limit in bytes to impose on ArangoDB queries (does not apply to the whole ArangoDB transaction).
     *
     * Can be overridden with the queryMemoryLimit option in ExecutionOptions
     */
    readonly queryMemoryLimit?: number;

    /**
     * The number of times a transaction that generated an optimistic locking error (ERROR_ARANGO_CONFLICT) will be
     * retried automatically. Defaults to zero.
     */
    readonly retriesOnConflict?: number;

    /**
     * The delay between the first and second retry attempt on conflict (see maxRetriesOnConflict). Will be doubled on
     * each retry. The delay between the first *try* and the first retry is always zero. Defaults to 100ms.
     */
    readonly retryDelayBaseMs?: number;

    /**
     * How many steps of recursive fields are indexed and allowed in queries for FlexSearch.
     */
    readonly arangoSearchConfiguration?: ArangoSearchConfiguration;

    /**
     * If set to `true`, collections will still be available for modifications during index creation.
     *
     * Background index creation can be slower and take more memory and should still be performed during times of
     * reduced load.
     */
    readonly createIndicesInBackground?: boolean;

    readonly createCollectionOptions?: CreateCollectionOptions;

    /**
     * A regular expression that matches index names that should not be deleted with migrations
     *
     * Indices without names will never be ignored.
     */
    readonly nonManagedIndexNamesPattern?: RegExp;
}

export function initDatabase(config: ArangoDBConfig): Database {
    const arangoJSConfig = config.arangoJSConfig ?? {};
    const db = new Database({
        ...arangoJSConfig,
        url: config.url,
        databaseName: config.databaseName,
        auth: config.user
            ? { username: config.user, password: config.password }
            : config.authToken
              ? { token: config.authToken }
              : arangoJSConfig.auth,
    });
    return db;
}

export function getArangoDBLogger(schemaContext: ProjectOptions | undefined): Logger {
    globalContext.registerContext(schemaContext);
    try {
        return globalContext.loggerProvider.getLogger('ArangoDBAdapter');
    } finally {
        globalContext.unregisterContext();
    }
}
