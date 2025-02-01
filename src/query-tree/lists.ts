import { AggregationOperator } from '../model/config';
export { OrderDirection } from '../model/implementation/order';
import { OrderDirection } from '../model/implementation/order';
import { indent } from '../utils/utils';
import { QueryNode } from './base';
import { ConstBoolQueryNode } from './literals';
import { VariableQueryNode } from './variables';

/**
 * A node that evaluates to a list with query nodes as list entries
 */
export class ListQueryNode extends QueryNode {
    constructor(public readonly itemNodes: ReadonlyArray<QueryNode>) {
        super();
    }

    static readonly EMPTY = new ListQueryNode([]);

    describe(): string {
        if (!this.itemNodes.length) {
            return `[]`;
        }
        return `[\n` + indent(this.itemNodes.map((item) => item.describe()).join(',\n')) + `\n]`;
    }
}

/**
 * A node to filter, order, limit and map a list
 *
 * itemVariable can be used inside filterNode and innerNode to access the current item
 */
export class TransformListQueryNode extends QueryNode {
    constructor(params: {
        listNode: QueryNode;
        innerNode?: QueryNode;
        filterNode?: QueryNode;
        orderBy?: OrderSpecification;
        skip?: number;
        maxCount?: number;
        itemVariable?: VariableQueryNode;
    }) {
        super();
        this.itemVariable = params.itemVariable || new VariableQueryNode();
        this.listNode = params.listNode;
        this.innerNode = params.innerNode || this.itemVariable;
        this.filterNode = params.filterNode || ConstBoolQueryNode.TRUE;
        this.orderBy = params.orderBy || new OrderSpecification([]);
        this.skip = params.skip || 0;
        this.maxCount = params.maxCount;
    }

    public readonly listNode: QueryNode;
    public readonly innerNode: QueryNode;
    public readonly filterNode: QueryNode;
    public readonly orderBy: OrderSpecification;
    public readonly skip: number;
    public readonly maxCount: number | undefined;
    public readonly itemVariable: VariableQueryNode;

    describe() {
        return (
            `${this.listNode.describe()} as list with ${this.itemVariable.describe()} => \n` +
            indent(
                '' + // '' to move the arg label here in WebStorm
                    (this.filterNode.equals(ConstBoolQueryNode.TRUE)
                        ? ''
                        : `where ${this.filterNode.describe()}\n`) +
                    (this.orderBy.isUnordered() ? '' : `order by ${this.orderBy.describe()}\n`) +
                    (this.skip != 0 ? `skip ${this.skip}\n` : '') +
                    (this.maxCount != undefined ? `limit ${this.maxCount}\n` : '') +
                    `as ${this.innerNode.describe()}`,
            )
        );
    }
}

export class OrderClause extends QueryNode {
    constructor(
        public readonly valueNode: QueryNode,
        public readonly direction: OrderDirection,
    ) {
        super();
    }

    private describeDirection(direction: OrderDirection) {
        if (direction == OrderDirection.DESCENDING) {
            return ` desc`;
        }
        return ``;
    }

    describe() {
        return `${this.valueNode.describe()}${this.describeDirection(this.direction)}`;
    }
}

export class OrderSpecification extends QueryNode {
    constructor(public readonly clauses: ReadonlyArray<OrderClause>) {
        super();
    }

    static readonly UNORDERED = new OrderSpecification([]);

    isUnordered() {
        return this.clauses.length == 0;
    }

    describe() {
        if (!this.clauses.length) {
            return '(unordered)';
        }
        return this.clauses.map((c) => c.describe()).join(', ');
    }
}

/**
 * A node that concatenates multiple lists and evaluates to the new list
 *
 * This can be used to append items to an array by using a ListQueryNode as second item
 */
export class ConcatListsQueryNode extends QueryNode {
    constructor(public readonly listNodes: ReadonlyArray<QueryNode>) {
        super();
    }

    describe() {
        if (!this.listNodes.length) {
            return `[]`;
        }
        return (
            `[\n` + this.listNodes.map((node) => indent('...' + node.describe())).join(',\n') + `]`
        );
    }
}

/**
 * A node that evaluates to the number of items in a list
 *
 * If the listNode evaluates to null, this node evaluates to zero
 */
export class CountQueryNode extends QueryNode {
    constructor(public readonly listNode: QueryNode) {
        super();
    }

    describe() {
        return `count(${this.listNode.describe()})`;
    }
}

/**
 * A node that evaluates to the first item of a list, or NULL if the list is empty
 */
export class FirstOfListQueryNode extends QueryNode {
    constructor(public readonly listNode: QueryNode) {
        super();
    }

    describe() {
        return `first of ${this.listNode.describe()}`;
    }
}


export class IntersectionQueryNode extends QueryNode {
    constructor(public readonly listNodes: ReadonlyArray<QueryNode>) {
        super();
    }

    describe() {
        if (!this.listNodes.length) {
            return `[]`;
        }
        return `intersection(${this.listNodes.map(listNode => listNode.describe()).join(',')})`;
    }
}

/**
 * A node that evaluates to a specific item of a list, or NULL if the list is empty
 */
export class ListItemQueryNode extends QueryNode {
    constructor(
        public readonly listNode: QueryNode,
        readonly index: number,
    ) {
        super();
    }

    describe() {
        return `${this.listNode.describe()}[${this.index}]`;
    }
}

interface AggregationQueryNodeParams {
    sort?: boolean;
}

export class AggregationQueryNode extends QueryNode {
    readonly sort: boolean;

    constructor(
        readonly listNode: QueryNode,
        readonly operator: AggregationOperator,
        options: AggregationQueryNodeParams = {},
    ) {
        super();
        this.sort = options.sort || false;
    }

    describe() {
        return `${this.operator}(${this.listNode.describe()})`;
    }
}
