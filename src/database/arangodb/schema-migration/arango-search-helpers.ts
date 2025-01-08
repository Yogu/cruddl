import { Database } from 'arangojs';
import { AnalyzerDescription, CreateAnalyzerOptions } from 'arangojs/analyzers';
import {
    ArangoSearchViewLink,
    ArangoSearchViewLinkOptions,
    ArangoSearchViewPropertiesOptions,
    CreateArangoSearchViewOptions,
    View,
    ViewProperties,
} from 'arangojs/views';
import deepEqual from 'deep-equal';
import { isEqual } from 'lodash';
import { Field, Model, RootEntityType } from '../../../model';
import { IDENTITY_ANALYZER } from '../../../model/implementation/flex-search';
import { OrderDirection } from '../../../model/implementation/order';
import { ID_FIELD } from '../../../schema/constants';
import { GraphQLI18nString } from '../../../schema/scalars/string-map';
import { getCollectionNameForRootEntity } from '../arango-basics';
import {
    CreateArangoSearchViewMigration,
    DropArangoSearchViewMigration,
    RecreateArangoSearchViewMigration,
    SchemaMigration,
    UpdateArangoSearchViewMigration,
} from './migrations';
import {
    GraphQLOffsetDateTime,
    TIMESTAMP_PROPERTY,
} from '../../../schema/scalars/offset-date-time';

export const FLEX_SEARCH_VIEW_PREFIX = 'flex_view_';

export interface FlexSearchPrimarySortConfig {
    readonly field: string;
    readonly asc: boolean;
}

export interface ArangoSearchDefinition {
    readonly rootEntityType: RootEntityType;
    readonly viewName: string;
    readonly collectionName: string;
    readonly primarySort: ReadonlyArray<FlexSearchPrimarySortConfig>;
}

export interface ArangoSearchConfiguration {
    readonly recursionDepth?: number;

    /**
     * The time in milliseconds after which data changes will be visible in flexSearch queries
     */
    readonly commitIntervalMsec?: number;

    /**
     * The interval at which a consolidation policy is applied to the flexSearch view
     */
    readonly consolidationIntervalMsec?: number;

    /**
     * Wait at least this many commits before removing unused files in the data directory
     */
    readonly cleanupIntervalStep?: number;
}

export function getRequiredViewsFromModel(model: Model): ReadonlyArray<ArangoSearchDefinition> {
    return model.rootEntityTypes
        .filter((value) => value.isFlexSearchIndexed)
        .map((rootEntity) => getViewForRootEntity(rootEntity));
}

export function getFlexSearchViewNameForRootEntity(rootEntity: RootEntityType) {
    return FLEX_SEARCH_VIEW_PREFIX + getCollectionNameForRootEntity(rootEntity);
}

function getViewForRootEntity(rootEntityType: RootEntityType): ArangoSearchDefinition {
    return {
        rootEntityType,
        viewName: getFlexSearchViewNameForRootEntity(rootEntityType),
        collectionName: getCollectionNameForRootEntity(rootEntityType),
        primarySort: rootEntityType.flexSearchPrimarySort.map((clause) => ({
            field: clause.field.path === ID_FIELD ? '_key' : clause.field.path,
            asc: clause.direction === OrderDirection.ASCENDING,
        })),
    };
}

export async function calculateRequiredArangoSearchViewCreateOperations(
    existingViews: ReadonlyArray<View>,
    requiredViews: ReadonlyArray<ArangoSearchDefinition>,
    db: Database,
    configuration?: ArangoSearchConfiguration,
): Promise<ReadonlyArray<SchemaMigration>> {
    let viewsToCreate = requiredViews.filter(
        (value) => !existingViews.some((value1) => value1.name === value.viewName),
    );

    async function mapToMigration(
        value: ArangoSearchDefinition,
    ): Promise<CreateArangoSearchViewMigration> {
        const colExists = await db.collection(value.collectionName).exists();
        const count: number = colExists
            ? (await db.collection(value.collectionName).count()).count
            : 0;
        return new CreateArangoSearchViewMigration({
            collectionSize: count,
            collectionName: value.collectionName,
            viewName: value.viewName,
            properties: getPropertiesFromDefinition(value, configuration),
        });
    }

    return await Promise.all(viewsToCreate.map(mapToMigration));
}

export function calculateRequiredArangoSearchViewDropOperations(
    views: ReadonlyArray<View>,
    definitions: ReadonlyArray<ArangoSearchDefinition>,
): ReadonlyArray<SchemaMigration> {
    const viewsToDrop = views.filter(
        (value) =>
            !definitions.some((value1) => value1.viewName === value.name) &&
            value.name.startsWith(FLEX_SEARCH_VIEW_PREFIX),
    );
    return viewsToDrop.map((value) => new DropArangoSearchViewMigration({ viewName: value.name }));
}

/**
 * Configures the inBackground flag
 *
 * We don't to this initially because it won't be present in the actual view definition, and we would always see a
 * pending change in the migration analyzer (because it would want to add inBackground).
 */
export function configureForBackgroundCreation<T extends ArangoSearchViewPropertiesOptions>(
    definition: T,
): T {
    return {
        ...definition,
        links: definition.links
            ? Object.fromEntries(
                  Object.entries(definition.links).map(([key, value]) => [
                      key,
                      {
                          ...value,
                          // if this is not set, creating the view would acquire an exclusive lock on the collections
                          inBackground: true,
                      },
                  ]),
              )
            : definition.links,
    };
}

function getPropertiesFromDefinition(
    definition: ArangoSearchDefinition,
    configuration?: ArangoSearchConfiguration,
): CreateArangoSearchViewOptions {
    const recursionDepth =
        configuration && configuration.recursionDepth ? configuration.recursionDepth : 1;
    const performanceParams = definition.rootEntityType.flexSearchPerformanceParams;

    // need to be explicit with defaults here (e.g. 1000 or 2) because we get concrete values for
    // all parameters for existing views as well, and we need to be able to compare them
    // (undefined does not mean "don't care" but "use defaults")
    return {
        type: 'arangosearch',
        links: {
            [definition.collectionName]: {
                analyzers: [IDENTITY_ANALYZER],
                includeAllFields: false,
                storeValues: 'id',
                trackListPositions: false,
                fields: fieldDefinitionsFor(definition.rootEntityType.fields),
            } as ArangoSearchViewLink,
        },

        commitIntervalMsec:
            performanceParams.commitIntervalMsec ??
            (configuration?.commitIntervalMsec ? configuration.commitIntervalMsec : 1000),

        // not sure what the actual default is - the arangojs docs suggest it's 10_000, but the
        // arangodb documentation says it's 1_000. We historically specified 1_000 here, so keep it
        consolidationIntervalMsec:
            performanceParams.consolidationIntervalMsec ??
            (configuration?.consolidationIntervalMsec
                ? configuration.consolidationIntervalMsec
                : 1000),

        // 2 is default according to
        // https://docs.arangodb.com/3.11/index-and-search/arangosearch/arangosearch-views-reference/#view-properties
        cleanupIntervalStep:
            performanceParams.cleanupIntervalStep ?? configuration?.cleanupIntervalStep ?? 2,

        primarySort: definition?.primarySort ? definition.primarySort.slice() : [],
    };

    function fieldDefinitionsFor(
        fields: ReadonlyArray<Field>,
        path: ReadonlyArray<Field> = [],
    ): { [key: string]: ArangoSearchViewLinkOptions } {
        const fieldDefinitions: { [key: string]: ArangoSearchViewLinkOptions } = {};
        const fieldsToIndex = fields.filter(
            (field) =>
                (field.isFlexSearchIndexed || field.isFlexSearchFulltextIndexed) &&
                path.filter((f) => f === field).length < recursionDepth,
        );
        for (const field of fieldsToIndex) {
            let arangoFieldName;
            if (
                field.declaringType.isRootEntityType &&
                field.isSystemField &&
                field.name === ID_FIELD
            ) {
                arangoFieldName = '_key';
            } else {
                arangoFieldName = field.name;
            }
            fieldDefinitions[arangoFieldName] = fieldDefinitionFor(field, [...path, field]);
        }
        return fieldDefinitions;
    }

    function fieldDefinitionFor(
        field: Field,
        path: ReadonlyArray<Field> = [],
    ): ArangoSearchViewLinkOptions {
        if (field.type.isObjectType) {
            return {
                fields: fieldDefinitionsFor(field.type.fields, path),
            };
        }

        const analyzers = new Set<string>();
        if (field.isFlexSearchFulltextIndexed && field.flexSearchLanguage) {
            analyzers.add(field.getFlexSearchFulltextAnalyzerOrThrow());
        }
        if (field.flexSearchAnalyzer) {
            analyzers.add(field.flexSearchAnalyzer);
        }

        const link: ArangoSearchViewLinkOptions = {};
        // only set this property if it's not the default (["identity"])
        if (analyzers.size !== 1 || !analyzers.has(IDENTITY_ANALYZER)) {
            link.analyzers = Array.from(analyzers);
        }

        if (field.type.isScalarType && field.type.name === GraphQLI18nString.name) {
            // an I18nString is an object with language->valueInLanguage mappings
            // we simply analyze all fields (i.e. all languages). They will inherit the analyzers of the main link.
            link.includeAllFields = true;
        }

        // for GraphQLOffsetDateTime, we actually need to index the ".timestamp" field
        if (field.type.name === GraphQLOffsetDateTime.name) {
            return {
                fields: {
                    [TIMESTAMP_PROPERTY]: link,
                },
            };
        } else {
            return link;
        }
    }
}

export function isEqualProperties(
    definitionProperties: CreateArangoSearchViewOptions,
    viewProperties: ViewProperties,
): boolean {
    if (viewProperties.type !== 'arangosearch') {
        // we always need an 'arangosearch' view
        return false;
    }

    return (
        isEqual(definitionProperties.links, viewProperties.links) &&
        isEqual(definitionProperties.primarySort, viewProperties.primarySort) &&
        isEqual(definitionProperties.commitIntervalMsec, viewProperties.commitIntervalMsec) &&
        isEqual(
            definitionProperties.consolidationIntervalMsec,
            viewProperties.consolidationIntervalMsec,
        ) &&
        isEqual(definitionProperties.cleanupIntervalStep, viewProperties.cleanupIntervalStep)
    );
}

function isRecreateRequired(
    definitionProperties: CreateArangoSearchViewOptions,
    viewProperties: ViewProperties,
): boolean {
    if (viewProperties.type !== 'arangosearch') {
        // we always need an 'arangosearch' view
        return true;
    }

    return !isEqual(definitionProperties.primarySort, viewProperties.primarySort);
}

export async function calculateRequiredArangoSearchViewUpdateOperations(
    views: ReadonlyArray<View>,
    definitions: ReadonlyArray<ArangoSearchDefinition>,
    db: Database,
    configuration?: ArangoSearchConfiguration,
): Promise<ReadonlyArray<SchemaMigration>> {
    const viewsWithUpdateRequired: (
        | UpdateArangoSearchViewMigration
        | RecreateArangoSearchViewMigration
    )[] = [];
    for (const view of views) {
        const definition = definitions.find((value) => value.viewName === view.name);
        if (!definition) {
            continue;
        }
        const viewProperties = await view.properties();

        const definitionProperties = getPropertiesFromDefinition(definition, configuration);
        if (!isEqualProperties(definitionProperties, viewProperties)) {
            const colExists = await db.collection(definition.collectionName).exists();
            const count: number = colExists
                ? (await db.collection(definition.collectionName).count()).count
                : 0;
            if (isRecreateRequired(definitionProperties, viewProperties)) {
                viewsWithUpdateRequired.push(
                    new RecreateArangoSearchViewMigration({
                        viewName: definition.viewName,
                        collectionName: definition.collectionName,
                        collectionSize: count,
                        properties: definitionProperties,
                    }),
                );
            } else {
                viewsWithUpdateRequired.push(
                    new UpdateArangoSearchViewMigration({
                        viewName: definition.viewName,
                        collectionName: definition.collectionName,
                        collectionSize: count,
                        properties: definitionProperties,
                    }),
                );
            }
        }
    }

    return viewsWithUpdateRequired;
}

export function areAnalyzersEqual(actual: AnalyzerDescription, target: CreateAnalyzerOptions) {
    if (actual.type !== target.type) {
        return false;
    }
    if (actual.type === 'norm' && target.type === 'norm') {
        // arangodb 3.9 removed the .utf-8 suffix
        return (
            actual.properties.case === target.properties.case &&
            actual.properties.accent === target.properties.accent &&
            normalizeLocale(actual.properties.locale) === normalizeLocale(target.properties.locale)
        );
    }
    return deepEqual(actual, target);
}

function normalizeLocale(locale: string) {
    if (locale.endsWith('.utf-8')) {
        return locale.substring(0, locale.length - '.utf-8'.length);
    }
    return locale;
}
