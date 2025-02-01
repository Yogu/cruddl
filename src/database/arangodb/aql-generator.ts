import { AggregationOperator, Field, Relation, RootEntityType } from '../../model';
import { FieldSegment, RelationSegment } from '../../model/implementation/collect-path';
import { IDENTITY_ANALYZER } from '../../model/implementation/flex-search';
import {
    AddEdgesQueryNode,
    AggregationQueryNode,
    BasicType,
    BinaryOperationQueryNode,
    BinaryOperator,
    BinaryOperatorWithAnalyzer,
    ConcatListsQueryNode,
    ConditionalQueryNode,
    ConfirmForBillingQueryNode,
    ConstBoolQueryNode,
    ConstIntQueryNode,
    CountQueryNode,
    CreateBillingEntityQueryNode,
    CreateEntitiesQueryNode,
    CreateEntityQueryNode,
    DeleteEntitiesQueryNode,
    DeleteEntitiesResultValue,
    DynamicPropertyAccessQueryNode,
    EdgeIdentifier,
    EntitiesIdentifierKind,
    EntitiesQueryNode,
    EntityFromIdQueryNode,
    FieldPathQueryNode,
    FieldQueryNode,
    FirstOfListQueryNode,
    FollowEdgeQueryNode,
    ListItemQueryNode,
    ListQueryNode,
    LiteralQueryNode,
    MergeObjectsQueryNode,
    NullQueryNode,
    ObjectEntriesQueryNode,
    ObjectQueryNode,
    OperatorWithAnalyzerQueryNode,
    OrderDirection,
    OrderSpecification,
    PartialEdgeIdentifier,
    PropertyAccessQueryNode,
    QueryNode,
    QueryResultValidator,
    RemoveEdgesQueryNode,
    RevisionQueryNode,
    RootEntityIDQueryNode,
    RUNTIME_ERROR_CODE_PROPERTY,
    RUNTIME_ERROR_TOKEN,
    RuntimeErrorQueryNode,
    SafeListQueryNode,
    SetEdgeQueryNode,
    SetFieldQueryNode,
    TransformListQueryNode,
    TraversalQueryNode,
    TypeCheckQueryNode,
    UnaryOperationQueryNode,
    UnaryOperator,
    UpdateChildEntitiesQueryNode,
    UpdateEntitiesQueryNode,
    VariableAssignmentQueryNode,
    VariableQueryNode,
    WithPreExecutionQueryNode,
} from '../../query-tree';
import {
    FlexSearchComplexOperatorQueryNode,
    FlexSearchFieldExistsQueryNode,
    FlexSearchQueryNode,
    FlexSearchStartsWithQueryNode,
} from '../../query-tree/flex-search';
import { Quantifier, QuantifierFilterNode } from '../../query-tree/quantifiers';
import { extractVariableAssignments, simplifyBooleans } from '../../query-tree/utils';
import { not } from '../../schema-generation/utils/input-types';
import { Constructor, decapitalize, isReadonlyArray } from '../../utils/utils';
import { FlexSearchTokenizable } from '../database-adapter';
import { analyzeLikePatternPrefix } from '../like-helpers';
import {
    aql,
    AQLCollection,
    AQLCompoundQuery,
    AQLFragment,
    AQLQueryResultVariable,
    AQLVariable,
} from './aql';
import {
    billingCollectionName,
    getCollectionNameForRelation,
    getCollectionNameForRootEntity,
} from './arango-basics';
import { getFlexSearchViewNameForRootEntity } from './schema-migration/arango-search-helpers';
import { Clock, DefaultClock, IDGenerator, UUIDGenerator } from '../../execution/execution-options';

enum AccessType {
    /**
     * A collection that is used in a read-only operation and is explicitly specified in the AQL
     */
    EXPLICIT_READ = 'EXPLICIT_READ',

    /**
     * A collection that is used in a read-only operation but is not explicitly mentioned in the AQL
     * (e.g. the target document collection of an edge traversal)
     */
    IMPLICIT_READ = 'IMPLICIT_READ',

    /**
     * A collection that is used in a write operation and is explicitly specified in the AQL
     */
    WRITE = 'WRITE',
}

export interface QueryGenerationOptions {
    /**
     * An interface to determine the current date/time
     */
    readonly clock: Clock;

    /**
     * An interface to generate IDs, e.g. for new child entities.
     */
    readonly idGenerator: IDGenerator;
}

class QueryContext {
    private variableMap = new Map<VariableQueryNode, AQLFragment>();
    private preExecQueries: AQLCompoundQuery[] = [];
    private explicitlyReadAccessedCollections = new Set<string>();
    private implicitlyReadAccessedCollections = new Set<string>();
    private writeAccessedCollections = new Set<string>();
    private extensions: Map<unknown, unknown> | undefined;

    constructor(
        /**
         * Options that do not change within one query tree
         */
        readonly options: QueryGenerationOptions,
    ) {}

    /**
     * Creates a new QueryContext with an independent variable map except that all query result variables of this
     * context are available.
     */
    private newPreExecContext(): QueryContext {
        const newContext = new QueryContext(this.options);
        this.variableMap.forEach((aqlVar, varNode) => {
            if (aqlVar instanceof AQLQueryResultVariable) {
                newContext.variableMap.set(varNode, aqlVar);
            }
        });
        newContext.explicitlyReadAccessedCollections = this.explicitlyReadAccessedCollections;
        newContext.writeAccessedCollections = this.writeAccessedCollections;
        newContext.implicitlyReadAccessedCollections = this.implicitlyReadAccessedCollections;
        return newContext;
    }

    /**
     * Creates a new QueryContext that is identical to this one but has one additional variable binding
     * @param variableNode the variable token as it is referenced in the query tree
     * @param aqlVariable the variable token as it will be available within the AQL fragment
     */
    private newNestedContextWithVariableMapping(
        variableNode: VariableQueryNode,
        aqlVariable: AQLFragment,
    ): QueryContext {
        const newContext = new QueryContext(this.options);
        newContext.variableMap = new Map(this.variableMap);
        newContext.variableMap.set(variableNode, aqlVariable);
        newContext.preExecQueries = this.preExecQueries;
        newContext.explicitlyReadAccessedCollections = this.explicitlyReadAccessedCollections;
        newContext.writeAccessedCollections = this.writeAccessedCollections;
        newContext.implicitlyReadAccessedCollections = this.implicitlyReadAccessedCollections;
        return newContext;
    }

    /**
     * Creates a new QueryContext that is identical to this one but has one additional variable binding
     *
     * The AQLFragment for the variable will be available via getVariable().
     *
     * @param {VariableQueryNode} variableNode the variable as referenced in the query tree
     * @returns {QueryContext} the nested context
     */
    introduceVariable(variableNode: VariableQueryNode): QueryContext {
        if (this.variableMap.has(variableNode)) {
            throw new Error(`Variable ${variableNode} is introduced twice`);
        }
        const variable = new AQLVariable(variableNode.label);
        return this.newNestedContextWithVariableMapping(variableNode, variable);
    }

    /**
     * Creates a new QueryContext that is identical to this one but has one additional variable binding
     *
     * @param variableNode the variable as referenced in the query tree
     * @param existingVariable a variable that has been previously introduced with introduceVariable() and fetched by getVariable
     * @returns {QueryContext} the nested context
     */
    introduceVariableAlias(
        variableNode: VariableQueryNode,
        existingVariable: AQLFragment,
    ): QueryContext {
        return this.newNestedContextWithVariableMapping(variableNode, existingVariable);
    }

    /**
     * Creates a new QueryContext that includes an additional transaction step and adds resultVariable to the scope
     * which will contain the result of the query
     *
     * The preExecQuery is evaluated in an independent context that has access to all previous preExecQuery result
     * variables.
     *
     * @param preExecQuery the query to execute as transaction step
     * @param resultVariable the variable to store the query result
     * @param resultValidator an optional validator for the query result
     */
    addPreExecuteQuery(
        preExecQuery: QueryNode,
        resultVariable?: VariableQueryNode,
        resultValidator?: QueryResultValidator,
    ): QueryContext {
        let resultVar: AQLQueryResultVariable | undefined;
        let newContext: QueryContext;
        if (resultVariable) {
            resultVar = new AQLQueryResultVariable(resultVariable.label);
            newContext = this.newNestedContextWithVariableMapping(resultVariable, resultVar);
        } else {
            resultVar = undefined;
            newContext = this;
        }

        const aqlQuery = createAQLCompoundQuery(
            preExecQuery,
            resultVar,
            resultValidator,
            this.newPreExecContext(),
        );

        this.preExecQueries.push(aqlQuery);
        return newContext;
    }

    /**
     * Adds the information (in-place) that a collection is accessed
     */
    addCollectionAccess(collection: string, accessType: AccessType): void {
        switch (accessType) {
            case AccessType.EXPLICIT_READ:
                this.explicitlyReadAccessedCollections.add(collection);
                break;
            case AccessType.IMPLICIT_READ:
                this.implicitlyReadAccessedCollections.add(collection);
                break;
            case AccessType.WRITE:
                this.writeAccessedCollections.add(collection);
                break;
        }
    }

    withExtension(key: unknown, value: unknown): QueryContext {
        const newContext = new QueryContext(this.options);
        newContext.variableMap = this.variableMap;
        newContext.explicitlyReadAccessedCollections = this.explicitlyReadAccessedCollections;
        newContext.writeAccessedCollections = this.writeAccessedCollections;
        newContext.implicitlyReadAccessedCollections = this.implicitlyReadAccessedCollections;
        newContext.extensions = new Map([
            ...(this.extensions ? this.extensions.entries() : []),
            [key, value],
        ]);
        return newContext;
    }

    getExtension(key: unknown): unknown {
        if (!this.extensions) {
            return undefined;
        }
        return this.extensions.get(key);
    }

    /**
     * Gets an AQLFragment that evaluates to the value of a variable in the current scope
     */
    getVariable(variableNode: VariableQueryNode): AQLVariable {
        const variable = this.variableMap.get(variableNode);
        if (!variable) {
            throw new Error(`Variable ${variableNode.toString()} is used but not introduced`);
        }
        return variable;
    }

    getPreExecuteQueries(): ReadonlyArray<AQLCompoundQuery> {
        return this.preExecQueries;
    }

    /**
     * Gets the names of all collections that are read by this query, be it explicit or implicit
     */
    getReadAccessedCollections(): ReadonlyArray<string> {
        const set = new Set([
            ...this.explicitlyReadAccessedCollections,
            ...this.implicitlyReadAccessedCollections,
        ]);
        return Array.from(set);
    }

    getWriteAccessedCollections(): ReadonlyArray<string> {
        return Array.from(this.writeAccessedCollections);
    }

    /**
     * Gets the names of all collections that are read by this query, but are not necessarily
     * referenced explicitly within it (to be used with the WITH statement)
     */
    getImplicitlyReadAccessedCollections(): ReadonlyArray<string> {
        return Array.from(this.implicitlyReadAccessedCollections);
        // note: we could remove the explicitly accessed collections here, but this is currently a
        // bit hard because the collection sets are shared across the whole transaction and not
        // scoped to a single query
    }
}

function createAQLCompoundQuery(
    node: QueryNode,
    resultVariable: AQLQueryResultVariable | undefined,
    resultValidator: QueryResultValidator | undefined,
    context: QueryContext,
): AQLCompoundQuery {
    // move LET statements up
    // they often occur for value objects / entity extensions
    // this avoids the FIRST() and the subquery which reduces load on the AQL query optimizer
    let variableAssignments: AQLFragment[] = [];
    const variableAssignmentNodes: VariableAssignmentQueryNode[] = [];
    node = extractVariableAssignments(node, variableAssignmentNodes);
    for (const assignmentNode of variableAssignmentNodes) {
        context = context.introduceVariable(assignmentNode.variableNode);
        const tmpVar = context.getVariable(assignmentNode.variableNode);
        variableAssignments.push(
            aql`LET ${tmpVar} = ${processNode(assignmentNode.variableValueNode, context)}`,
        );
    }

    const statements = [...variableAssignments, aql`RETURN ${processNode(node, context)}`];

    // do this after processNode is called so the context is populated
    const implicitlyReadAccessedCollections = context.getImplicitlyReadAccessedCollections();
    let withStatements: AQLFragment[];
    if (implicitlyReadAccessedCollections.length) {
        const collectionFragments = implicitlyReadAccessedCollections.map(
            (collectionName) => new AQLCollection(collectionName),
        );
        withStatements = [aql`WITH ${aql.join(collectionFragments, aql`, `)}`];
    } else {
        withStatements = [];
    }

    const aqlQuery = aql.lines(...[...withStatements, ...statements]);
    const preExecQueries = context.getPreExecuteQueries();
    const readAccessedCollections = context.getReadAccessedCollections();
    const writeAccessedCollections = context.getWriteAccessedCollections();

    return new AQLCompoundQuery(
        preExecQueries,
        aqlQuery,
        resultVariable,
        resultValidator,
        readAccessedCollections,
        writeAccessedCollections,
    );
}

type NodeProcessor<T extends QueryNode> = (node: T, context: QueryContext) => AQLFragment;

const inFlexSearchFilterSymbol = Symbol('inFlexSearchFilter');

namespace aqlExt {
    export function safeJSONKey(key: string): AQLFragment {
        if (aql.isSafeIdentifier(key)) {
            // we could always collide with a (future) keyword, so use "name" syntax instead of identifier
            // ("" looks more natural than `` in json keys)
            return aql`${aql.string(key)}`;
        } else {
            return aql`${key}`; // fall back to bound values
        }
    }

    export function parenthesizeList(...content: AQLFragment[]): AQLFragment {
        return aql.lines(aql`(`, aql.indent(aql.lines(...content)), aql`)`);
    }

    export function parenthesizeObject(...content: AQLFragment[]): AQLFragment {
        return aql`FIRST${parenthesizeList(...content)}`;
    }
}

const processors = new Map<Constructor<QueryNode>, NodeProcessor<QueryNode>>();

function register<T extends QueryNode>(type: Constructor<T>, processor: NodeProcessor<T>) {
    processors.set(type, processor as NodeProcessor<QueryNode>); // probably some bivariancy issue
}

register(LiteralQueryNode, (node) => {
    return aql.value(node.value);
});

register(NullQueryNode, () => {
    return aql`null`;
});

register(RuntimeErrorQueryNode, (node) => {
    const runtimeErrorToken = aql.code(RUNTIME_ERROR_TOKEN);
    if (node.code) {
        const codeProp = aql.code(RUNTIME_ERROR_CODE_PROPERTY);
        return aql`{ ${codeProp}: ${node.code}, ${runtimeErrorToken}: ${node.message} }`;
    }
    return aql`{ ${runtimeErrorToken}: ${node.message} }`;
});

register(ConstBoolQueryNode, (node) => {
    return node.value ? aql`true` : aql`false`;
});

register(ConstIntQueryNode, (node) => {
    return aql.integer(node.value);
});

register(ObjectQueryNode, (node, context) => {
    if (!node.properties.length) {
        return aql`{}`;
    }

    const properties = node.properties.map(
        (p) => aql`${aqlExt.safeJSONKey(p.propertyName)}: ${processNode(p.valueNode, context)}`,
    );
    return aql.lines(aql`{`, aql.indent(aql.join(properties, aql`,\n`)), aql`}`);
});

register(ListQueryNode, (node, context) => {
    if (!node.itemNodes.length) {
        return aql`[]`;
    }

    return aql.lines(
        aql`[`,
        aql.indent(
            aql.join(
                node.itemNodes.map((itemNode) => processNode(itemNode, context)),
                aql`,\n`,
            ),
        ),
        aql`]`,
    );
});

register(ConcatListsQueryNode, (node, context) => {
    const listNodes = node.listNodes.map((node) => processNode(node, context));
    const listNodeStr = aql.join(listNodes, aql`, `);
    // note: UNION just appends, there is a special UNION_DISTINCT to filter out duplicates
    return aql`UNION(${listNodeStr})`;
});

register(VariableQueryNode, (node, context) => {
    return context.getVariable(node);
});

register(VariableAssignmentQueryNode, (node, context) => {
    const newContext = context.introduceVariable(node.variableNode);
    const tmpVar = newContext.getVariable(node.variableNode);

    // note that we have to know statically if the context var is a list or an object
    // assuming object here because lists are not needed currently
    return aqlExt.parenthesizeObject(
        aql`LET ${tmpVar} = ${processNode(node.variableValueNode, newContext)}`,
        aql`RETURN ${processNode(node.resultNode, newContext)}`,
    );
});

register(WithPreExecutionQueryNode, (node, context) => {
    let currentContext = context;
    for (const preExecParm of node.preExecQueries) {
        currentContext = currentContext.addPreExecuteQuery(
            preExecParm.query,
            preExecParm.resultVariable,
            preExecParm.resultValidator,
        );
    }

    return aql`${processNode(node.resultNode, currentContext)}`;
});

register(EntityFromIdQueryNode, (node, context) => {
    // the DOCUMENT() function only dynamically refers to the collection name, so the coordinators
    // do not know about the collections. Therefore, these are implicit reads.
    // We should refactor DOCUMENT() to collection traversals in the future to enable optimizations.
    const collection = getCollectionForType(node.rootEntityType, AccessType.IMPLICIT_READ, context);
    return aql`DOCUMENT(${collection}, ${processNode(node.idNode, context)})`;
});

register(PropertyAccessQueryNode, (node, context) => {
    const object = processNode(node.objectNode, context);
    return aql`${object}${getPropertyAccessFragment(node.propertyName)}`;
});

register(FieldQueryNode, (node, context) => {
    const object = processNode(node.objectNode, context);
    return aql`${object}${getPropertyAccessFragment(node.field.name)}`;
});

register(DynamicPropertyAccessQueryNode, (node, context) => {
    const object = processNode(node.objectNode, context);
    return aql`${object}[${processNode(node.propertyNode, context)}]`;
});

register(FieldPathQueryNode, (node, context) => {
    const object = processNode(node.objectNode, context);
    return aql`${object}${getFieldPathAccessFragment(node.path)}`;
});

function getPropertyAccessFragment(propertyName: string) {
    if (aql.isSafeIdentifier(propertyName)) {
        return aql`.${aql.identifier(propertyName)}`;
    }
    // fall back to bound values. do not attempt aql.string for security reasons - should not be the case normally, anyway.
    return aql`[${propertyName}]`;
}

function getFieldPathAccessFragment(path: ReadonlyArray<Field>): AQLFragment {
    if (path.length > 0) {
        const [head, ...tail] = path;
        return aql`${getPropertyAccessFragment(head.name)}${getFieldPathAccessFragment(tail)}`;
    } else {
        return aql``;
    }
}

register(RootEntityIDQueryNode, (node, context) => {
    return aql`${processNode(node.objectNode, context)}._key`; // ids are stored in _key field
});

register(RevisionQueryNode, (node, context) => {
    return aql`${processNode(node.objectNode, context)}._rev`;
});

register(FlexSearchQueryNode, (node, context) => {
    let itemContext = context
        .introduceVariable(node.itemVariable)
        .withExtension(inFlexSearchFilterSymbol, true);
    const viewName = getFlexSearchViewNameForRootEntity(node.rootEntityType!);
    context.addCollectionAccess(viewName, AccessType.EXPLICIT_READ);
    return aqlExt.parenthesizeList(
        aql`FOR ${itemContext.getVariable(node.itemVariable)}`,
        aql`IN ${aql.collection(viewName)}`,
        aql`SEARCH ${processNode(node.flexFilterNode, itemContext)}`,
        node.isOptimisationsDisabled ? aql`OPTIONS { conditionOptimization: 'none' }` : aql``,
        aql`RETURN ${itemContext.getVariable(node.itemVariable)}`,
    );
});

register(TransformListQueryNode, (node, context) => {
    let itemContext = context.introduceVariable(node.itemVariable);
    const itemVar = itemContext.getVariable(node.itemVariable);
    let itemProjectionContext = itemContext;

    // move LET statements up
    // they often occur for value objects / entity extensions
    // this avoids the FIRST() and the subquery which reduces load on the AQL query optimizer
    let variableAssignments: AQLFragment[] = [];
    let innerNode = node.innerNode;
    const variableAssignmentNodes: VariableAssignmentQueryNode[] = [];
    innerNode = extractVariableAssignments(innerNode, variableAssignmentNodes);
    for (const assignmentNode of variableAssignmentNodes) {
        itemProjectionContext = itemProjectionContext.introduceVariable(
            assignmentNode.variableNode,
        );
        const tmpVar = itemProjectionContext.getVariable(assignmentNode.variableNode);
        variableAssignments.push(
            aql`LET ${tmpVar} = ${processNode(
                assignmentNode.variableValueNode,
                itemProjectionContext,
            )}`,
        );
    }

    return aqlExt.parenthesizeList(
        aql`FOR ${itemVar}`,
        generateInClauseWithFilterAndOrderAndLimit({ node, context, itemContext, itemVar }),
        ...variableAssignments,
        aql`RETURN ${processNode(innerNode, itemProjectionContext)}`,
    );
});

/**
 * Generates an IN... clause for a TransformListQueryNode to be used within a query / subquery (FOR ... IN ...)
 */
function generateInClauseWithFilterAndOrderAndLimit({
    node,
    context,
    itemVar,
    itemContext,
}: {
    node: TransformListQueryNode;
    context: QueryContext;
    itemVar: AQLVariable;
    itemContext: QueryContext;
}) {
    let list: AQLFragment;
    let filterDanglingEdges = aql``;
    if (node.listNode instanceof FollowEdgeQueryNode) {
        list = getSimpleFollowEdgeFragment(node.listNode, context);
        filterDanglingEdges = aql`FILTER ${itemVar} != null`;
    } else {
        list = processNode(node.listNode, context);
    }
    let filter = simplifyBooleans(node.filterNode);

    let limitClause;
    if (node.maxCount != undefined) {
        if (node.skip === 0) {
            limitClause = aql`LIMIT ${node.maxCount}`;
        } else {
            limitClause = aql`LIMIT ${node.skip}, ${node.maxCount}`;
        }
    } else if (node.skip > 0) {
        limitClause = aql`LIMIT ${node.skip}, ${Number.MAX_SAFE_INTEGER}`;
    } else {
        limitClause = aql``;
    }

    return aql.lines(
        aql`IN ${list}`,
        filter instanceof ConstBoolQueryNode && filter.value
            ? aql``
            : aql`FILTER ${processNode(filter, itemContext)}`,
        filterDanglingEdges,
        generateSortAQL(node.orderBy, itemContext),
        limitClause,
    );
}

/**
 * Generates an IN... clause for a list to be used within a query / subquery (FOR ... IN ...)
 */
function generateInClause(node: QueryNode, context: QueryContext, entityVar: AQLFragment) {
    if (node instanceof TransformListQueryNode && node.innerNode === node.itemVariable) {
        const itemContext = context.introduceVariableAlias(node.itemVariable, entityVar);
        return generateInClauseWithFilterAndOrderAndLimit({
            node,
            itemContext,
            itemVar: entityVar,
            context,
        });
    }

    return aql`IN ${processNode(node, context)}`;
}

register(CountQueryNode, (node, context) => {
    if (node.listNode instanceof FieldQueryNode || node.listNode instanceof EntitiesQueryNode) {
        // These cases are known to be optimized
        // TODO this does not catch the safe-list case (list ? list : []), where we could optimize to (list ? LENGTH(list) : 0)
        // so we probably need to add an optimization to the query tree builder
        return aql`LENGTH(${processNode(node.listNode, context)})`;
    }

    // in the general case (mostly a TransformListQueryNode), it is better to use the COLLeCT WITH COUNT syntax
    // because it avoids building the whole collection temporarily in memory
    // however, https://docs.arangodb.com/3.2/AQL/Examples/Counting.html does not really mention this case, so we
    // should evaluate it again
    // note that ArangoDB's inline-subqueries rule optimizes for the case where listNode is a TransformList again.
    const itemVar = aql.variable('item');
    const countVar = aql.variable('count');
    return aqlExt.parenthesizeObject(
        aql`FOR ${itemVar}`,
        aql`IN ${processNode(node.listNode, context)}`,
        aql`COLLECT WITH COUNT INTO ${countVar}`,
        aql`RETURN ${countVar}`,
    );
});

register(AggregationQueryNode, (node, context) => {
    const itemVar = aql.variable('item');
    const aggregationVar = aql.variable(node.operator.toLowerCase());
    let aggregationFunction: AQLFragment | undefined;
    let filterFrag: AQLFragment | undefined;
    let itemFrag = itemVar;
    let resultFragment = aggregationVar;
    let isList = false;
    let distinct = false;
    let sort = false;
    switch (node.operator) {
        case AggregationOperator.MIN:
            filterFrag = aql`${itemVar} != null`;
            aggregationFunction = aql`MIN`;
            break;
        case AggregationOperator.MAX:
            filterFrag = aql`${itemVar} != null`;
            aggregationFunction = aql`MAX`;
            break;
        case AggregationOperator.SUM:
            filterFrag = aql`${itemVar} != null`;
            aggregationFunction = aql`SUM`;
            resultFragment = aql`${resultFragment} != null ? ${resultFragment} : 0`; // SUM([]) === 0
            break;
        case AggregationOperator.AVERAGE:
            filterFrag = aql`${itemVar} != null`;
            aggregationFunction = aql`AVERAGE`;
            break;

        case AggregationOperator.COUNT:
            aggregationFunction = aql`COUNT`;
            break;
        case AggregationOperator.SOME:
            aggregationFunction = aql`COUNT`;
            resultFragment = aql`${resultFragment} > 0`;
            break;
        case AggregationOperator.NONE:
            aggregationFunction = aql`COUNT`;
            resultFragment = aql`${resultFragment} == 0`;
            break;

        // using MAX >= true in place of SOME
        //   and MAX <  true in place of NONE
        // (basically, MAX is similar to SOME, and NONE is !SOME. Can't use MIN for EVERY because MIN([]) = null.)
        case AggregationOperator.SOME_NULL:
            itemFrag = aql`${itemFrag} == null`;
            aggregationFunction = aql`MAX`;
            resultFragment = aql`${resultFragment} >= true`;
            break;
        case AggregationOperator.SOME_NOT_NULL:
            itemFrag = aql`${itemFrag} != null`;
            aggregationFunction = aql`MAX`;
            resultFragment = aql`${resultFragment} >= true`;
            break;
        case AggregationOperator.NONE_NULL:
            itemFrag = aql`${itemFrag} == null`;
            aggregationFunction = aql`MAX`;
            resultFragment = aql`${resultFragment} < true`;
            break;
        case AggregationOperator.EVERY_NULL:
            // -> NONE_NOT_NULL
            itemFrag = aql`${itemFrag} != null`;
            aggregationFunction = aql`MAX`;
            resultFragment = aql`${resultFragment} < true`;
            break;
        case AggregationOperator.COUNT_NULL:
            aggregationFunction = aql`COUNT`;
            filterFrag = aql`${itemVar} == null`;
            break;
        case AggregationOperator.COUNT_NOT_NULL:
            aggregationFunction = aql`COUNT`;
            filterFrag = aql`${itemVar} != null`;
            break;

        // these treat NULL like FALSE, so don't filter them away
        // using MAX >= true in place of SOME
        //   and MAX <  true in place of NONE
        // (basically, MAX is similar to SOME, and NONE is !SOME. Can't use MIN for EVERY because MIN([]) = null.)
        case AggregationOperator.SOME_TRUE:
            aggregationFunction = aql`MAX`;
            resultFragment = aql`${resultFragment} >= true`;
            break;
        case AggregationOperator.SOME_NOT_TRUE:
            itemFrag = aql`!${itemFrag}`;
            aggregationFunction = aql`MAX`;
            resultFragment = aql`${resultFragment} >= true`;
            break;
        case AggregationOperator.EVERY_TRUE:
            // -> NONE_NOT_TRUE
            itemFrag = aql`!${itemFrag}`;
            aggregationFunction = aql`MAX`;
            resultFragment = aql`${resultFragment} < true`;
            break;
        case AggregationOperator.NONE_TRUE:
            aggregationFunction = aql`MAX`;
            resultFragment = aql`${resultFragment} < true`;
            break;
        case AggregationOperator.COUNT_TRUE:
            aggregationFunction = aql`COUNT`;
            filterFrag = aql`${itemVar} >= true`;
            break;
        case AggregationOperator.COUNT_NOT_TRUE:
            aggregationFunction = aql`COUNT`;
            filterFrag = aql`${itemVar} < true`;
            break;

        // these should also remove NULL values by definition
        case AggregationOperator.DISTINCT:
            // use COLLECT a = a instead of RETURN DISTINCT to be able to sort
            distinct = true;
            filterFrag = aql`${itemVar} != null`;
            isList = true;
            sort = node.sort;
            break;

        case AggregationOperator.COUNT_DISTINCT:
            aggregationFunction = aql`COUNT_DISTINCT`;
            filterFrag = aql`${itemVar} != null`;
            break;

        default:
            throw new Error(`Unsupported aggregator: ${(node as any).aggregationOperator}`);
    }
    return aqlExt[isList ? 'parenthesizeList' : 'parenthesizeObject'](
        aql`FOR ${itemVar}`,
        aql`IN ${processNode(node.listNode, context)}`,
        filterFrag ? aql`FILTER ${filterFrag}` : aql``,
        sort ? aql`SORT ${itemVar}` : aql``,
        aggregationFunction
            ? aql`COLLECT AGGREGATE ${aggregationVar} = ${aggregationFunction}(${itemFrag})`
            : distinct
              ? aql`COLLECT ${aggregationVar} = ${itemFrag}`
              : aql``,
        aql`RETURN ${resultFragment}`,
    );
});

register(UpdateChildEntitiesQueryNode, (node, context) => {
    const itemsVar = aql.variable('items');
    const itemsWithIndexVar = aql.variable('itemsWithIndex');
    const childContext = context.introduceVariable(node.dictionaryVar);
    const dictVar = childContext.getVariable(node.dictionaryVar);
    const updatedDictVar = aql.variable('updatedDict');
    const itemVar = aql.variable('item');
    const indexVar = aql.variable('indexVar');

    return aqlExt.parenthesizeList(
        // could be a complex expression, and we're using it multiple times -> store in a variable
        aql`LET ${itemsVar} = ${processNode(node.originalList, context)}`,

        // add a __index property to each item so we can sort by this later
        // regular field names cannot start with an underscore, so we're safe to use __index as a
        // temporary property to store the index of the child entity in the list
        aql`LET ${itemsWithIndexVar} = ${aqlExt.parenthesizeList(
            aql`FOR ${indexVar}`,
            // 0..-1 would evaluate to [0, -1], so the ZIP would complain because the right side
            // has more entries (2) than the left (0). RANGE() behaves the same
            aql`IN LENGTH(${itemsVar}) > 0 ? 0..(LENGTH(${itemsVar}) - 1) : []`,
            aql`RETURN MERGE(NTH(${itemsVar}, ${indexVar}), { __index: ${indexVar} })`,
        )}`,

        // convert the list into a dict object like { 'id1': { ...}, 'id2': { ... } }
        // this allows us to efficiently look up individual objects (to avoid quadratic runtime)
        aql`LET ${dictVar} = ZIP(${itemsVar}[*].id, ${itemsWithIndexVar})`,

        // merging the updated items into the dict to remove the old versions of the updated items
        aql`LET ${updatedDictVar} = MERGE(${dictVar}, {`,
        aql.indent(
            aql.join(
                node.updates.map((update): AQLFragment => {
                    const idFrag = processNode(update.idNode, childContext);
                    // we're expecting the newChildEntityNode to merge the untouched properties of
                    // the old item, including __index
                    const valueFrag = processNode(update.newChildEntityNode, childContext);
                    return aql`${idFrag}: ${valueFrag}`;
                }),
                aql`,\n`,
            ),
        ),
        aql`})`,

        // sort by the __index we stored,
        // filter out objects that were included in node.updates() but did not actually exist in node.originalList
        // (for them, __index is not set)
        // and unpack the dictionary into a list again
        aql`FOR ${itemVar}`,
        aql`IN VALUES(${updatedDictVar})`,
        aql`FILTER ${itemVar}.__index != null`,
        aql`SORT ${itemVar}.__index`,
        aql`RETURN UNSET(${itemVar}, '__index')`,
    );
});

register(MergeObjectsQueryNode, (node, context) => {
    const objectList = node.objectNodes.map((node) => processNode(node, context));
    const objectsFragment = aql.join(objectList, aql`, `);
    return aql`MERGE(${objectsFragment})`;
});

register(ObjectEntriesQueryNode, (node, context) => {
    const objectVar = aql.variable('object');
    const keyVar = aql.variable('key');
    return aqlExt.parenthesizeList(
        aql`LET ${objectVar} = ${processNode(node.objectNode, context)}`,
        aql`FOR ${keyVar} IN IS_DOCUMENT(${objectVar}) ? ATTRIBUTES(${objectVar}) : []`,
        aql`RETURN [ ${keyVar}, ${objectVar}[${keyVar}] ]`,
    );
});

register(FirstOfListQueryNode, (node, context) => {
    return aql`FIRST(${processNode(node.listNode, context)})`;
});

register(ListItemQueryNode, (node, context) => {
    return aql`(${processNode(node.listNode, context)})[${node.index}]`;
});

register(BinaryOperationQueryNode, (node, context) => {
    const lhs = processNode(node.lhs, context);

    // a > NULL is equivalent to a != NULL, and it can use indices better
    // (but don't do it in flexsearch, there > NULL is something different from != NULL
    if (
        node.operator === BinaryOperator.UNEQUAL &&
        (node.rhs instanceof NullQueryNode ||
            (node.rhs instanceof LiteralQueryNode && node.rhs.value == undefined)) &&
        !context.getExtension(inFlexSearchFilterSymbol)
    ) {
        return aql`(${lhs} > NULL)`;
    }

    const rhs = processNode(node.rhs, context);
    const op = getAQLOperator(node.operator);
    if (op) {
        return aql`(${lhs} ${op} ${rhs})`;
    }

    switch (node.operator) {
        case BinaryOperator.CONTAINS:
            return aql`(${lhs} LIKE CONCAT("%", ${rhs}, "%"))`;
        case BinaryOperator.STARTS_WITH:
            const slowFrag = aql`(LEFT(${lhs}, LENGTH(${rhs})) == ${rhs})`;
            if (node.rhs instanceof LiteralQueryNode && typeof node.rhs.value === 'string') {
                const fastFrag = getFastStartsWithQuery(lhs, node.rhs.value);
                // still ned to use the slow frag to get case sensitiveness
                // this is really bad for performance, see explanation in LIKE branch below
                return aql`${fastFrag} && ${slowFrag}`;
            }
            return slowFrag;
        case BinaryOperator.ENDS_WITH:
            return aql`(RIGHT(${lhs}, LENGTH(${rhs})) == ${rhs})`;
        case BinaryOperator.LIKE:
            const slowLikeFrag = aql`LIKE(${lhs}, ${rhs}, true)`; // true: caseInsensitive
            if (node.rhs instanceof LiteralQueryNode && typeof node.rhs.value === 'string') {
                const { literalPrefix, isSimplePrefixPattern, isLiteralPattern } =
                    analyzeLikePatternPrefix(node.rhs.value);

                if (isLiteralPattern) {
                    return getEqualsIgnoreCaseQuery(lhs, literalPrefix);
                }

                const fastFrag = getFastStartsWithQuery(lhs, literalPrefix);
                if (isSimplePrefixPattern) {
                    // we can optimize the whole LIKE away and use a skiplist-index-optimizable range select
                    return fastFrag;
                }
                // we can at least use the prefix search to narrow down the results
                // however, this is way worse because we lose the ability to sort-and-then-limit using the same index
                // -> queries with a "first" argument suddenly have the time complexity of the pre-limited
                // (or even pre-filtered if the database decides to use the index for sorting) result size instead of
                // being in O(first).
                return aql`(${fastFrag} && ${slowLikeFrag})`;
            }
            return slowLikeFrag;
        case BinaryOperator.APPEND:
            return aql`CONCAT(${lhs}, ${rhs})`;
        case BinaryOperator.PREPEND:
            return aql`CONCAT(${rhs}, ${lhs})`;
        case BinaryOperator.SUBTRACT_LISTS:
            return aql`MINUS(${lhs}, ${rhs})`;
        default:
            throw new Error(`Unsupported binary operator: ${op}`);
    }
});

register(OperatorWithAnalyzerQueryNode, (node, context) => {
    const lhs = processNode(node.lhs, context);
    const rhs = processNode(node.rhs, context);
    const analyzer = node.analyzer;

    const isIdentityAnalyzer = !node.analyzer || node.analyzer === IDENTITY_ANALYZER;
    // some operators support case-converting analyzers (like norm_ci) which only generate one token
    const normalizedRhs = isIdentityAnalyzer ? rhs : aql`TOKENS(${rhs}, ${analyzer})[0]`;

    switch (node.operator) {
        case BinaryOperatorWithAnalyzer.EQUAL:
            return aql`ANALYZER( ${lhs} == ${normalizedRhs},${analyzer})`;
        case BinaryOperatorWithAnalyzer.UNEQUAL:
            return aql`ANALYZER( ${lhs} != ${normalizedRhs},${analyzer})`;
        case BinaryOperatorWithAnalyzer.IN:
            if (isIdentityAnalyzer) {
                return aql`(${lhs} IN ${rhs})`;
            }
            const loopVar = aql.variable(`token`);
            return aql`ANALYZER( ${lhs} IN ( FOR ${loopVar} IN TOKENS(${rhs} , ${analyzer}) RETURN ${loopVar}[0] ), ${analyzer} )`;
        case BinaryOperatorWithAnalyzer.FLEX_SEARCH_CONTAINS_ANY_WORD:
            return aql`ANALYZER( ${lhs} IN TOKENS(${rhs}, ${analyzer}),${analyzer})`;
        case BinaryOperatorWithAnalyzer.FLEX_SEARCH_CONTAINS_PREFIX:
            // can't pass NULL to STARTS_WITH (generates an error)
            // if an expression does not have a token, nothing can contain a prefix thereof, so we don't find anything
            // this is also good behavior in case of searching because you just find nothing if you type special chars
            // instead of finding everything
            return aql`(LENGTH(TOKENS(${rhs},${analyzer})) ? ANALYZER( STARTS_WITH( ${lhs}, TOKENS(${rhs},${analyzer})[0]), ${analyzer}) : false)`;
        case BinaryOperatorWithAnalyzer.FLEX_SEARCH_CONTAINS_PHRASE:
            return aql`ANALYZER( PHRASE( ${lhs}, ${rhs}), ${analyzer})`;
        case BinaryOperatorWithAnalyzer.FLEX_STRING_LESS_THAN:
            return aql`ANALYZER( IN_RANGE(${lhs}, ${''} , ${normalizedRhs}, true, false), ${analyzer})`;
        case BinaryOperatorWithAnalyzer.FLEX_STRING_LESS_THAN_OR_EQUAL:
            return aql`ANALYZER( IN_RANGE(${lhs}, ${''} , ${normalizedRhs}, true, true), ${analyzer})`;
        case BinaryOperatorWithAnalyzer.FLEX_STRING_GREATER_THAN:
            return aql`ANALYZER( IN_RANGE(${lhs}, ${normalizedRhs}, ${String.fromCodePoint(
                0x10ffff,
            )}, false, true), ${analyzer})`;
        case BinaryOperatorWithAnalyzer.FLEX_STRING_GREATER_THAN_OR_EQUAL:
            return aql`ANALYZER( IN_RANGE(${lhs}, ${normalizedRhs}, ${String.fromCodePoint(
                0x10ffff,
            )}, true, true), ${analyzer})`;
        default:
            throw new Error(`Unsupported operator: ${node.operator}`);
    }
});

register(FlexSearchStartsWithQueryNode, (node, context) => {
    const lhs = processNode(node.lhs, context);
    const rhs = processNode(node.rhs, context);

    if (!node.analyzer || node.analyzer === IDENTITY_ANALYZER) {
        return aql`STARTS_WITH(${lhs}, ${rhs})`;
    }

    // This query node can be used with simple case-converting analyzers
    // These case-converting analyzers will only ever result in one token, so we can use the first one, which
    // is the input value case-converted.
    return aql`ANALYZER(STARTS_WITH(${lhs}, TOKENS(${rhs},${node.analyzer})[0]), ${node.analyzer})`;
});

register(FlexSearchFieldExistsQueryNode, (node, context) => {
    const sourceNode = processNode(node.sourceNode, context);
    // the EXISTS operand seems to return false for identity-indexed fields that are not strings
    // might be a bug, didn't find anything related in the documentation
    // not sure what exactly the consequences are of just omitting the analyzer (would mean we consider fields that
    // are both identity-indexed and full-text-indexed as existing if they only exist in the fulltext analyzer, but
    // that would never occur because it does not make sense)
    if (node.analyzer && node.analyzer !== IDENTITY_ANALYZER) {
        return aql`EXISTS(${sourceNode}, "analyzer", ${node.analyzer})`;
    } else {
        return aql`EXISTS(${sourceNode})`;
    }
});

register(FlexSearchComplexOperatorQueryNode, (node, context) => {
    throw new Error(
        `Internal Error: FlexSearchComplexOperatorQueryNode must be expanded before generating the query.`,
    );
});

function getBillingInput(
    node: ConfirmForBillingQueryNode | CreateBillingEntityQueryNode,
    key: string | number | AQLFragment,
    context: QueryContext,
    currentTimestamp: string,
) {
    return aql`
        key: ${key},
        type: ${node.rootEntityTypeName},
        category: ${processNode(node.categoryNode, context)},
        quantity: ${processNode(node.quantityNode, context)},
        isExported: false,
        createdAt: ${currentTimestamp},
        updatedAt: ${currentTimestamp}`;
}

register(CreateBillingEntityQueryNode, (node, context) => {
    const currentTimestamp = context.options.clock.getCurrentTimestamp();
    return aqlExt.parenthesizeList(
        aql`UPSERT {
            key: ${node.key},
            type: ${node.rootEntityTypeName}
        }`,
        aql`INSERT {
            ${getBillingInput(node, node.key, context, currentTimestamp)},
            isConfirmedForExport: false
         }`,
        aql`UPDATE (OLD.isConfirmedForExport ? {} : {
            updatedAt: ${currentTimestamp},
            category: ${processNode(node.categoryNode, context)},
            quantity: ${processNode(node.quantityNode, context)}
        })`,
        aql`IN ${getCollectionForBilling(AccessType.WRITE, context)}`,
        aql`RETURN ${node.key}`,
    );
});

register(ConfirmForBillingQueryNode, (node, context) => {
    const key = processNode(node.keyNode, context);
    const currentTimestamp = context.options.clock.getCurrentTimestamp();
    return aqlExt.parenthesizeList(
        aql`UPSERT {
            key: ${key},
            type: ${node.rootEntityTypeName}
        }`,
        aql`INSERT {
            ${getBillingInput(node, key, context, currentTimestamp)},
            isConfirmedForExport: true,
            confirmedForExportAt: ${currentTimestamp}
         }`,
        aql`UPDATE (OLD.isConfirmedForExport ? {} : {
            isConfirmedForExport: true,
            updatedAt: ${currentTimestamp},
            confirmedForExportAt: ${currentTimestamp},
            category: ${processNode(node.categoryNode, context)},
            quantity: ${processNode(node.quantityNode, context)}
        })`,
        aql`IN ${getCollectionForBilling(AccessType.WRITE, context)}`,
        aql`RETURN true`,
    );
});

function getFastStartsWithQuery(lhs: AQLFragment, rhsValue: string): AQLFragment {
    if (!rhsValue.length) {
        return aql`IS_STRING(${lhs})`;
    }

    // this function assumes that a collator is used that places upper and lower case of characters next to each other.
    // It also assumes that strings are always placed immediately after all case-variants of its one-character shorter prefix.
    // It also assumes that \u10ffff is always the last character in order
    // For example, this is the sort behavior if arangodb is started with --default-language=en_US:
    // [
    //   "A",
    //   "a",
    //   "AA",
    //   "Aa",
    //   "aA",
    //   "aa",
    //   "AB",
    //   "Ab",
    //   "aB",
    //   "ab",
    //   "B",
    //   "b"
    // ]
    // value >= "A" && value <= "a" therefore is identical to LOWER(value) == LOWER("a")
    // value >= "A" && value < "a\u10ffff" is identical to STARTS_WITH(LOWER(value), LOWER("a"))

    // IMPORTANT: these assumptions are not true for the en_US_POSIX languages (neither with --icu-language, nor
    // with --default-language). en_US_POSIX is very close to the code points, so it places all uppercase characters
    // together, followed by all lowercase characters ("A", "B", ..., "Z", ..., "a", "b", ...)
    // so we currently do not suppor the en_US_POSIX language.

    // Other collators have lowercase first, then uppercase, w.f. --icu-language=en_US.
    // To support both variants, we compute the MIN and MAX of UPPER and LOWER
    // arangodb will evaluate those MIN/MAX epxressions statically so it can still use them as index ranges
    // (remove-unnecessary-calculations-2)
    // rhs is always a string literal (and usually rather short, since it's just a filter condition),
    // so it's not really a problem to repeat it

    // this works as long as the highest possible code point is also the last one in the collation
    const maxChar = String.fromCodePoint(0x10ffff);
    const maxStr = rhsValue + maxChar;

    // if the prefix e.g. only consists of digits, it's even easier because we don't need to case-convert it
    if (isStringCaseInsensitive(rhsValue)) {
        return aql`(${lhs} >= ${rhsValue} && ${lhs} < ${maxStr})`;
    }

    const lowerBoundFrag = aql`MIN([UPPER(${rhsValue}), LOWER(${rhsValue})])`;
    const upperBoundFrag = aql`MAX([LOWER(${maxStr}), UPPER(${maxStr})])`;
    return aql`(${lhs} >= ${lowerBoundFrag} && ${lhs} < ${upperBoundFrag})`;
}

function getEqualsIgnoreCaseQuery(lhs: AQLFragment, rhsValue: string): AQLFragment {
    // if the string e.g. only consists of digits, no need for special case sensitivity checking
    if (isStringCaseInsensitive(rhsValue)) {
        return aql`(${lhs} == ${aql.value(rhsValue)})`;
    }

    // w.r.t. UPPER/LOWER, see the comment in getFastStartsWithQuery
    const lowerBoundFrag = aql`MIN([UPPER(${rhsValue}), LOWER(${rhsValue})])`;
    const upperBoundFrag = aql`MAX([LOWER(${rhsValue}), UPPER(${rhsValue})])`;
    return aql`(${lhs} >= ${lowerBoundFrag} && ${lhs} <= ${upperBoundFrag})`;
}

register(UnaryOperationQueryNode, (node, context) => {
    switch (node.operator) {
        case UnaryOperator.NOT:
            return aql`!(${processNode(node.valueNode, context)})`;
        case UnaryOperator.JSON_STRINGIFY:
            return aql`JSON_STRINGIFY(${processNode(node.valueNode, context)})`;
        case UnaryOperator.ROUND:
            return aql`ROUND(${processNode(node.valueNode, context)})`;
        default:
            throw new Error(`Unsupported unary operator: ${node.operator}`);
    }
});

register(ConditionalQueryNode, (node, context) => {
    const cond = processNode(node.condition, context);
    const expr1 = processNode(node.expr1, context);
    const expr2 = processNode(node.expr2, context);
    return aql`(${cond} ? ${expr1} : ${expr2})`;
});

register(TypeCheckQueryNode, (node, context) => {
    const value = processNode(node.valueNode, context);

    switch (node.type) {
        case BasicType.SCALAR:
            return aql`(IS_BOOL(${value}) || IS_NUMBER(${value}) || IS_STRING(${value}))`;
        case BasicType.LIST:
            return aql`IS_LIST(${value})`;
        case BasicType.OBJECT:
            return aql`IS_OBJECT(${value})`;
        case BasicType.NULL:
            return aql`IS_NULL(${value})`;
    }
});

register(SafeListQueryNode, (node, context) => {
    const reducedNode = new ConditionalQueryNode(
        new TypeCheckQueryNode(node.sourceNode, BasicType.LIST),
        node.sourceNode,
        ListQueryNode.EMPTY,
    );
    return processNode(reducedNode, context);
});

register(QuantifierFilterNode, (node, context) => {
    let { quantifier, conditionNode, listNode, itemVariable } = node;
    conditionNode = simplifyBooleans(conditionNode);

    const fastFragment = getQuantifierFilterUsingArrayComparisonOperator(
        { quantifier, conditionNode, listNode, itemVariable },
        context,
    );
    if (fastFragment) {
        return fastFragment;
    }

    // reduce 'every' to 'none' so that count-based evaluation is possible
    if (quantifier === 'every') {
        quantifier = 'none';
        conditionNode = not(conditionNode);
    }

    const filteredListNode = new TransformListQueryNode({
        listNode,
        filterNode: conditionNode,
        itemVariable,
    });

    const finalNode = new BinaryOperationQueryNode(
        new CountQueryNode(filteredListNode),
        quantifier === 'none' ? BinaryOperator.EQUAL : BinaryOperator.GREATER_THAN,
        new LiteralQueryNode(0),
    );
    return processNode(finalNode, context);
});

// uses the array expansion operator (https://docs.arangodb.com/3.0/AQL/Advanced/ArrayOperators.html#array-expansion)
// that can utilize an index like "items[*].itemNumber" if possible
// (specifically for something like items_some: {itemNumber: "abc"})
function getQuantifierFilterUsingArrayComparisonOperator(
    {
        quantifier,
        conditionNode,
        listNode,
        itemVariable,
    }: {
        quantifier: Quantifier;
        conditionNode: QueryNode;
        listNode: QueryNode;
        itemVariable: VariableQueryNode;
    },
    context: QueryContext,
): AQLFragment | undefined {
    // ArangoDB supports array comparison operators (e.g. field ALL > 5)
    // https://www.arangodb.com/docs/stable/aql/operators.html#array-comparison-operators
    // it can be combined with the array expansion operator (e.g. items[*].field)
    // https://docs.arangodb.com/3.0/AQL/Advanced/ArrayOperators.html#array-expansion
    // quantifier filters with exactly one filter field that uses a comparison operator can be optimized with this
    // this simplifies the AQL expression a lot (no filtering-then-checking-length), and also enables early pruning

    // only possible on lists that are field accesses (but we can handle safe lists below)
    // note that needsSafeListWrapper will be set to false in some places below when we know that non-list
    // values are no problem for the specific case
    let needsSafeListWrapper = false;
    if (listNode instanceof SafeListQueryNode) {
        needsSafeListWrapper = true;
        listNode = listNode.sourceNode;
    }
    if (!(listNode instanceof FieldQueryNode)) {
        return undefined;
    }

    if (!(conditionNode instanceof BinaryOperationQueryNode)) {
        return undefined;
    }

    let operator: BinaryOperator;
    switch (conditionNode.operator) {
        case BinaryOperator.EQUAL:
        case BinaryOperator.IN:
        case BinaryOperator.UNEQUAL:
        case BinaryOperator.LESS_THAN:
        case BinaryOperator.LESS_THAN_OR_EQUAL:
        case BinaryOperator.GREATER_THAN:
        case BinaryOperator.GREATER_THAN_OR_EQUAL:
            operator = conditionNode.operator;
            break;

        case BinaryOperator.LIKE:
            // see if this really is a equals search so we can optimize it (only possible as long as it does not contain any case-specific characters)
            if (
                !(conditionNode.rhs instanceof LiteralQueryNode) ||
                typeof conditionNode.rhs.value !== 'string'
            ) {
                return undefined;
            }
            const likePattern: string = conditionNode.rhs.value;
            const { isLiteralPattern } = analyzeLikePatternPrefix(likePattern);
            if (!isLiteralPattern || !isStringCaseInsensitive(likePattern)) {
                return undefined;
            }
            operator = BinaryOperator.EQUAL;
            break;

        default:
            return undefined;
    }

    let fields: Field[] = [];
    let currentFieldNode = conditionNode.lhs;
    while (currentFieldNode !== itemVariable) {
        if (!(currentFieldNode instanceof FieldQueryNode)) {
            return undefined;
        }
        fields.unshift(currentFieldNode.field); // we're traversing from back to front
        currentFieldNode = currentFieldNode.objectNode;
    }

    const valueFrag = processNode(conditionNode.rhs, context);

    // we do not know whether we will need a SafeListQueryNode here yet
    // (depends on needsSafeListWrapper, which can change below), so parametrize this
    let fieldValueFragFn: (useSafeListWrapper: boolean) => AQLFragment;
    if (fields.length) {
        const fieldAccessFrag = aql.concat(fields.map((f) => getPropertyAccessFragment(f.name)));
        fieldValueFragFn = () => aql`${processNode(listNode, context)}[*]${fieldAccessFrag}`;
        // the [*] operator does not complain about the left side being a non-array, and it will always yield
        // an array - so we do not need to care about safe lists anymore
        needsSafeListWrapper = false;
    } else {
        // special case: scalar list - no array expansion
        // we do not know yet whether or not we care about the safe list wrapper
        fieldValueFragFn = (useSafeListWrapper) =>
            processNode(useSafeListWrapper ? new SafeListQueryNode(listNode) : listNode, context);
    }

    // The case of "field ANY == value" can further be optimized into "value IN field" which can use an array index
    // https://www.arangodb.com/docs/stable/indexing-index-basics.html#indexing-array-values
    if (operator === BinaryOperator.EQUAL && quantifier === 'some') {
        // the IN operator does not complain if the rhs operand is not a list, it just yields false
        // so we do not need to care about the safe list wrapper
        needsSafeListWrapper = false;
        return aql`(${valueFrag} IN ${fieldValueFragFn(needsSafeListWrapper)})`;
    }

    let quantifierFrag: AQLFragment;
    switch (quantifier) {
        case 'some':
            quantifierFrag = aql`ANY`;
            // (non-list-value) ANY (some-expression) always yields false
            // In the safe-list case, non-list values (especially NULL) are considered like empty lists
            // -> we do not need to take special care for non-list values, and can ignore the safe list wrapper
            needsSafeListWrapper = false;
            break;
        case 'every':
            quantifierFrag = aql`ALL`;
            // (non-list-value) ALL (some-expression) always yields false,
            // but [] ALL (some-expression) yields true
            // In the safe-list case, non-list values (especially NULL) are considered like empty lists
            // -> we need to convert non-list values to []
            // -> we need to keep the safe list wrapper
            break;
        case 'none':
            quantifierFrag = aql`NONE`;
            // same reasoning as above - we need to keep the safe list wrapper
            break;
        default:
            throw new Error(`Unexpected quantifier: ${quantifier}`);
    }

    const operatorFrag = getAQLOperator(operator);
    if (!operatorFrag) {
        throw new Error(`Unable to get AQL fragment for operator ${operator}`);
    }
    const fieldValueFrag = fieldValueFragFn(needsSafeListWrapper);
    return aql`(${fieldValueFrag} ${quantifierFrag} ${operatorFrag} ${valueFrag})`;
}

register(EntitiesQueryNode, (node, context) => {
    return getCollectionForType(node.rootEntityType, AccessType.EXPLICIT_READ, context);
});

register(FollowEdgeQueryNode, (node, context) => {
    const tmpVar = aql.variable('node');
    // need to wrap this in a subquery because ANY is not possible as first token of an expression node in AQL
    return aqlExt.parenthesizeList(
        aql`FOR ${tmpVar}`,
        aql`IN ${getSimpleFollowEdgeFragment(node, context)}`,
        aql`FILTER ${tmpVar} != null`,
        aql`RETURN ${tmpVar}`,
    );
});

register(TraversalQueryNode, (node, context) => {
    const sourceFrag = processNode(node.sourceEntityNode, context);
    const fieldDepth = node.fieldSegments.filter((s) => s.isListSegment).length;

    if (node.relationSegments.length) {
        let mapFrag: ((itemFrag: AQLFragment) => AQLFragment) | undefined;

        let remainingDepth = fieldDepth;
        if (node.fieldSegments.length) {
            // if we have both, it might be beneficial to do the field traversal within the mapping node
            // because it may allow ArangoDB to figure out that only one particular field is of interest, and e.g.
            // discard the root entities earlier

            if (node.captureRootEntity) {
                if (fieldDepth === 0) {
                    // fieldSegments.length && fieldDepth === 0 means we only traverse through entity extensions
                    // actually, shouldn't really occur because a collect path can't end with an entity extension and
                    // value objects don't capture root entities
                    // however, we can easily implement this so let's do it
                    mapFrag = (nodeFrag) =>
                        aql`{ obj: ${getFieldTraversalFragmentWithoutFlattening(
                            node.fieldSegments,
                            nodeFrag,
                        )}, root: ${nodeFrag}) }`;
                } else {
                    // the result of getFieldTraversalFragmentWithoutFlattening() now is a list, so we need to iterate
                    // over it. if the depth is > 1, we need to flatten the deeper ones so we can do one FOR loop over them
                    // we still return a list, so we just reduce the depth to 1 and not to 0
                    const entityVar = aql.variable('entity');
                    mapFrag = (rootEntityFrag) =>
                        aqlExt.parenthesizeList(
                            aql`FOR ${entityVar} IN ${getFlattenFrag(
                                getFieldTraversalFragmentWithoutFlattening(
                                    node.fieldSegments,
                                    rootEntityFrag,
                                ),
                                fieldDepth - 1,
                            )}`,
                            aql`RETURN { obj: ${entityVar}, root: ${rootEntityFrag} }`,
                        );
                    remainingDepth = 1;
                }
            } else {
                mapFrag = (nodeFrag) =>
                    getFieldTraversalFragmentWithoutFlattening(node.fieldSegments, nodeFrag);
            }
        } else {
            if (node.captureRootEntity) {
                // doesn't make sense to capture the root entity if we're returning the root entities
                throw new Error(`captureRootEntity without fieldSegments detected`);
            }
        }

        // traversal requires real ids
        let fixedSourceFrag = sourceFrag;
        if (node.entitiesIdentifierKind === EntitiesIdentifierKind.ID) {
            if (node.sourceIsList) {
                fixedSourceFrag = getFullIDFromKeysFragment(
                    sourceFrag,
                    node.relationSegments[0].relationSide.sourceType,
                );
            } else {
                fixedSourceFrag = getFullIDFromKeyFragment(
                    sourceFrag,
                    node.relationSegments[0].relationSide.sourceType,
                );
            }
        }

        const frag = getRelationTraversalFragment({
            segments: node.relationSegments,
            sourceFrag: fixedSourceFrag,
            sourceIsList: node.sourceIsList,
            alwaysProduceList: node.alwaysProduceList,
            mapFrag,
            context,
        });
        if (node.relationSegments.some((s) => s.isListSegment) || node.sourceIsList) {
            // if the relation contains a list segment, getRelationTraversalFragment will return a list
            // if we already returned lists within the mapFrag (-> current value of remainingDepth), we need to add that
            remainingDepth++;
        }
        // flatten 1 less than the depth, see below
        return getFlattenFrag(frag, remainingDepth - 1);
    }

    if (node.captureRootEntity) {
        // doesn't make sense (and isn't possible) to capture the root entity if we're not even crossing root entities
        throw new Error(`captureRootEntity without relationSegments detected`);
    }

    if (node.sourceIsList) {
        // don't need, don't bother
        throw new Error(`sourceIsList without relationSegments detected`);
    }

    if (node.alwaysProduceList) {
        // don't need, don't bother
        throw new Error(`alwaysProduceList without relationSegments detected`);
    }

    if (node.entitiesIdentifierKind !== EntitiesIdentifierKind.ENTITY) {
        throw new Error(`Only ENTITY identifiers supported without relationSegments`);
    }

    if (!node.fieldSegments.length) {
        // should normally not occur
        return sourceFrag;
    }

    // flatten 1 less than the fieldDepth:
    // - no list segments -> evaluate to the object
    // - one list segment -> evaluate to the list, so no flattening
    // - two list segments -> needs flattening once to get one list
    return getFlattenFrag(
        getFieldTraversalFragmentWithoutFlattening(node.fieldSegments, sourceFrag),
        fieldDepth - 1,
    );
});

function getRelationTraversalFragment({
    segments,
    sourceFrag,
    sourceIsList,
    alwaysProduceList,
    mapFrag,
    context,
}: {
    readonly segments: ReadonlyArray<RelationSegment>;
    readonly sourceFrag: AQLFragment;
    readonly sourceIsList: boolean;
    readonly alwaysProduceList: boolean;
    readonly mapFrag?: (itemFrag: AQLFragment) => AQLFragment;
    readonly context: QueryContext;
}) {
    if (!segments.length) {
        return sourceFrag;
    }

    // ArangoDB 3.4.5 introduced PRUNE which also supports IS_SAME_COLLECTION so we may be able to use just one
    // traversal which lists all affected edge collections and prunes on the path in the future.

    const forFragments: AQLFragment[] = [];
    const sourceEntityVar = aql.variable(`sourceEntity`);
    let currentObjectFrag = sourceIsList ? sourceEntityVar : sourceFrag;
    let segmentIndex = 0;
    for (const segment of segments) {
        const nodeVar = aql.variable(`node`);
        const edgeVar = aql.variable(`edge`);
        const pathVar = aql.variable(`path`);
        const dir = segment.relationSide.isFromSide ? aql`OUTBOUND` : aql`INBOUND`;
        let filterFrag = aql``;
        let pruneFrag = aql``;
        if (segment.vertexFilter) {
            if (!segment.vertexFilterVariable) {
                throw new Error(`vertexFilter is set, but vertexFilterVariable is not`);
            }
            const filterContext = context.introduceVariableAlias(
                segment.vertexFilterVariable,
                nodeVar,
            );
            // PRUNE to stop on a node that has to be filtered out (only necessary for traversals > 1 path length)
            // however, PRUNE only seems to be a performance feature and is not reliably evaluated
            // (e.g. it's not when using COLLECT with distinct for some reason), so we need to add a path filter
            if (segment.maxDepth > 1) {
                if (
                    !(
                        segment.vertexFilter instanceof BinaryOperationQueryNode &&
                        segment.vertexFilter.lhs instanceof FieldQueryNode &&
                        segment.vertexFilter.lhs.objectNode === segment.vertexFilterVariable
                    )
                ) {
                    throw new Error(`Unsupported filter pattern for graph traversal`);
                }
                const vertexInPathFrag = aql`${pathVar}.vertices[*]`;
                const pathFilterContext = context.introduceVariableAlias(
                    segment.vertexFilterVariable,
                    vertexInPathFrag,
                );
                const lhsFrag = processNode(segment.vertexFilter.lhs, pathFilterContext);
                const opFrag = getAQLOperator(segment.vertexFilter.operator);
                if (!opFrag) {
                    throw new Error(`Unsupported filter pattern for graph traversal`);
                }
                const pathFilterFrag = aql`${lhsFrag} ALL ${opFrag} ${processNode(
                    segment.vertexFilter.rhs,
                    pathFilterContext,
                )}`;
                filterFrag = aql`\nFILTER ${pathFilterFrag}`;
                pruneFrag = aql`\nPRUNE !(${processNode(segment.vertexFilter, filterContext)})`;
            } else {
                // FILTER to filter out result nodes
                filterFrag = aql`\nFILTER ${processNode(segment.vertexFilter, filterContext)}`;
            }
        }
        const traversalFrag = aql`FOR ${nodeVar}, ${edgeVar}, ${pathVar} IN ${segment.minDepth}..${
            segment.maxDepth
        } ${dir} ${currentObjectFrag} ${getCollectionForRelation(
            segment.relationSide.relation,
            AccessType.EXPLICIT_READ,
            context,
        )}${pruneFrag}${filterFrag}`;
        if (segment.isListSegment || (alwaysProduceList && segmentIndex === segments.length - 1)) {
            // this is simple - we can just push one FOR statement after the other
            forFragments.push(traversalFrag);
            currentObjectFrag = nodeVar;
        } else {
            // if this is not a list, we need to preserve NULL values
            // (actually, we don't in some cases, but we need to figure out when)
            // to preserve null values, we need to use FIRST
            // to ignore dangling edges, add a FILTER though (if there was one dangling edge and one real edge collected, we should use the real one)
            const nullableVar = aql.variable(`nullableNode`);
            forFragments.push(
                aql`LET ${nullableVar} = FIRST(${traversalFrag} FILTER ${nodeVar} != null RETURN ${nodeVar})`,
            );
            currentObjectFrag = nullableVar;
        }

        context.addCollectionAccess(
            getCollectionNameForRootEntity(segment.relationSide.targetType),
            AccessType.IMPLICIT_READ,
        );

        segmentIndex++;
    }

    const lastSegment = segments[segments.length - 1];

    // remove dangling edges, unless we already did because the last segment wasn't a list segment (see above, we add the FILTER there)
    if (lastSegment.isListSegment) {
        forFragments.push(aql`FILTER ${currentObjectFrag} != null`);
    }

    const returnFrag = mapFrag ? mapFrag(currentObjectFrag) : currentObjectFrag;
    const returnList = lastSegment.resultIsList || sourceIsList || alwaysProduceList;
    // make sure we don't return a list with one element
    return aqlExt[returnList ? 'parenthesizeList' : 'parenthesizeObject'](
        sourceIsList ? aql`FOR ${sourceEntityVar} IN ${sourceFrag}` : aql``,
        ...forFragments,
        aql`RETURN ${returnFrag}`,
    );
}

function getFlattenFrag(listFrag: AQLFragment, depth: number) {
    if (depth <= 0) {
        return listFrag;
    }
    if (depth === 1) {
        return aql`${listFrag}[**]`;
    }
    return aql`FLATTEN(${listFrag}, ${aql.integer(depth)})`;
}

function getFieldTraversalFragmentWithoutFlattening(
    segments: ReadonlyArray<FieldSegment>,
    sourceFrag: AQLFragment,
) {
    if (!segments.length) {
        return sourceFrag;
    }

    let frag = sourceFrag;
    for (const segment of segments) {
        frag = aql`${frag}${getPropertyAccessFragment(segment.field.name)}`;
        if (segment.isListSegment) {
            // the array expansion operator [*] does two useful things:
            // - it performs the next field access basically as .map(o => o.fieldName).
            // - it converts non-lists to lists (important so that if we flatten afterwards, we don't include NULL lists
            // the latter is why we also add the [*] at the end of the expression, which might look strange in the AQL.
            frag = aql`${frag}[*]`;
        }
    }

    return frag;
}

register(CreateEntityQueryNode, (node, context) => {
    return aqlExt.parenthesizeObject(
        aql`INSERT ${processNode(node.objectNode, context)} IN ${getCollectionForType(
            node.rootEntityType,
            AccessType.WRITE,
            context,
        )}`,
        aql`RETURN NEW._key`,
    );
});

register(CreateEntitiesQueryNode, (node, context) => {
    const entityVar = aql.variable('entity');
    return aqlExt.parenthesizeList(
        aql`FOR ${entityVar} IN ${processNode(node.objectsNode, context)}`,
        aql`INSERT ${entityVar} IN ${getCollectionForType(
            node.rootEntityType,
            AccessType.WRITE,
            context,
        )}`,
        aql`RETURN NEW._key`,
    );
});

register(UpdateEntitiesQueryNode, (node, context) => {
    const newContext = context.introduceVariable(node.currentEntityVariable);
    const entityVar = newContext.getVariable(node.currentEntityVariable);
    let entityFrag: AQLFragment;
    let options: AQLFragment;
    let updateFrag = processNode(new ObjectQueryNode(node.updates), newContext);
    let additionalUpdates: ReadonlyArray<SetFieldQueryNode> = [];

    if (node.revision) {
        entityFrag = aql`MERGE(${entityVar}, { _rev: ${aql.value(node.revision)} })`;
        options = aql`{ mergeObjects: false, ignoreRevs: false }`;
        // to guarantee that the _rev changes, we need to set a property to a new value
        updateFrag = aql`MERGE(${updateFrag}, { _revDummy: ${entityVar}._rev })`;
    } else {
        entityFrag = entityVar;
        options = aql`{ mergeObjects: false }`;
    }

    return aqlExt.parenthesizeList(
        aql`FOR ${entityVar}`,
        aql`IN ${processNode(node.listNode, context)}`,
        aql`UPDATE ${entityFrag}`,
        aql`WITH ${updateFrag}`,
        aql`IN ${getCollectionForType(node.rootEntityType, AccessType.WRITE, context)}`,
        aql`OPTIONS ${options}`,
        aql`RETURN NEW._key`,
    );
});

register(DeleteEntitiesQueryNode, (node, context) => {
    const entityVar = aql.variable(decapitalize(node.rootEntityType.name));
    let entityFrag: AQLFragment;
    let optionsFrag: AQLFragment;

    if (node.revision) {
        if (node.entitiesIdentifierKind === EntitiesIdentifierKind.ID) {
            entityFrag = aql`{ _key: ${entityVar}, _rev: ${aql.value(node.revision)} }`;
        } else {
            entityFrag = aql`MERGE(${entityVar}, { _rev: ${aql.value(node.revision)} })`;
        }
        optionsFrag = aql`OPTIONS { ignoreRevs: false }`;
    } else {
        entityFrag = entityVar;
        optionsFrag = aql``;
    }

    const countVar = aql.variable(`count`);
    return aqlExt[
        node.resultValue === DeleteEntitiesResultValue.OLD_ENTITIES
            ? 'parenthesizeList'
            : 'parenthesizeObject'
    ](
        aql`FOR ${entityVar}`,
        aql`${generateInClause(node.listNode, context, entityVar)}`,
        aql`REMOVE ${entityFrag}`,
        aql`IN ${getCollectionForType(node.rootEntityType, AccessType.WRITE, context)}`,
        optionsFrag,
        node.resultValue === DeleteEntitiesResultValue.OLD_ENTITIES
            ? aql`RETURN OLD`
            : aql.lines(aql`COLLECT WITH COUNT INTO ${countVar}`, aql`RETURN ${countVar}`),
    );
});

register(AddEdgesQueryNode, (node, context) => {
    const edgeVar = aql.variable('edge');
    return aqlExt.parenthesizeList(
        aql`FOR ${edgeVar}`,
        aql`IN [ ${aql.join(
            node.edges.map((edge) => formatEdge(node.relation, edge, context)),
            aql`, `,
        )} ]`,
        aql`UPSERT { _from: ${edgeVar}._from, _to: ${edgeVar}._to }`, // need to unpack avoid dynamic property names in UPSERT example filter
        aql`INSERT ${edgeVar}`,
        aql`UPDATE {}`,
        aql`IN ${getCollectionForRelation(node.relation, AccessType.WRITE, context)}`,
    );
});

register(RemoveEdgesQueryNode, (node, context) => {
    const edgeVar = aql.variable('edge');
    const fromVar = aql.variable('from');
    const toVar = aql.variable('to');
    let edgeFilter: AQLFragment;
    if (node.edgeFilter.fromIDsNode && node.edgeFilter.toIDsNode) {
        edgeFilter = aql`FILTER ${edgeVar}._from == ${fromVar} && ${edgeVar}._to == ${toVar}`;
    } else if (node.edgeFilter.fromIDsNode) {
        edgeFilter = aql`FILTER ${edgeVar}._from == ${fromVar}`;
    } else if (node.edgeFilter.toIDsNode) {
        edgeFilter = aql`FILTER ${edgeVar}._to == ${toVar}`;
    } else {
        edgeFilter = aql``;
    }
    return aqlExt.parenthesizeList(
        node.edgeFilter.fromIDsNode
            ? aql`FOR ${fromVar} IN ${getFullIDsFromKeysNode(
                  node.edgeFilter.fromIDsNode!,
                  node.relation.fromType,
                  context,
              )}`
            : aql``,
        node.edgeFilter.toIDsNode
            ? aql`FOR ${toVar} IN ${getFullIDsFromKeysNode(
                  node.edgeFilter.toIDsNode!,
                  node.relation.toType,
                  context,
              )}`
            : aql``,
        aql`FOR ${edgeVar} IN ${getCollectionForRelation(
            node.relation,
            AccessType.EXPLICIT_READ,
            context,
        )}`,
        edgeFilter,
        aql`REMOVE ${edgeVar} IN ${getCollectionForRelation(
            node.relation,
            AccessType.WRITE,
            context,
        )}`,
    );
});

register(SetEdgeQueryNode, (node, context) => {
    const edgeVar = aql.variable('edge');
    return aqlExt.parenthesizeList(
        aql`UPSERT ${formatEdge(node.relation, node.existingEdge, context)}`,
        aql`INSERT ${formatEdge(node.relation, node.newEdge, context)}`,
        aql`UPDATE ${formatEdge(node.relation, node.newEdge, context)}`,
        aql`IN ${getCollectionForRelation(node.relation, AccessType.WRITE, context)}`,
    );
});

/**
 * Gets an aql fragment that evaluates to a string of the format "collectionName/objectKey", given a query node that
 * evaluates to the "object id", which is, in arango terms, the _key.
 */
function getFullIDFromKeyNode(
    node: QueryNode,
    rootEntityType: RootEntityType,
    context: QueryContext,
): AQLFragment {
    // special handling to avoid concat if possible - do not alter the behavior
    if (node instanceof LiteralQueryNode && typeof node.value == 'string') {
        // just append the node to the literal key in JavaScript and bind it as a string
        return aql`${getCollectionNameForRootEntity(rootEntityType) + '/' + node.value}`;
    }
    if (node instanceof RootEntityIDQueryNode) {
        // access the _id field. processNode(node) would access the _key field instead.
        return aql`${processNode(node.objectNode, context)}._id`;
    }

    // fall back to general case
    return getFullIDFromKeyFragment(processNode(node, context), rootEntityType);
}

function getFullIDsFromKeysNode(
    idsNode: QueryNode,
    rootEntityType: RootEntityType,
    context: QueryContext,
): AQLFragment {
    if (idsNode instanceof ListQueryNode) {
        // this probably generates cleaner AQL without dynamic concat
        const idFragments = idsNode.itemNodes.map((idNode) =>
            getFullIDFromKeyNode(idNode, rootEntityType, context),
        );
        return aql`[${aql.join(idFragments, aql`, `)}]`;
    }
    if (
        idsNode instanceof LiteralQueryNode &&
        isReadonlyArray(idsNode.value) &&
        idsNode.value.every((v) => typeof v === 'string')
    ) {
        const collName = getCollectionNameForRootEntity(rootEntityType);
        const ids = idsNode.value.map((val) => collName + '/' + val);
        return aql.value(ids);
    }

    return getFullIDFromKeysFragment(processNode(idsNode, context), rootEntityType);
}

function getFullIDFromKeyFragment(
    keyFragment: AQLFragment,
    rootEntityType: RootEntityType,
): AQLFragment {
    return aql`CONCAT(${getCollectionNameForRootEntity(rootEntityType) + '/'}, ${keyFragment})`;
}

function getFullIDFromKeysFragment(
    keysFragment: AQLFragment,
    rootEntityType: RootEntityType,
): AQLFragment {
    const idVar = aql.variable('id');
    return aql`(FOR ${idVar} IN ${keysFragment} RETURN ${getFullIDFromKeyFragment(
        idVar,
        rootEntityType,
    )})`;
}

function formatEdge(
    relation: Relation,
    edge: PartialEdgeIdentifier | EdgeIdentifier,
    context: QueryContext,
): AQLFragment {
    const conditions = [];
    if (edge.fromIDNode) {
        conditions.push(
            aql`_from: ${getFullIDFromKeyNode(edge.fromIDNode, relation.fromType, context)}`,
        );
    }
    if (edge.toIDNode) {
        conditions.push(aql`_to: ${getFullIDFromKeyNode(edge.toIDNode, relation.toType, context)}`);
    }

    return aql`{${aql.join(conditions, aql`, `)}}`;
}

function getAQLOperator(op: BinaryOperator): AQLFragment | undefined {
    switch (op) {
        case BinaryOperator.AND:
            return aql`&&`;
        case BinaryOperator.OR:
            return aql`||`;
        case BinaryOperator.EQUAL:
            return aql`==`;
        case BinaryOperator.UNEQUAL:
            return aql`!=`;
        case BinaryOperator.LESS_THAN:
            return aql`<`;
        case BinaryOperator.LESS_THAN_OR_EQUAL:
            return aql`<=`;
        case BinaryOperator.GREATER_THAN:
            return aql`>`;
        case BinaryOperator.GREATER_THAN_OR_EQUAL:
            return aql`>=`;
        case BinaryOperator.IN:
            return aql`IN`;
        case BinaryOperator.ADD:
            return aql`+`;
        case BinaryOperator.SUBTRACT:
            return aql`-`;
        case BinaryOperator.MULTIPLY:
            return aql`*`;
        case BinaryOperator.DIVIDE:
            return aql`/`;
        case BinaryOperator.MODULO:
            return aql`%`;
        default:
            return undefined;
    }
}

function generateSortAQL(orderBy: OrderSpecification, context: QueryContext): AQLFragment {
    if (orderBy.isUnordered()) {
        return aql``;
    }

    function dirAQL(dir: OrderDirection) {
        if (dir == OrderDirection.DESCENDING) {
            return aql` DESC`;
        }
        return aql``;
    }

    const clauses = orderBy.clauses.map(
        (cl) => aql`(${processNode(cl.valueNode, context)}) ${dirAQL(cl.direction)}`,
    );

    return aql`SORT ${aql.join(clauses, aql`, `)}`;
}

function processNode(node: QueryNode, context: QueryContext): AQLFragment {
    const processor = processors.get(node.constructor as Constructor<QueryNode>);
    if (!processor) {
        throw new Error(`Unsupported query type: ${node.constructor.name}`);
    }
    return processor(node, context);
}

// TODO I think AQLCompoundQuery (AQL transaction node) should not be the exported type
// we should rather export AQLExecutableQuery[] (as AQL transaction) directly.
export function getAQLQuery(
    node: QueryNode,
    options: Partial<QueryGenerationOptions> = {},
): AQLCompoundQuery {
    return createAQLCompoundQuery(
        node,
        aql.queryResultVariable('result'),
        undefined,
        new QueryContext({
            clock: options.clock ?? new DefaultClock(),
            idGenerator: options.idGenerator ?? new UUIDGenerator(),
        }),
    );
}

function getCollectionForBilling(accessType: AccessType, context: QueryContext) {
    const name = billingCollectionName;
    context.addCollectionAccess(name, accessType);
    return aql.collection(name);
}

function getCollectionForType(type: RootEntityType, accessType: AccessType, context: QueryContext) {
    const name = getCollectionNameForRootEntity(type);
    context.addCollectionAccess(name, accessType);
    return aql.collection(name);
}

function getCollectionForRelation(
    relation: Relation,
    accessType: AccessType,
    context: QueryContext,
) {
    const name = getCollectionNameForRelation(relation);
    context.addCollectionAccess(name, accessType);
    return aql.collection(name);
}

/**
 * Processes a FollowEdgeQueryNode into a fragment to be used within `IN ...` (as opposed to be used in a general
 * expression context)
 */
function getSimpleFollowEdgeFragment(
    node: FollowEdgeQueryNode,
    context: QueryContext,
): AQLFragment {
    const dir = node.relationSide.isFromSide ? aql`OUTBOUND` : aql`INBOUND`;
    context.addCollectionAccess(
        getCollectionNameForRootEntity(node.relationSide.targetType),
        AccessType.IMPLICIT_READ,
    );
    return aql`${dir} ${processNode(node.sourceEntityNode, context)} ${getCollectionForRelation(
        node.relationSide.relation,
        AccessType.EXPLICIT_READ,
        context,
    )}`;
}

function isStringCaseInsensitive(str: string) {
    return str.toLowerCase() === str.toUpperCase();
}

export function generateTokenizationQuery(
    tokensFiltered: ReadonlyArray<FlexSearchTokenizable>,
): AQLFragment {
    const fragments: AQLFragment[] = [];
    for (let i = 0; i < tokensFiltered.length; i++) {
        const value = tokensFiltered[i];
        fragments.push(
            aql`${aql.identifier('token_' + i)}: TOKENS(${value.expression}, ${value.analyzer})`,
        );
    }
    return aql.lines(aql`RETURN {`, aql.indent(aql.join(fragments, aql`,\n`)), aql`}`);
}
