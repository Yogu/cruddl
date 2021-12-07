import { IndexField, Model, RootEntityType } from '../../../model';
import { ID_FIELD } from '../../../schema/constants';
import { GraphQLOffsetDateTime, TIMESTAMP_PROPERTY } from '../../../schema/scalars/offset-date-time';
import { compact, flatMap } from '../../../utils/utils';
import { getCollectionNameForRootEntity } from '../arango-basics';
import { ArangoDBConfig } from '../config';

const DEFAULT_INDEX_TYPE = 'persistent';

export interface IndexDefinition {
    readonly id?: string;
    readonly rootEntity: RootEntityType;
    readonly fields: ReadonlyArray<string>;
    readonly collectionName: string;
    readonly unique: boolean;
    readonly sparse: boolean;
    readonly type: 'persistent';
}

export function describeIndex(index: IndexDefinition) {
    return `${index.unique ? 'unique ' : ''}${index.sparse ? 'sparse ' : ''}${index.type} index${
        index.id ? ' ' + index.id : ''
    } on collection ${index.collectionName} on ${index.fields.length > 1 ? 'fields' : 'field'} '${index.fields.join(
        ','
    )}'`;
}

export function getIndexDescriptor(index: IndexDefinition) {
    return compact([
        index.id, // contains collection and id separated by slash (may be missing)
        `type:${index.type}`,
        index.unique ? 'unique' : undefined,
        index.sparse ? 'sparse' : undefined,
        `collection:${index.collectionName}`,
        `fields:${index.fields.join(',')}`
    ]).join('/');
}

function indexDefinitionsEqual(a: IndexDefinition, b: IndexDefinition) {
    return (
        a.rootEntity === b.rootEntity &&
        a.fields.join('|') === b.fields.join('|') &&
        a.unique === b.unique &&
        a.sparse === b.sparse &&
        a.type === b.type
    );
}

export function getRequiredIndicesFromModel(model: Model): ReadonlyArray<IndexDefinition> {
    return flatMap(model.rootEntityTypes, rootEntity => getIndicesForRootEntity(rootEntity));
}

function getIndicesForRootEntity(rootEntity: RootEntityType): ReadonlyArray<IndexDefinition> {
    const indices: IndexDefinition[] = rootEntity.indices.map(index => ({
        rootEntity,
        collectionName: getCollectionNameForRootEntity(rootEntity),
        id: index.id,
        fields: index.fields.map(getArangoFieldPath),
        unique: index.unique,
        type: DEFAULT_INDEX_TYPE,
        sparse: index.sparse
    }));

    return indices;
}

function indexStartsWith(index: IndexDefinition, prefix: IndexDefinition) {
    if (
        index.sparse !== prefix.sparse ||
        index.unique !== prefix.unique ||
        index.rootEntity !== prefix.rootEntity ||
        index.type !== prefix.type
    ) {
        return false;
    }
    if (index.fields.length < prefix.fields.length) {
        return false;
    }
    for (let i = 0; i < prefix.fields.length; i++) {
        if (index.fields[i] !== prefix.fields[i]) {
            return false;
        }
    }
    return true;
}

export function calculateRequiredIndexOperations(
    existingIndices: ReadonlyArray<IndexDefinition>,
    requiredIndices: ReadonlyArray<IndexDefinition>,
    config: ArangoDBConfig
): {
    indicesToDelete: ReadonlyArray<IndexDefinition>;
    indicesToCreate: ReadonlyArray<IndexDefinition>;
} {
    let indicesToDelete = [...existingIndices];
    const indicesToCreate = compact(
        requiredIndices.map(requiredIndex => {
            const existingIndex = existingIndices.find(index => indexDefinitionsEqual(index, requiredIndex));
            indicesToDelete = indicesToDelete.filter(index => index !== existingIndex);
            if (!!existingIndex) {
                return undefined;
            }
            return requiredIndex;
        })
    );
    indicesToDelete = indicesToDelete
        .filter(index => index.type === DEFAULT_INDEX_TYPE) // only remove indexes of types that we also add
        .filter(index => !index.id || !config.ignoredIndexIDsPattern || !index.id.match(config.ignoredIndexIDsPattern));
    return { indicesToDelete, indicesToCreate };
}

/**
 * Gets the field path of an index prepared for Arango, adding [*] suffix to spread list items on list types
 */
function getArangoFieldPath(indexField: IndexField): string {
    if (indexField.declaringType.isRootEntityType && indexField.path.length === 1 && indexField.path[0] === ID_FIELD) {
        // translate to arangodb's id field
        return '_key';
    }

    let segments = (indexField.fieldsInPath || []).map(field => (field.isList ? `${field.name}[*]` : field.name));

    // OffsetDateTime filters / sorts on the timestamp, so we should also index this field
    if (
        indexField.field &&
        indexField.field.type.isScalarType &&
        indexField.field.type.graphQLScalarType === GraphQLOffsetDateTime
    ) {
        segments = [...segments, TIMESTAMP_PROPERTY];
    }

    return segments.join('.');
}
