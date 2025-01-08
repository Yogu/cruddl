import { Database } from 'arangojs';
import { v4 as uuid } from 'uuid';
import { globalContext } from '../../config/global';
import { ProjectOptions } from '../../config/interfaces';
import { Logger } from '../../config/logging';
import { ExecutionOptions } from '../../execution/execution-options';
import {
    ConflictRetriesExhaustedError,
    TransactionCancelledError,
    TransactionTimeoutError,
} from '../../execution/runtime-errors';
import { TransactionError } from '../../execution/transaction-error';
import { Model } from '../../model';
import { ALL_QUERY_RESULT_VALIDATOR_FUNCTION_PROVIDERS, QueryNode } from '../../query-tree';
import { FlexSearchTokenization } from '../../query-tree/flex-search';
import { Mutable } from '../../utils/util-types';
import { objectValues, sleep, sleepInterruptible } from '../../utils/utils';
import { getPreciseTime, Watch } from '../../utils/watch';
import {
    DatabaseAdapter,
    DatabaseAdapterTimings,
    ExecutionArgs,
    ExecutionPlan,
    ExecutionResult,
    FlexSearchTokenizable,
    TransactionStats,
} from '../database-adapter';
import { AQLCompoundQuery, aqlConfig, AQLExecutableQuery } from './aql';
import { generateTokenizationQuery, getAQLQuery } from './aql-generator';
import { CancellationManager } from './cancellation-manager';
import {
    ArangoDBConfig,
    DEFAULT_RETRY_DELAY_BASE_MS,
    getArangoDBLogger,
    initDatabase,
    RETRY_DELAY_RANDOM_FRACTION,
} from './config';
import { ERROR_ARANGO_CONFLICT, ERROR_QUERY_KILLED } from './error-codes';
import { hasRevisionAssertions } from './revision-helper';
import { SchemaAnalyzer } from './schema-migration/analyzer';
import { SchemaMigration } from './schema-migration/migrations';
import { MigrationPerformer } from './schema-migration/performer';
import { ArangoDBVersion, ArangoDBVersionHelper } from './version-helper';

interface ArangoExecutionOptions {
    readonly queries: ReadonlyArray<AQLExecutableQuery>;
    readonly options: ExecutionOptions;
    /**
     * An ID that will be prepended to all queries in this transaction so they can be aborted on cancellation
     */
    readonly transactionID: string;
}

interface ArangoError extends Error {
    readonly errorNum?: number;
    readonly errorMessage?: string;
}

function isArangoError(error: Error): error is ArangoError {
    return 'errorNum' in error;
}

interface ArangoTransactionResult {
    readonly data?: any;
    readonly error?: ArangoError;
    readonly timings?: { readonly [key: string]: number };
    readonly plans?: ReadonlyArray<any>;
    readonly stats: TransactionStats;
}

interface TransactionResult {
    readonly data?: any;
    readonly timings?: Pick<DatabaseAdapterTimings, 'database' | 'dbConnection'>;
    readonly plans?: ReadonlyArray<any>;
    readonly databaseError?: Error;
    readonly stats: TransactionStats;

    /**
     * True if the transactionTimeoutMs has taken effect. Does not necessarily mean that the query has been killed,
     * you should check databaseError for his.
     */
    readonly hasTimedOut: boolean;

    /**
     * True if the cancellationToken has taken effect. Does not necessarily mean that the query has been killed,
     * you should check databaseError for his.
     */
    readonly wasCancelled: boolean;
}

export class ArangoDBAdapter implements DatabaseAdapter {
    private readonly db: Database;
    private readonly logger: Logger;
    private readonly analyzer: SchemaAnalyzer;
    private readonly migrationPerformer: MigrationPerformer;
    private readonly cancellationManager: CancellationManager;
    private readonly versionHelper: ArangoDBVersionHelper;
    private readonly doNonMandatoryMigrations: boolean;
    private readonly arangoExecutionFunction: string;

    constructor(
        private readonly config: ArangoDBConfig,
        private schemaContext?: ProjectOptions,
    ) {
        this.logger = getArangoDBLogger(schemaContext);
        this.db = initDatabase({
            ...config,
            arangoJSConfig: {
                ...(config.arangoJSConfig ?? {
                    beforeRequest: (req) => {
                        req.headers;
                    },
                }),
            },
        });
        this.analyzer = new SchemaAnalyzer(config, schemaContext);
        this.migrationPerformer = new MigrationPerformer(config);
        this.versionHelper = new ArangoDBVersionHelper(this.db);
        this.arangoExecutionFunction = this.buildUpArangoExecutionFunction();
        // the cancellation manager gets its own database instance so its cancellation requests are not queued
        this.cancellationManager = new CancellationManager({ database: initDatabase(config) });
        this.doNonMandatoryMigrations = config.doNonMandatoryMigrations !== false; // defaults to true
    }

    /**
     * Gets the javascript source code for a function that executes a transaction
     * @returns {string}
     */
    private buildUpArangoExecutionFunction(): string {
        // The following function will be translated to a string and executed (as one transaction) within the
        // ArangoDB server itself. Therefore the next comment is necessary to instruct our test coverage tool
        // (https://github.com/istanbuljs/nyc) not to instrument the code with coverage instructions.

        /* istanbul ignore next */
        const arangoExecutionFunction = function ({
            queries,
            options,
            transactionID,
        }: ArangoExecutionOptions) {
            const db = require('@arangodb').db;
            const enableProfiling = options.recordTimings;
            const internal = enableProfiling ? require('internal') : undefined;

            function getPreciseTime() {
                return internal.time();
            }

            const startTime = enableProfiling ? getPreciseTime() : 0;

            let validators: { [name: string]: (validationData: any, result: any) => void } = {};
            //inject_validators_here

            let timings: { [key: string]: number } | undefined = enableProfiling ? {} : undefined;
            let timingsTotal = 0;

            let plans: any[] = [];

            let transactionStats: Mutable<TransactionStats> = {};

            /**
             * Throws an error so that the transaction is rolled back and returns the given value as transaction result
             */
            function rollbackWithResult(transactionResult: any): never {
                const error = new Error(`${JSON.stringify(transactionResult)}`);
                error.name = 'RolledBackTransactionError';
                throw error;
            }

            function rollbackWithError(error: any): never {
                if (enableProfiling && timings) {
                    timings.js = getPreciseTime() - startTime - timingsTotal;
                }

                // the return is here to please typescript, it actually returns *never* (it throws)
                return rollbackWithResult({
                    error,
                    timings,
                    plans,
                    stats: transactionStats,
                });
            }

            let resultHolder: { [p: string]: any } = {};
            for (const query of queries) {
                const bindVars = query.boundValues;
                for (const key in query.usedPreExecResultNames) {
                    bindVars[query.usedPreExecResultNames[key]] = resultHolder[key];
                }

                let explainResult;
                // Execute the AQL query
                let executionResult;
                try {
                    // the explain statement also can cause errors which should be caught
                    if (options.recordPlan) {
                        const stmt = db._createStatement({
                            query: query.code,
                            bindVars,
                        });
                        explainResult = stmt.explain({ allPlans: true });
                    }

                    executionResult = db._query({
                        query: `/*id:${transactionID}*/\n${query.code}`,
                        bindVars,
                        options: {
                            profile: options.recordPlan ? 2 : options.recordTimings ? 1 : 0,
                            memoryLimit: options.queryMemoryLimit,
                        },
                    });
                } catch (error) {
                    if (explainResult) {
                        plans.push({
                            plan: explainResult.plans[0],
                            discardedPlans: explainResult.plans.slice(1),
                            warnings: explainResult.warnings,
                        });
                    }

                    rollbackWithError(error);
                }

                const resultData = executionResult.next();

                if (timings) {
                    let profile = executionResult.getExtra().profile;
                    for (let key in profile) {
                        if (profile.hasOwnProperty(key)) {
                            timings[key] = (timings[key] || 0) + profile[key];
                            timingsTotal += profile[key];
                        }
                    }
                }

                if (options.recordPlan) {
                    const extra = executionResult.getExtra();
                    plans.push({
                        plan: extra.plan,
                        discardedPlans: explainResult ? explainResult.plans.slice(1) : [],
                        stats: extra.stats,
                        warnings: extra.warnings,
                        profile: extra.profile,
                    });
                }

                if (
                    executionResult.getExtra().stats &&
                    executionResult.getExtra().stats.peakMemoryUsage
                ) {
                    const usage = executionResult.getExtra().stats.peakMemoryUsage;
                    if (
                        !transactionStats.peakQueryMemoryUsage ||
                        transactionStats.peakQueryMemoryUsage < usage
                    ) {
                        transactionStats.peakQueryMemoryUsage = usage;
                    }
                }

                if (query.resultName) {
                    resultHolder[query.resultName] = resultData;
                }

                try {
                    if (query.resultValidator) {
                        for (const key in query.resultValidator) {
                            if (key in validators) {
                                validators[key](query.resultValidator[key], resultData);
                            } else {
                                // noinspection ExceptionCaughtLocallyJS
                                throw new Error(`Validator "${key}" missing.`);
                            }
                        }
                    }
                } catch (e: any) {
                    rollbackWithError({
                        message: e.message,
                        code: e.code,
                    });
                }
            }

            // the last query is always the main query, use its result as result of the transaction
            const lastQueryResultName = queries[queries.length - 1].resultName;
            let data;
            if (lastQueryResultName) {
                data = resultHolder[lastQueryResultName];
            } else {
                data = undefined;
            }

            if (enableProfiling && timings) {
                timings.js = getPreciseTime() - startTime - timingsTotal;
            }

            const transactionResult = {
                data,
                timings,
                plans,
                stats: transactionStats,
            };

            if (options.mutationMode === 'rollback') {
                rollbackWithResult(transactionResult);
            }

            return transactionResult;
        };

        const validatorProviders = ALL_QUERY_RESULT_VALIDATOR_FUNCTION_PROVIDERS.map(
            (provider) =>
                `[${JSON.stringify(provider.getValidatorName())}]: ${String(
                    provider.getValidatorFunction(),
                )}`,
        );

        const allValidatorFunctionsObjectString = `validators = {${validatorProviders.join(
            ',\n',
        )}}`;

        return String(arangoExecutionFunction).replace(
            '//inject_validators_here',
            allValidatorFunctionsObjectString,
        );
    }

    async execute(queryTree: QueryNode) {
        const result = await this.executeExt({ queryTree });
        if (result.error) {
            throw result.error;
        }
        return result.data;
    }

    async executeExt({ queryTree, ...options }: ExecutionArgs): Promise<ExecutionResult> {
        const prepStartTime = getPreciseTime();
        globalContext.registerContext(this.schemaContext);
        let executableQueries: ReadonlyArray<AQLExecutableQuery>;
        let aqlQuery: AQLCompoundQuery;
        const oldEnableIndentationForCode = aqlConfig.enableIndentationForCode;
        aqlConfig.enableIndentationForCode = !!options.recordPlan;
        try {
            //TODO Execute single statement AQL queries directly without "db.transaction"?
            aqlQuery = getAQLQuery(queryTree, {
                clock: options.clock,
                idGenerator: options.idGenerator,
            });
            executableQueries = aqlQuery.getExecutableQueries();
        } finally {
            globalContext.unregisterContext();
            aqlConfig.enableIndentationForCode = oldEnableIndentationForCode;
        }
        if (this.logger.isTraceEnabled()) {
            this.logger.trace(`Executing AQL: ${aqlQuery.toColoredString()}`);
        }
        const aqlPreparationTime = getPreciseTime() - prepStartTime;

        // if the query contains revision assertions (_revision is used in updates / deletes), CONFLICT errors are
        // expected and retrying the mutation won't help. The caller needs to handle the conflicts then.
        // otherwise, conflicts can still occur because of how arangodb internally works, but those can be solved
        // by retrying the query.
        let executionResult;
        if (hasRevisionAssertions(queryTree)) {
            executionResult = await this.executeTransactionOnce(
                executableQueries,
                options,
                aqlQuery,
            );
        } else {
            executionResult = await this.executeTransactionWithRetries(
                executableQueries,
                options,
                aqlQuery,
            );
        }
        const {
            databaseError,
            timings: transactionTimings,
            data,
            plans,
            stats,
            hasTimedOut,
            wasCancelled,
        } = executionResult;

        let timings;
        if (options.recordTimings && transactionTimings) {
            timings = {
                ...transactionTimings,
                preparation: {
                    total: aqlPreparationTime,
                    aql: aqlPreparationTime,
                },
            };
        }

        let plan: ExecutionPlan | undefined;
        if (options.recordPlan && plans) {
            plan = {
                queryTree,
                transactionSteps: executableQueries.map((q, index) => ({
                    query: q.code,
                    boundValues: q.boundValues,
                    plan: plans[index] && plans[index].plan,
                    discardedPlans: plans[index] && plans[index].discardedPlans,
                    stats: plans[index] && plans[index].stats,
                    warnings: plans[index] && plans[index].warnings,
                    profile: plans[index] && plans[index].profile,
                })),
            };
        }

        let error;
        if (databaseError) {
            error = this.processDatabaseError(databaseError, {
                wasCancelled,
                hasTimedOut,
                transactionTimeoutMs: options.transactionTimeoutMs,
            });
        }

        return {
            error,
            data,
            timings,
            plan,
            stats,
        };
    }

    private processDatabaseError(
        error: Error,
        {
            hasTimedOut,
            wasCancelled,
            transactionTimeoutMs,
        }: {
            hasTimedOut: boolean;
            wasCancelled: boolean;
            transactionTimeoutMs: number | undefined;
        },
    ): Error {
        // might be just something like a TypeError
        if (!isArangoError(error)) {
            return new TransactionError(error.message, error);
        }

        // some errors need to be translated because we only can differentiate with the context here
        if (error.errorNum === ERROR_QUERY_KILLED) {
            // only check these flags if a QUERY_KILLED error is thrown because we might have initiated a query
            // kill due to timeout / cancellation, but it might have completed or errored for some other reason
            // before the kill is executed
            if (hasTimedOut) {
                return new TransactionTimeoutError({ timeoutMs: transactionTimeoutMs });
            } else if (wasCancelled) {
                return new TransactionCancelledError();
            }
        }

        // the arango errors are weird and have their message in "errorMessage"...
        return new TransactionError(error.errorMessage || error.message, error);
    }

    private async executeTransactionWithRetries(
        executableQueries: ReadonlyArray<AQLExecutableQuery>,
        options: ExecutionOptions,
        aqlQuery: AQLCompoundQuery,
    ): Promise<TransactionResult> {
        const maxRetries = this.config.retriesOnConflict || 0;
        let nextRetryDelay = 0;
        let retries = 0;
        let result;
        // timings need to be added up
        let timings: TransactionResult['timings'] | undefined;

        while (true) {
            result = await this.executeTransactionOnce(executableQueries, options, aqlQuery);

            if (options.recordTimings && result.timings) {
                timings = {
                    database: sumUpValues([
                        timings ? timings.database : {},
                        result.timings.database,
                    ]),
                    dbConnection: sumUpValues([
                        timings ? timings.dbConnection : {},
                        result.timings.dbConnection,
                    ]),
                } as TransactionResult['timings'];
            }

            const stats = {
                ...result.stats,
                retries,
            };

            if (
                !result.databaseError ||
                !this.isRetryableError(result.databaseError) ||
                !maxRetries
            ) {
                return {
                    ...result,
                    timings,
                    stats,
                };
            }

            if (retries >= maxRetries) {
                // retries exhausted
                return {
                    ...result,
                    timings,
                    stats,
                    databaseError: new ConflictRetriesExhaustedError({
                        causedBy: result.databaseError,
                        retries,
                    }),
                };
            }

            const sleepStart = getPreciseTime();
            const randomFactor = 1 + RETRY_DELAY_RANDOM_FRACTION * (2 * Math.random() - 1);
            const delayWithRandomComponent = nextRetryDelay * randomFactor;
            const shouldContinue = await sleepInterruptible(
                delayWithRandomComponent,
                options.cancellationToken,
            );
            if (options.recordTimings && timings) {
                const sleepLength = getPreciseTime() - sleepStart;
                timings = {
                    ...timings,
                    dbConnection: sumUpValues([
                        timings.dbConnection,
                        { retryDelay: sleepLength, total: sleepLength },
                    ]),
                } as TransactionResult['timings'];
            }
            if (!shouldContinue) {
                // cancellation token fired before the sleep time was over
                // we already have a result with an error, so it's probably better to return that instead of a generic "cancelled"
                // probably doesn't matter anyway because the caller probably is no longer interested in the result
                return {
                    ...result,
                    timings,
                    stats,
                };
            }

            if (nextRetryDelay) {
                nextRetryDelay *= 2;
            } else {
                nextRetryDelay = this.config.retryDelayBaseMs || DEFAULT_RETRY_DELAY_BASE_MS;
            }
            retries++;
        }
    }

    private isRetryableError(error: ArangoError): boolean {
        return error.errorNum === ERROR_ARANGO_CONFLICT;
    }

    private async executeTransactionOnce(
        executableQueries: ReadonlyArray<AQLExecutableQuery>,
        options: ExecutionOptions,
        aqlQuery: AQLCompoundQuery,
    ): Promise<TransactionResult> {
        const transactionID = uuid();
        const args: ArangoExecutionOptions = {
            queries: executableQueries,
            options: {
                ...options,
                queryMemoryLimit: options.queryMemoryLimit || this.config.queryMemoryLimit,
            },
            transactionID,
        };
        let isTransactionFinished = false;
        const watch = new Watch();

        let hasTimedOut = false;
        let wasCancelled = false;

        let cancellationToken = options.cancellationToken;
        if (cancellationToken) {
            cancellationToken.then(() => {
                wasCancelled = true;
            });
        }
        let requestSentCallback: (() => void) | undefined;
        let requestSentPromise = new Promise<void>((resolve) => (requestSentCallback = resolve));
        let timeout: any | undefined;
        if (options.transactionTimeoutMs != undefined) {
            const ms = options.transactionTimeoutMs;
            // transactionTimeout is a timeout that should only be started when the request is actually sent to ArangoDB
            const timeoutPromise = requestSentPromise
                .then(
                    () =>
                        new Promise<void>((resolve) => {
                            timeout = setTimeout(resolve, ms);
                        }),
                )
                .then(() => {
                    hasTimedOut = true;
                });
            if (cancellationToken) {
                cancellationToken.then(() => {
                    if (timeout) {
                        clearTimeout(timeout);
                        timeout = undefined;
                    }
                });
                cancellationToken = Promise.race([cancellationToken, timeoutPromise]);
            } else {
                cancellationToken = timeoutPromise;
            }
        }

        const dbStartTime = getPreciseTime();
        let transactionResult: ArangoTransactionResult;
        try {
            // Calling request() instead of executeTransaction() so we can pass beforeRequest
            // Created a feature request to be able to pass beforeRequest to execute Transaction(): https://github.com/arangodb/arangojs/issues/817
            transactionResult = await this.db.request(
                {
                    method: 'POST',
                    pathname: '/_api/transaction',
                    body: {
                        collections: {
                            read: aqlQuery.readAccessedCollections,
                            write: aqlQuery.writeAccessedCollections,
                        },
                        action: this.arangoExecutionFunction,
                        params: args,
                        waitForSync: true,
                    },
                    beforeRequest: (req) => {
                        watch.stop('queuing');

                        // start the timeout promise if needed (transactionTimeoutMs should not include queue time)
                        if (requestSentCallback) {
                            requestSentCallback();
                        }

                        if (wasCancelled) {
                            throw new TransactionCancelledError(
                                'Transaction was cancelled before it was started',
                            );
                        }

                        if (cancellationToken) {
                            // delay cancellation a bit for two reasons
                            // - don't take the effort of finding and killing a query if it's fast anyway
                            // - the cancellation might occur before the transaction script starts the query (so it would not find it)
                            // we only really need this to cancel long-running queries
                            // Also, note that we currently have no way to pass the cancellation token to the actual request
                            // Even if there was a way, we still probably would not want to do this. ArangoDB does not kill a query
                            // when the request is cancelled, so it would continue to process the request, but our queue would free up
                            // a slot -> we would effectively execute more queries in parallel than configured, potentially overloading the db
                            // That's why it is better to kill the query using the CancellationManager, and then let ArangoDB report the erorr to us
                            cancellationToken
                                .then(() => sleep(30))
                                .then(() => {
                                    // don't try to kill the query if the transaction() call finished already - this would mean that it
                                    // either was faster than the delay above, or the request was removed from the request queue
                                    if (!isTransactionFinished) {
                                        this.logger.debug(`Cancelling query ${transactionID}`);
                                        this.cancellationManager
                                            .cancelQuery(transactionID)
                                            .catch((e) => {
                                                this.logger.warn(
                                                    `Error cancelling query ${transactionID}: ${e.stack}`,
                                                );
                                            });
                                    }
                                });
                        }

                        // TODO figure out if we can get more timings. This is what we did earlier:
                        // although it's usually not relevant because the connections are using keepalive
                        /*
                            req.on('socket', (socket: Socket) => {
                                notifyAboutPhaseEnd(requestInstrumentation, 'socketInit');
                                if (knownSockets.has(socket)) {
                                    return;
                                }
                                knownSockets.add(socket);
                                socket.on('lookup', () =>
                                    notifyAboutPhaseEnd(requestInstrumentation, 'lookup'),
                                );
                                socket.on('connect', () =>
                                    notifyAboutPhaseEnd(requestInstrumentation, 'connecting'),
                                );
                            });
                         */
                    },
                    afterResponse: () => {
                        // this is called when we recieved the headers
                        watch.stop('waiting');
                    },
                },
                (res) => res.parsedBody.result,
            );
            // request() resolves after it read and processed the response
            watch.stop('receiving');
        } catch (e: any) {
            isTransactionFinished = true;
            if (e.message.startsWith('RolledBackTransactionError: ')) {
                const valStr = e.message.substr('RolledBackTransactionError: '.length);
                try {
                    transactionResult = JSON.parse(valStr);
                } catch (eParse) {
                    throw new Error(`Error parsing result of rolled back transaction`);
                }
            } else {
                throw e;
            }
        } finally {
            if (timeout) {
                clearTimeout(timeout);
                timeout = undefined;
            }
        }
        const {
            timings: databaseReportedTimings,
            data,
            plans,
            error: databaseError,
        } = transactionResult;
        isTransactionFinished = true;

        let timings;
        if (options.recordTimings && databaseReportedTimings) {
            const dbConnectionTotal = getPreciseTime() - dbStartTime;
            const queuing = watch.timings.queuing;
            const socketInit = watch.timings.socketInit || 0;
            const lookup = watch.timings.lookup || 0;
            const connecting = watch.timings.connecting || 0;
            const receiving = watch.timings.receiving;
            const waiting = watch.timings.waiting;
            const other =
                watch.timings.total -
                queuing -
                socketInit -
                lookup -
                connecting -
                receiving -
                waiting;
            const dbInternalTotal = objectValues<number>(databaseReportedTimings).reduce(
                (a, b) => a + b,
                0,
            );
            timings = {
                dbConnection: {
                    queuing,
                    socketInit,
                    lookup,
                    connecting,
                    waiting,
                    receiving,
                    other,
                    total: dbConnectionTotal,
                },
                database: {
                    ...databaseReportedTimings,
                    total: dbInternalTotal,
                },
            };
        }

        return {
            timings,
            data,
            plans,
            databaseError,
            stats: transactionResult.stats,
            hasTimedOut,
            wasCancelled,
        };
    }

    /**
     * Compares the model with the database and determines migrations to do
     */
    async getOutstandingMigrations(model: Model): Promise<ReadonlyArray<SchemaMigration>> {
        return this.analyzer.getOutstandingMigrations(model);
    }

    /**
     * Performs a single mutation
     */
    async performMigration(migration: SchemaMigration): Promise<void> {
        await this.migrationPerformer.performMigration(migration);
    }

    /**
     * Performs schema migration as configured with autocreateIndices/autoremoveIndices
     */
    async updateSchema(model: Model): Promise<void> {
        const migrations = await this.getOutstandingMigrations(model);
        const skippedMigrations: SchemaMigration[] = [];
        for (const migration of migrations) {
            if (!migration.isMandatory && !this.doNonMandatoryMigrations) {
                this.logger.debug(
                    `Skipping migration "${migration.description}" because of configuration`,
                );
                skippedMigrations.push(migration);
                continue;
            }
            try {
                this.logger.info(`Performing migration "${migration.description}"`);
                await this.performMigration(migration);
                this.logger.info(`Successfully performed migration "${migration.description}"`);
            } catch (e: any) {
                this.logger.error(
                    `Error performing migration "${migration.description}": ${e.stack}`,
                );
                throw e;
            }
        }
    }

    async getArangoDBVersion(): Promise<ArangoDBVersion | undefined> {
        return this.versionHelper.getArangoDBVersion();
    }

    async tokenizeExpressions(
        tokenizations: ReadonlyArray<FlexSearchTokenizable>,
    ): Promise<ReadonlyArray<FlexSearchTokenization>> {
        const tokenizationsFiltered = tokenizations.filter(
            (value, index) =>
                !tokenizations.some(
                    (value2, index2) =>
                        value.expression === value2.expression &&
                        value.analyzer === value2.analyzer &&
                        index > index2,
                ),
        );

        const aqlFragment = generateTokenizationQuery(tokenizationsFiltered);
        const queryCode = aqlFragment.getCode();
        const cursor = await this.db.query(queryCode.code, queryCode.boundValues);

        const result = await cursor.next();
        const resultArray: FlexSearchTokenization[] = [];
        for (let i = 0; i < tokenizationsFiltered.length; i++) {
            resultArray.push({
                expression: tokenizationsFiltered[i].expression,
                analyzer: tokenizationsFiltered[i].analyzer,
                tokens: result['token_' + i],
            });
        }

        return resultArray;
    }
}

function sumUpValues(objects: ReadonlyArray<{ readonly [key: string]: number }>): {
    readonly [key: string]: number;
} {
    const result: { [key: string]: number } = {};
    for (const obj of objects) {
        for (const key of Object.keys(obj)) {
            if (Number.isFinite(obj[key])) {
                if (key in result && Number.isFinite(result[key])) {
                    result[key] += obj[key];
                } else {
                    result[key] = obj[key];
                }
            }
        }
    }
    return result;
}
