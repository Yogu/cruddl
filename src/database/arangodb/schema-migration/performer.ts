import { Database } from 'arangojs';
import { CollectionType } from 'arangojs/collections';
import { ArangoDBConfig, initDatabase } from '../config';
import {
    ERROR_ARANGO_DATA_SOURCE_NOT_FOUND,
    ERROR_ARANGO_DUPLICATE_NAME,
    ERROR_ARANGO_INDEX_NOT_FOUND,
} from '../error-codes';
import { configureForBackgroundCreation, isEqualProperties } from './arango-search-helpers';
import {
    CreateArangoSearchAnalyzerMigration,
    CreateArangoSearchViewMigration,
    CreateDocumentCollectionMigration,
    CreateEdgeCollectionMigration,
    CreateIndexMigration,
    DropArangoSearchViewMigration,
    DropIndexMigration,
    RecreateArangoSearchViewMigration,
    SchemaMigration,
    UpdateArangoSearchAnalyzerMigration,
    UpdateArangoSearchViewMigration,
} from './migrations';

export class MigrationPerformer {
    private readonly db: Database;

    constructor(private readonly config: ArangoDBConfig) {
        this.db = initDatabase(config);
    }

    async performMigration(migration: SchemaMigration) {
        switch (migration.type) {
            case 'createIndex':
                return this.createIndex(migration);
            case 'dropIndex':
                return this.dropIndex(migration);
            case 'createDocumentCollection':
                return this.createDocumentCollection(migration);
            case 'createEdgeCollection':
                return this.createEdgeCollection(migration);
            case 'createArangoSearchView':
                return this.createArangoSearchView(migration);
            case 'updateArangoSearchView':
                return this.updateArangoSearchView(migration);
            case 'dropArangoSearchView':
                return this.dropArangoSearchView(migration);
            case 'recreateArangoSearchView':
                return this.recreateArangoSearchView(migration);
            case 'createArangoSearchAnalyzer':
                return this.createArangoSearchAnalyzer(migration);
            case 'updateArangoSearchAnalyzer':
                return this.updateArangoSearchAnalyzer(migration);
            default:
                throw new Error(`Unknown migration type: ${(migration as any).type}`);
        }
    }

    private async createIndex(migration: CreateIndexMigration) {
        await this.db.collection(migration.index.collectionName).ensureIndex({
            type: 'persistent',
            fields: migration.index.fields.slice(),
            unique: migration.index.unique,
            sparse: migration.index.sparse,
            inBackground: this.config.createIndicesInBackground,
        });
    }

    private async dropIndex(migration: DropIndexMigration) {
        try {
            await this.db.collection(migration.index.collectionName).dropIndex(migration.index.id!);
        } catch (e: any) {
            // maybe the index has been dropped in the meantime
            if (e.errorNum === ERROR_ARANGO_INDEX_NOT_FOUND) {
                return;
            }
            throw e;
        }
    }

    private async createDocumentCollection(migration: CreateDocumentCollectionMigration) {
        try {
            await this.db.createCollection(migration.collectionName, {
                ...this.config.createCollectionOptions,
                type: CollectionType.DOCUMENT_COLLECTION,
            });
        } catch (e: any) {
            // maybe the collection has been created in the meantime
            if (e.errorNum === ERROR_ARANGO_DUPLICATE_NAME) {
                const collection = await this.db.collection(migration.collectionName).get();
                if (collection.type === CollectionType.DOCUMENT_COLLECTION) {
                    return;
                }
            }
            throw e;
        }
    }

    private async createEdgeCollection(migration: CreateEdgeCollectionMigration) {
        try {
            await this.db.createCollection(migration.collectionName, {
                ...this.config.createCollectionOptions,
                type: CollectionType.EDGE_COLLECTION,
            });
        } catch (e: any) {
            // maybe the collection has been created in the meantime
            if (e.errorNum === ERROR_ARANGO_DUPLICATE_NAME) {
                const collection = await this.db.collection(migration.collectionName).get();
                if (collection.type === CollectionType.EDGE_COLLECTION) {
                    return;
                }
            }
            throw e;
        }
    }

    private async createArangoSearchView(migration: CreateArangoSearchViewMigration) {
        try {
            await this.db.createView(
                migration.viewName,
                configureForBackgroundCreation(migration.properties),
            );
        } catch (e: any) {
            // maybe the collection has been created in the meantime
            if (e.errorNum === ERROR_ARANGO_DUPLICATE_NAME) {
                const existingProperties = await this.db.view(migration.viewName).properties();
                // if the properties do not equal, we might need to recreate; rather fail and let someone retry
                if (isEqualProperties(migration.properties, existingProperties)) {
                    return;
                }
            }
            throw e;
        }
    }

    private async updateArangoSearchView(migration: UpdateArangoSearchViewMigration) {
        await this.db
            .view(migration.viewName)
            .replaceProperties(configureForBackgroundCreation(migration.properties));
    }

    private async dropArangoSearchView(migration: DropArangoSearchViewMigration) {
        try {
            await this.db.view(migration.config.viewName).drop();
        } catch (e: any) {
            // maybe the view has been dropped in the meantime
            if (e.errorNum === ERROR_ARANGO_DATA_SOURCE_NOT_FOUND) {
                return;
            }
            throw e;
        }
    }

    private async recreateArangoSearchView(migration: RecreateArangoSearchViewMigration) {
        try {
            await this.db.view(migration.viewName).drop();
        } catch (e: any) {
            // maybe the view has been dropped in the meantime
            if (e.errorNum !== ERROR_ARANGO_DATA_SOURCE_NOT_FOUND) {
                throw e;
            }
        }

        try {
            await this.db.createView(
                migration.viewName,
                configureForBackgroundCreation(migration.properties),
            );
        } catch (e: any) {
            // maybe the collection has been created in the meantime
            if (e.errorNum === ERROR_ARANGO_DUPLICATE_NAME) {
                const existingProperties = await this.db.view(migration.viewName).properties();
                // if the properties do not equal, we might need to recreate; rather fail and let someone retry
                if (isEqualProperties(migration.properties, existingProperties)) {
                    return;
                }
            }
            throw e;
        }
    }

    private async createArangoSearchAnalyzer(
        migration: CreateArangoSearchAnalyzerMigration | UpdateArangoSearchAnalyzerMigration,
    ) {
        await this.db.createAnalyzer(migration.name, migration.options);
    }

    private async updateArangoSearchAnalyzer(migration: UpdateArangoSearchAnalyzerMigration) {
        try {
            await this.db.analyzer(migration.name).drop(false);
        } catch (e: any) {
            if (e.code === 409) {
                throw new Error(
                    `Failed to drop arangoSearch analyzer because it is still in use. Drop arangoSearch views and run the migration again. ${e.message}`,
                );
            }
            if (e.code !== 404) {
                throw e;
            }
        }

        await this.createArangoSearchAnalyzer(migration);
    }
}
