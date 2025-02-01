import { GraphQLID, GraphQLList, GraphQLNonNull } from 'graphql';
import { flatMap } from 'lodash';
import memorize from 'memorize-decorator';
import { AggregationOperator, Namespace, RootEntityType } from '../model';
import {
    AffectedFieldInfoQueryNode,
    AggregationQueryNode,
    BinaryOperationQueryNode,
    BinaryOperator,
    CountQueryNode,
    CreateBillingEntityQueryNode,
    DeleteEntitiesQueryNode,
    EntitiesIdentifierKind,
    EntitiesQueryNode,
    EntityFromIdQueryNode,
    ErrorIfEmptyResultValidator,
    ErrorIfNotTruthyResultValidator,
    FirstOfListQueryNode,
    ListQueryNode,
    LiteralQueryNode,
    NOT_FOUND_ERROR,
    NullQueryNode,
    ObjectQueryNode,
    PreExecQueryParms,
    QueryNode,
    RootEntityIDQueryNode,
    TransformListQueryNode,
    UnknownValueQueryNode,
    UpdateEntitiesQueryNode,
    VariableAssignmentQueryNode,
    VariableQueryNode,
    WithPreExecutionQueryNode,
} from '../query-tree';
import { ID_FIELD, MUTATION_INPUT_ARG, MUTATION_TYPE, REVISION_FIELD } from '../schema/constants';
import {
    getCreateEntitiesFieldName,
    getCreateEntityFieldName,
    getDeleteAllEntitiesFieldName,
    getDeleteEntitiesFieldName,
    getDeleteEntityFieldName,
    getUpdateAllEntitiesFieldName,
    getUpdateEntitiesFieldName,
    getUpdateEntityFieldName,
} from '../schema/names';
import { PlainObject, compact, decapitalize } from '../utils/utils';
import { BillingTypeGenerator } from './billing-type-generator';
import { CreateInputTypeGenerator, CreateRootEntityInputType } from './create-input-types';
import { generateDeleteAllQueryNode } from './delete-all-generator';
import { createGraphQLError } from './graphql-errors';
import { ListAugmentation } from './list-augmentation';
import { OutputTypeGenerator } from './output-type-generator';
import {
    FieldContext,
    QueryNodeField,
    QueryNodeListType,
    QueryNodeNonNullType,
    QueryNodeObjectType,
    makeNonNullableList,
} from './query-node-object-type';
import { UniqueFieldArgumentsGenerator } from './unique-field-arguments-generator';
import {
    UpdateInputFieldContext,
    UpdateInputTypeGenerator,
    UpdateRootEntityInputType,
} from './update-input-types';
import {
    createBillingEntityCategoryNode,
    createBillingEntityQuantityNode,
} from './utils/billing-nodes';
import { getEntitiesByUniqueFieldQuery } from './utils/entities-by-unique-field';
import { getFilterNode } from './utils/filtering';
import { mapToIDNodesUnoptimized } from './utils/map';
import { getPreEntityRemovalStatements } from './utils/relations';
import { LimitTypeCheckType } from './order-by-and-pagination-augmentation';

export class MutationTypeGenerator {
    constructor(
        private readonly outputTypeGenerator: OutputTypeGenerator,
        private readonly createTypeGenerator: CreateInputTypeGenerator,
        private readonly updateTypeGenerator: UpdateInputTypeGenerator,
        private readonly listAugmentation: ListAugmentation,
        private readonly billingTypeGenerator: BillingTypeGenerator,
        private readonly uniqueFieldArgumentsGenerator: UniqueFieldArgumentsGenerator,
    ) {}

    @memorize()
    generate(namespace: Namespace): QueryNodeObjectType {
        const namespaceFields = namespace.childNamespaces
            .filter((namespace) => namespace.allRootEntityTypes.length > 0)
            .map(
                (n): QueryNodeField => ({
                    name: n.name || '',
                    type: this.generate(n),
                    resolve: () => new ObjectQueryNode([]),
                }),
            );

        const rootEntityFields = flatMap(namespace.rootEntityTypes, (type) =>
            this.generateFields(type),
        );
        const namespaceDesc = namespace.isRoot
            ? `the root namespace`
            : `the namespace \`${namespace.dotSeparatedPath}\``;

        return {
            name: namespace.pascalCasePath + MUTATION_TYPE,
            description: `The Mutation type for ${namespaceDesc}\n\nFields are executed serially in the order they occur in the selection set (the result of the first field does not see the changes made by the second field). All mutations are executed atomically - if any of them fail, the complete operation is rolled back.`,
            fields: [...namespaceFields, ...rootEntityFields],
        };
    }

    private generateFields(rootEntityType: RootEntityType): ReadonlyArray<QueryNodeField> {
        const canCreatePluralFields = rootEntityType.name !== rootEntityType.pluralName;

        return compact([
            this.generateCreateField(rootEntityType),
            canCreatePluralFields ? this.generateCreateManyField(rootEntityType) : undefined,
            this.generateUpdateField(rootEntityType),
            canCreatePluralFields ? this.generateUpdateManyField(rootEntityType) : undefined,
            this.generateUpdateAllField(rootEntityType),
            this.generateDeleteField(rootEntityType),
            canCreatePluralFields ? this.generateDeleteManyField(rootEntityType) : undefined,
            this.generateDeleteAllField(rootEntityType),
            this.billingTypeGenerator.getMutationField(rootEntityType),
        ]);
    }

    private generateCreateField(rootEntityType: RootEntityType): QueryNodeField {
        const inputType = this.createTypeGenerator.generateForRootEntityType(rootEntityType);

        return {
            name: getCreateEntityFieldName(rootEntityType),
            type: new QueryNodeNonNullType(this.outputTypeGenerator.generate(rootEntityType)),
            args: {
                [MUTATION_INPUT_ARG]: {
                    type: new GraphQLNonNull(inputType.getInputType()),
                },
            },
            isSerial: true,
            description: `Creates a new ${rootEntityType.name}`,
            resolve: (_, args, info) =>
                this.generateCreateQueryNode(
                    rootEntityType,
                    args[MUTATION_INPUT_ARG],
                    inputType,
                    info,
                ),
        };
    }

    private generateCreateQueryNode(
        rootEntityType: RootEntityType,
        input: PlainObject,
        inputType: CreateRootEntityInputType,
        context: FieldContext,
    ): QueryNode {
        const newEntityIdVarNode = new VariableQueryNode('newEntityId');
        const createStatements = inputType.getCreateStatements(input, newEntityIdVarNode, context);

        // PreExecute creation and relation queries and return result
        return new WithPreExecutionQueryNode({
            resultNode: new EntityFromIdQueryNode(rootEntityType, newEntityIdVarNode),
            preExecQueries: [...createStatements],
        });
    }

    private generateCreateManyField(rootEntityType: RootEntityType): QueryNodeField {
        const inputType = this.createTypeGenerator.generateForRootEntityType(rootEntityType);

        return {
            name: getCreateEntitiesFieldName(rootEntityType),
            type: new QueryNodeListType(
                new QueryNodeNonNullType(this.outputTypeGenerator.generate(rootEntityType)),
            ),
            args: {
                [MUTATION_INPUT_ARG]: {
                    type: new GraphQLNonNull(
                        new GraphQLList(new GraphQLNonNull(inputType.getInputType())),
                    ),
                },
            },
            isSerial: true,
            description: `Creates multiple new ${rootEntityType.pluralName}`,
            resolve: (_, args, info) =>
                this.generateCreateManyQueryNode(
                    rootEntityType,
                    args[MUTATION_INPUT_ARG],
                    inputType,
                    info,
                ),
        };
    }

    private generateCreateManyQueryNode(
        rootEntityType: RootEntityType,
        inputs: ReadonlyArray<PlainObject>,
        inputType: CreateRootEntityInputType,
        context: FieldContext,
    ): QueryNode {
        const idsVar = new VariableQueryNode('newEntityIds');
        const statements = inputType.getMultiCreateStatements(inputs, idsVar, context);

        const idVar = new VariableQueryNode('id');
        const resultNode = new TransformListQueryNode({
            listNode: idsVar,
            itemVariable: idVar,
            innerNode: new EntityFromIdQueryNode(rootEntityType, idVar),
        });

        return new WithPreExecutionQueryNode({
            resultNode,
            preExecQueries: statements,
        });
    }

    private generateUpdateManyField(rootEntityType: RootEntityType): QueryNodeField {
        const inputType = this.updateTypeGenerator.generateForRootEntityType(rootEntityType);

        return {
            name: getUpdateEntitiesFieldName(rootEntityType),
            type: new QueryNodeListType(
                new QueryNodeNonNullType(this.outputTypeGenerator.generate(rootEntityType)),
            ),
            args: {
                [MUTATION_INPUT_ARG]: {
                    type: new GraphQLNonNull(
                        new GraphQLList(new GraphQLNonNull(inputType.getInputType())),
                    ),
                },
            },
            isSerial: true,
            description: `Updates multiple existing ${rootEntityType.pluralName} (referenced by their ids)`,
            resolve: (_, args, info) =>
                this.generateUpdateManyQueryNode(
                    rootEntityType,
                    args[MUTATION_INPUT_ARG],
                    inputType,
                    info,
                ),
        };
    }

    private generateUpdateManyQueryNode(
        rootEntityType: RootEntityType,
        inputs: ReadonlyArray<PlainObject>,
        inputType: UpdateRootEntityInputType,
        fieldContext: FieldContext,
    ): QueryNode {
        const ids = new Set<string>();
        for (const input of inputs) {
            const checkResult = inputType.check(input, fieldContext);
            if (checkResult) {
                return checkResult;
            }
            const inputID = input[ID_FIELD] as string;
            if (ids.has(inputID)) {
                throw createGraphQLError(
                    `${rootEntityType.name} with id "${inputID}" is included more than once in bulk update`,
                    fieldContext,
                );
            }
            ids.add(inputID);
        }

        // Optimization: see if we need any statements except the main ones. If we don't, we can
        // combine everything into one statement
        let needsSeparateStatements = false;
        let statements: PreExecQueryParms[] = [];
        let updateEntityNodes: QueryNode[] = [];
        for (const input of inputs) {
            const result = this.getUpdateStatements(rootEntityType, input, inputType, fieldContext);
            statements.push(...result.statements);
            if (result.needsStatements) {
                needsSeparateStatements = true;
            }
            updateEntityNodes.push(result.updateEntityNode);
        }
        if (!needsSeparateStatements && statements.length > 1) {
            // can combine everything into one statement. we need to add a validator to check if
            // every object was found, though.
            const zeroNode = new LiteralQueryNode(0);
            // list of booleans with true for "found" and false for "not found"
            const listNode = new ListQueryNode(
                updateEntityNodes.map(
                    (node) =>
                        new BinaryOperationQueryNode(
                            new CountQueryNode(node),
                            BinaryOperator.GREATER_THAN,
                            zeroNode,
                        ),
                ),
            );
            const combinedStatement = new PreExecQueryParms({
                query: new AggregationQueryNode(listNode, AggregationOperator.EVERY_TRUE),
                resultValidator: new ErrorIfNotTruthyResultValidator({
                    errorMessage: `At least one of the ${rootEntityType.name} objects to update could not be found.`,
                    errorCode: NOT_FOUND_ERROR,
                }),
            });
            statements = [combinedStatement];
        }

        const resultNode = new ListQueryNode(
            inputs.map(
                (input) =>
                    new EntityFromIdQueryNode(
                        rootEntityType,
                        new LiteralQueryNode(input[ID_FIELD] as string),
                    ),
            ),
        );
        return new WithPreExecutionQueryNode({
            resultNode,
            preExecQueries: statements,
        });
    }

    private generateUpdateField(rootEntityType: RootEntityType): QueryNodeField {
        const inputType = this.updateTypeGenerator.generateForRootEntityType(rootEntityType);

        return {
            name: getUpdateEntityFieldName(rootEntityType),
            type: this.outputTypeGenerator.generate(rootEntityType),
            args: {
                [MUTATION_INPUT_ARG]: {
                    type: new GraphQLNonNull(inputType.getInputType()),
                },
            },
            isSerial: true,
            description: `Updates an existing ${rootEntityType.name}`,
            resolve: (_, args, info) =>
                this.generateUpdateQueryNode(
                    rootEntityType,
                    args[MUTATION_INPUT_ARG],
                    inputType,
                    info,
                ),
        };
    }

    private generateUpdateQueryNode(
        rootEntityType: RootEntityType,
        input: PlainObject,
        inputType: UpdateRootEntityInputType,
        fieldContext: FieldContext,
    ): QueryNode {
        const checkResult = inputType.check(input, fieldContext);
        if (checkResult) {
            return checkResult;
        }

        const { statements } = this.getUpdateStatements(
            rootEntityType,
            input,
            inputType,
            fieldContext,
        );

        // PreExecute creation and relation queries and return result
        return new WithPreExecutionQueryNode({
            resultNode: new EntityFromIdQueryNode(
                rootEntityType,
                new LiteralQueryNode(input[ID_FIELD]),
            ),
            preExecQueries: statements,
        });
    }

    private getUpdateStatements(
        rootEntityType: RootEntityType,
        input: PlainObject,
        inputType: UpdateRootEntityInputType,
        fieldContext: FieldContext,
    ): {
        readonly statements: ReadonlyArray<PreExecQueryParms>;
        readonly updateEntityNode: QueryNode;
        readonly needsStatements: boolean;
    } {
        const updateEntityNode = this.getUpdateRootEntityQueryNode(
            fieldContext,
            inputType,
            input,
            rootEntityType,
        );
        const updatedIdsVarNode = new VariableQueryNode('updatedIds');
        const updateEntityPreExec = new PreExecQueryParms({
            query: updateEntityNode,
            resultVariable: updatedIdsVarNode,
            resultValidator: new ErrorIfEmptyResultValidator({
                errorMessage: `${rootEntityType.name} with id '${input[ID_FIELD]}' could not be found.`,
                errorCode: NOT_FOUND_ERROR,
            }),
        });

        const relationStatements = inputType.getRelationStatements(
            input,
            new FirstOfListQueryNode(updatedIdsVarNode),
            fieldContext,
        );
        const billingStatement = this.getBillingStatementForUpdate(
            rootEntityType,
            input,
            updatedIdsVarNode,
        );

        const statements = [
            updateEntityPreExec,
            ...relationStatements,
            ...(billingStatement ? [billingStatement] : []),
        ];

        return {
            statements,
            needsStatements: statements.length > 1,
            updateEntityNode,
        };
    }

    private getBillingStatementForUpdate(
        rootEntityType: RootEntityType,
        input: PlainObject,
        updatedIdsVarNode: VariableQueryNode,
    ): PreExecQueryParms | undefined {
        if (
            !rootEntityType.billingEntityConfig ||
            !rootEntityType.billingEntityConfig.keyFieldName ||
            !input[rootEntityType.billingEntityConfig.keyFieldName]
        ) {
            return;
        }

        const entityVar = new VariableQueryNode('entity');
        return new PreExecQueryParms({
            query: new VariableAssignmentQueryNode({
                variableValueNode: new EntityFromIdQueryNode(
                    rootEntityType,
                    new FirstOfListQueryNode(updatedIdsVarNode),
                ),
                variableNode: entityVar,
                resultNode: new CreateBillingEntityQueryNode({
                    rootEntityTypeName: rootEntityType.name,
                    key: input[rootEntityType.billingEntityConfig.keyFieldName] as number | string,
                    categoryNode: createBillingEntityCategoryNode(
                        rootEntityType.billingEntityConfig,
                        entityVar,
                    ),
                    quantityNode: createBillingEntityQuantityNode(
                        rootEntityType.billingEntityConfig,
                        entityVar,
                    ),
                }),
            }),
        });
    }

    private getUpdateRootEntityQueryNode(
        fieldContext: FieldContext,
        inputType: UpdateRootEntityInputType,
        input: PlainObject,
        rootEntityType: RootEntityType,
    ) {
        const currentEntityVariable = new VariableQueryNode('currentEntity');
        const context: UpdateInputFieldContext = {
            ...fieldContext,
            currentEntityNode: currentEntityVariable,
        };
        const updates = inputType.getProperties(input, context);
        const revision = inputType.getRevision(input);
        const affectedFields = inputType
            .getAffectedFields(input, context)
            .map((field) => new AffectedFieldInfoQueryNode(field));

        const listItemVar = new VariableQueryNode(decapitalize(rootEntityType.name));
        const filterNode = new BinaryOperationQueryNode(
            new RootEntityIDQueryNode(listItemVar),
            BinaryOperator.EQUAL,
            new LiteralQueryNode(input[ID_FIELD]),
        );
        const listNode = new TransformListQueryNode({
            listNode: new EntitiesQueryNode(rootEntityType),
            filterNode: filterNode,
            maxCount: 1,
            itemVariable: listItemVar,
        });

        return new UpdateEntitiesQueryNode({
            rootEntityType,
            affectedFields,
            updates,
            currentEntityVariable,
            listNode,
            revision,
        });
    }

    private generateUpdateAllField(rootEntityType: RootEntityType): QueryNodeField | undefined {
        // we construct this field like a regular query field first so that the list augmentation works
        const fieldBase: QueryNodeField = {
            name: getUpdateAllEntitiesFieldName(rootEntityType),
            type: makeNonNullableList(this.outputTypeGenerator.generate(rootEntityType)),
            resolve: () => new EntitiesQueryNode(rootEntityType),
        };

        const fieldWithListArgs = this.listAugmentation.augment(fieldBase, rootEntityType, {
            orderByAugmentationOptions: {
                firstLimitCheckType: LimitTypeCheckType.RESULT_VALIDATOR,
                operation: 'mutation',
            },
        });

        const inputType =
            this.updateTypeGenerator.generateUpdateAllRootEntitiesInputType(rootEntityType);
        if (!inputType.fields.length) {
            // this can occur for types that only define relations as updateAll does not support relations
            return undefined;
        }
        return {
            ...fieldWithListArgs,
            args: {
                ...fieldWithListArgs.args,
                [MUTATION_INPUT_ARG]: {
                    type: new GraphQLNonNull(inputType.getInputType()),
                },
            },
            isSerial: true,
            description: `Updates ${rootEntityType.pluralName} that match a specified filter`,
            resolve: (_, args, info) =>
                this.generateUpdateAllQueryNode(
                    rootEntityType,
                    fieldWithListArgs.resolve(_, args, info),
                    inputType,
                    args[MUTATION_INPUT_ARG],
                    info,
                ),
        };
    }

    private generateUpdateAllQueryNode(
        rootEntityType: RootEntityType,
        listNode: QueryNode,
        inputType: UpdateRootEntityInputType,
        input: PlainObject,
        fieldContext: FieldContext,
    ): QueryNode {
        const checkResult = inputType.check(input, fieldContext);
        if (checkResult) {
            return checkResult;
        }

        const currentEntityVariable = new VariableQueryNode('currentEntity');
        const context: UpdateInputFieldContext = {
            ...fieldContext,
            currentEntityNode: currentEntityVariable,
        };
        const updates = inputType.getProperties(input, context);
        const affectedFields = inputType
            .getAffectedFields(input, context)
            .map((field) => new AffectedFieldInfoQueryNode(field));

        const updateEntityNode = new UpdateEntitiesQueryNode({
            rootEntityType,
            affectedFields,
            updates,
            currentEntityVariable,
            listNode,
        });
        const updatedIdsVarNode = new VariableQueryNode('updatedIds');
        const updateEntityPreExec = new PreExecQueryParms({
            query: updateEntityNode,
            resultVariable: updatedIdsVarNode,
        });

        if (inputType.getRelationStatements(input, new UnknownValueQueryNode(), context).length) {
            // should not occur because the input type generator skips these fields, but just to be sure
            throw new Error(`updateAll currently does not support relation statements`);
        }

        const idVar = new VariableQueryNode('id');
        const resultNode = new TransformListQueryNode({
            listNode: updatedIdsVarNode,
            itemVariable: idVar,
            innerNode: new EntityFromIdQueryNode(rootEntityType, idVar),
        });

        return new WithPreExecutionQueryNode({
            resultNode,
            preExecQueries: [updateEntityPreExec],
        });
    }

    private generateDeleteField(rootEntityType: RootEntityType): QueryNodeField {
        let description;
        if (rootEntityType.keyField) {
            description = `Deletes a ${rootEntityType.name} by id or ${rootEntityType.keyField.name}.\n\nYou should pass a non-null value to exactly one of the arguments.`;
        } else {
            description = `Deletes a ${rootEntityType.name} by id`;
        }

        return {
            name: getDeleteEntityFieldName(rootEntityType),
            type: this.outputTypeGenerator.generate(rootEntityType),
            args: {
                ...this.uniqueFieldArgumentsGenerator.getArgumentsForUniqueFields(rootEntityType),
                [REVISION_FIELD]: {
                    description: `Set this argument to the value of "${rootEntityType.name}.${REVISION_FIELD}" to abort the transaction if this object has been modified in the meantime`,
                    type: GraphQLID,
                },
            },
            isSerial: true,
            description,
            resolve: (source, args, info) =>
                this.generateDeleteQueryNode(rootEntityType, args, info),
        };
    }

    private generateDeleteQueryNode(
        rootEntityType: RootEntityType,
        args: { [name: string]: any },
        context: FieldContext,
    ): QueryNode {
        // collect the ids before the actual delete statements so the lists won't change by the statements
        const listNode = getEntitiesByUniqueFieldQuery(rootEntityType, args, context);
        const revision = args[REVISION_FIELD];
        const idsVariable = new VariableQueryNode('ids');
        const idsStatement = new PreExecQueryParms({
            // don't use optimizations here so we actually "see" the entities and don't just return the ids
            // this is relevant if there are accessGroup filters
            query: mapToIDNodesUnoptimized(listNode),
            resultVariable: idsVariable,
        });

        const deleteEntitiesNode = new DeleteEntitiesQueryNode({
            rootEntityType,
            listNode: idsVariable,
            entitiesIdentifierKind: EntitiesIdentifierKind.ID,
            revision,
        });

        const removeEdgesStatements = getPreEntityRemovalStatements(rootEntityType, idsVariable);

        // no preexec for the actual deletion here because we need to evaluate the result while the entity still exists
        // and it won't exist if already deleted in the pre-exec
        return new WithPreExecutionQueryNode({
            preExecQueries: [idsStatement, ...removeEdgesStatements],
            resultNode: new FirstOfListQueryNode(deleteEntitiesNode),
        });
    }

    private generateDeleteManyField(rootEntityType: RootEntityType): QueryNodeField {
        return {
            name: getDeleteEntitiesFieldName(rootEntityType),
            type: new QueryNodeListType(
                new QueryNodeNonNullType(this.outputTypeGenerator.generate(rootEntityType)),
            ),
            args: {
                ids: {
                    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))),
                    description: `The ids of the ${rootEntityType.pluralName} to be deleted`,
                },
            },
            isSerial: true,
            description: `Deletes multiple ${rootEntityType.pluralName} by their ids.\n\nIDs that are not found are silently ignored.`,
            resolve: (source, args, info) =>
                this.generateDeleteManyQueryNode(rootEntityType, args.ids, info),
        };
    }

    private generateDeleteManyQueryNode(
        rootEntityType: RootEntityType,
        ids: ReadonlyArray<string>,
        context: FieldContext,
    ): QueryNode {
        // collect the ids before the actual delete statements so the lists won't change by the statements
        const listNode = new ListQueryNode(
            ids.map((id) => new EntityFromIdQueryNode(rootEntityType, new LiteralQueryNode(id))),
        );
        const idsVariable = new VariableQueryNode('ids');
        const idsStatement = new PreExecQueryParms({
            // don't use optimizations here so we actually "see" the entities and don't just return the ids
            // this is relevant if there are accessGroup filters
            query: getFilterNode(
                mapToIDNodesUnoptimized(listNode),
                (entityVar) =>
                    new BinaryOperationQueryNode(
                        entityVar,
                        BinaryOperator.UNEQUAL,
                        new NullQueryNode(),
                    ),
            ),
            resultVariable: idsVariable,
        });

        const deleteEntitiesNode = new DeleteEntitiesQueryNode({
            rootEntityType,
            listNode: idsVariable,
            entitiesIdentifierKind: EntitiesIdentifierKind.ID,
        });

        const removeEdgesStatements = getPreEntityRemovalStatements(rootEntityType, idsVariable);

        // no preexec for the actual deletion here because we need to evaluate the result while the entity still exists
        // and it won't exist if already deleted in the pre-exec
        return new WithPreExecutionQueryNode({
            preExecQueries: [idsStatement, ...removeEdgesStatements],
            resultNode: deleteEntitiesNode,
        });
    }

    private generateDeleteAllField(rootEntityType: RootEntityType): QueryNodeField {
        // we construct this field like a regular query field first so that the list augmentation works
        const fieldBase: QueryNodeField = {
            name: getDeleteAllEntitiesFieldName(rootEntityType),
            type: makeNonNullableList(this.outputTypeGenerator.generate(rootEntityType)),
            resolve: () => new EntitiesQueryNode(rootEntityType),
        };

        const fieldWithListArgs = this.listAugmentation.augment(fieldBase, rootEntityType, {
            orderByAugmentationOptions: {
                firstLimitCheckType: LimitTypeCheckType.RESULT_VALIDATOR,
                operation: 'mutation',
            },
        });

        return {
            ...fieldWithListArgs,
            isSerial: true,
            description: `Deletes ${rootEntityType.pluralName} that match a specified filter`,
            resolve: (source, args, info) =>
                this.generateDeleteAllQueryNode(
                    rootEntityType,
                    fieldWithListArgs.resolve(source, args, info),
                ),
        };
    }

    private generateDeleteAllQueryNode(
        rootEntityType: RootEntityType,
        listNode: QueryNode,
    ): QueryNode {
        return generateDeleteAllQueryNode(rootEntityType, listNode);
    }
}
