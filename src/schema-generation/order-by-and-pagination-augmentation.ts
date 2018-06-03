import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { Type } from '../model';
import { ObjectType } from '../model/implementation';
import {
    BinaryOperationQueryNode, BinaryOperator, ConstBoolQueryNode, LiteralQueryNode, OrderDirection, OrderSpecification,
    QueryNode, TransformListQueryNode, VariableQueryNode
} from '../query-tree';
import { AFTER_ARG, FIRST_ARG, ORDER_BY_ARG } from '../schema/schema-defaults';
import { decapitalize } from '../utils/utils';
import { OrderByEnumGenerator, OrderByEnumType, OrderByEnumValue } from './order-by-enum-generator';
import { QueryNodeField } from './query-node-object-type';
import { buildSafeListQueryNode } from './query-node-utils';

/**
 * Augments list fields with orderBy argument
 */
export class OrderByAndPaginationAugmentation {
    constructor(
        private readonly orderByEnumGenerator: OrderByEnumGenerator
    ) {
    }

    augment(schemaField: QueryNodeField, type: Type): QueryNodeField {
        if (!type.isObjectType) {
            return schemaField;
        }

        const orderByType = this.orderByEnumGenerator.generate(type);

        return {
            ...schemaField,
            args: {
                ...schemaField.args,
                [ORDER_BY_ARG]: {
                    type: new GraphQLList(new GraphQLNonNull(orderByType.getEnumType()))
                },
                [FIRST_ARG]: {
                    type: GraphQLInt
                },
                [AFTER_ARG]: {
                    type: GraphQLString
                }
            },
            resolve: (sourceNode, args) => {
                const listNode = buildSafeListQueryNode(schemaField.resolve(sourceNode, args));
                const itemVariable = new VariableQueryNode(decapitalize(type.name));

                const orderBy = this.getOrderSpecification(args, orderByType, itemVariable);
                const maxCount = args[FIRST_ARG];
                const paginationFilter = this.createPaginationFilterNode(args, type, itemVariable, orderByType);

                return new TransformListQueryNode({
                    listNode,
                    itemVariable,
                    orderBy,
                    maxCount,
                    filterNode: paginationFilter
                });
            }
        };
    };
    private getOrderByValues(args: any, orderByType: OrderByEnumType) {
        const orderByValues = (args[ORDER_BY_ARG] || []) as ReadonlyArray<string>;
        return orderByValues.map(value => orderByType.getValueOrThrow(value));
    }

    private getOrderSpecification(args: any, orderByType: OrderByEnumType, itemNode: QueryNode) {
        const mappedValues = this.getOrderByValues(args, orderByType);
        const clauses = mappedValues.map(value => value.getClause(itemNode));
        return new OrderSpecification(clauses);
    }

    private createPaginationFilterNode(args: any, objectType: ObjectType, itemNode: QueryNode, orderByType: OrderByEnumType) {
        const afterArg = args[AFTER_ARG];
        if (!afterArg) {
            return ConstBoolQueryNode.TRUE;
        }

        let cursorObj: any;
        try {
            cursorObj = JSON.parse(afterArg);
            if (typeof cursorObj != 'object' || cursorObj === null) {
                throw new Error('The JSON value provided as "after" argument is not an object');
            }
        } catch (e) {
            throw new Error(`Invalid cursor ${JSON.stringify(afterArg)} supplied to "after": ${e.message}`);
        }

        // Make sure we only select items after the cursor
        // Thus, we need to implement the 'comparator' based on the order-by-specification
        // Haskell-like pseudo-code because it's easier ;-)
        // filterForClause :: Clause[] -> FilterNode:
        // filterForClause([{field, ASC}, ...tail]) =
        //   (context[clause.field] > cursor[clause.field] || (context[clause.field] == cursor[clause.field] && filterForClause(tail))
        // filterForClause([{field, DESC}, ...tail]) =
        //   (context[clause.field] < cursor[clause.field] || (context[clause.field] == cursor[clause.field] && filterForClause(tail))
        // filterForClause([]) = FALSE # arbitrary; if order is absolute, this case should never occur
        function filterForClause(clauses: ReadonlyArray<OrderByEnumValue>): QueryNode {
            if (clauses.length == 0) {
                return new ConstBoolQueryNode(false);
            }

            const clause = clauses[0];
            const cursorValue = cursorObj[clause.underscoreSeparatedPath];
            const valueNode = clause.getValueNode(itemNode);

            const operator = clause.direction == OrderDirection.ASCENDING ? BinaryOperator.GREATER_THAN : BinaryOperator.LESS_THAN;
            return new BinaryOperationQueryNode(
                new BinaryOperationQueryNode(valueNode, operator, new LiteralQueryNode(cursorValue)),
                BinaryOperator.OR,
                new BinaryOperationQueryNode(
                    new BinaryOperationQueryNode(valueNode, BinaryOperator.EQUAL, new LiteralQueryNode(cursorValue)),
                    BinaryOperator.AND,
                    filterForClause(clauses.slice(1))
                )
            );
        }

        return filterForClause(this.getOrderByValues(args, orderByType));
    }


}
