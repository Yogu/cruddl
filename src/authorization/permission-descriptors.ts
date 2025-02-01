import { flatMap } from 'lodash';
import { Field, Permission, PermissionProfile, RootEntityType } from '../model';
import { FieldPath } from '../model/implementation/field-path';
import {
    BinaryOperationQueryNode,
    BinaryOperator,
    ConstBoolQueryNode,
    CountQueryNode,
    FieldQueryNode,
    IntersectionQueryNode,
    ListQueryNode,
    LiteralQueryNode,
    QueryNode,
    UnknownValueQueryNode,
} from '../query-tree';
import { simplifyBooleans } from '../query-tree/utils';
import { createFieldPathNode } from '../schema-generation/field-path-node';
import { ACCESS_GROUP_FIELD } from '../schema/constants';
import { AccessOperation, AuthContext } from './auth-basics';
import { isReadonlyArray } from '../utils/utils';

export enum ConditionExplanationContext {
    BEFORE_WRITE,
    SET,
}

/**
 * Determines whether a user can access information, possibly dependent on the instance containing the information
 */
export abstract class PermissionDescriptor {
    /**
     * Gets the condition which determines if a user has access
     * @param authContext
     * @param operation
     * @param instanceNode a QueryNode which evaluates to the instance
     * @returns a QueryNode that evaluates to TRUE if the user has access or FALSE if they don't
     */
    abstract getAccessCondition(
        authContext: AuthContext,
        operation: AccessOperation,
        instanceNode: QueryNode,
    ): QueryNode;

    /**
     * Determines if a user has access or if it depends on the instance
     */
    canAccess(authContext: AuthContext, operation: AccessOperation): PermissionResult {
        const condition = simplifyBooleans(
            this.getAccessCondition(authContext, operation, new UnknownValueQueryNode()),
        );
        if (condition instanceof ConstBoolQueryNode) {
            return condition.value ? PermissionResult.GRANTED : PermissionResult.DENIED;
        }
        return PermissionResult.CONDITIONAL;
    }

    /**
     * Gets a human-readable explanation fragment that explains why some instance could not be accessed
     */
    getExplanationForCondition(
        authContext: AuthContext,
        operation: AccessOperation,
        context: ConditionExplanationContext,
    ): string | undefined {
        return undefined;
    }
}

export enum PermissionResult {
    /**
     * Access is granted for all instances
     */
    GRANTED,

    /**
     * Access may be granted or denied, depending on the instance's accessGroup
     */
    CONDITIONAL,

    /**
     * Access is denied for all instances
     */
    DENIED,
}

export class AlwaysGrantPermissionDescriptor extends PermissionDescriptor {
    getAccessCondition(authContext: AuthContext, operation: AccessOperation): QueryNode {
        return ConstBoolQueryNode.TRUE;
    }

    canAccess(authContext: AuthContext, operation: AccessOperation): PermissionResult {
        return PermissionResult.GRANTED;
    }

    static readonly INSTANCE = new AlwaysGrantPermissionDescriptor();
}

export class AlwaysDenyPermissionDescriptor extends PermissionDescriptor {
    getAccessCondition(authContext: AuthContext, operation: AccessOperation): QueryNode {
        return ConstBoolQueryNode.FALSE;
    }

    canAccess(authContext: AuthContext, operation: AccessOperation): PermissionResult {
        return PermissionResult.DENIED;
    }

    static readonly INSTANCE = new AlwaysDenyPermissionDescriptor();
}

export class ConjunctivePermissionDescriptor extends PermissionDescriptor {
    constructor(
        public readonly lhs: PermissionDescriptor,
        public readonly rhs: PermissionDescriptor,
    ) {
        super();
    }

    getAccessCondition(authContext: AuthContext, operation: AccessOperation): QueryNode {
        const unknownAccessGroup = new UnknownValueQueryNode();
        return simplifyBooleans(
            new BinaryOperationQueryNode(
                this.lhs.getAccessCondition(authContext, operation, unknownAccessGroup),
                BinaryOperator.AND,
                this.rhs.getAccessCondition(authContext, operation, unknownAccessGroup),
            ),
        );
    }
}

export class StaticPermissionDescriptor extends PermissionDescriptor {
    private readonly allReadRoles: ReadonlyArray<string>;

    constructor(
        public readonly readRoles: ReadonlyArray<string>,
        public readonly readWriteRoles: ReadonlyArray<string>,
    ) {
        super();
        this.allReadRoles = [...readRoles, ...readWriteRoles];
    }

    getAccessCondition(authContext: AuthContext, operation: AccessOperation): QueryNode {
        let roles: ReadonlyArray<string> = [];
        switch (operation) {
            case AccessOperation.READ:
                roles = this.allReadRoles;
                break;
            // @roles can't distinguish between create/update/delete
            case AccessOperation.CREATE:
            case AccessOperation.UPDATE:
            case AccessOperation.DELETE:
                roles = this.readWriteRoles;
        }
        const allowed = roles.some((allowedRole) =>
            (authContext.authRoles ?? []).includes(allowedRole),
        );
        return new ConstBoolQueryNode(allowed);
    }
}

export class ProfileBasedPermissionDescriptor extends PermissionDescriptor {
    private readonly accessGroupField: Field | undefined;

    constructor(
        private readonly profile: PermissionProfile,
        private readonly rootEntityType?: RootEntityType,
    ) {
        super();
        this.accessGroupField = rootEntityType && rootEntityType.getField(ACCESS_GROUP_FIELD);
    }

    getAccessCondition(
        authContext: AuthContext,
        operation: AccessOperation,
        instanceNode: QueryNode,
    ): QueryNode {
        const applicablePermissions = this.getApplicablePermissions(authContext, operation);

        if (!applicablePermissions.length) {
            return ConstBoolQueryNode.FALSE;
        }

        // simplified run for permissions that only restrict by access group, can generate one IN clause
        const pureAccessGroupCondition = this.getPureAccessGroupCondition(
            applicablePermissions.filter((p) => !p.restrictions.length),
            authContext,
            instanceNode,
        );

        const complexCondition = applicablePermissions
            .filter((p) => p.restrictions.length)
            .map((p) => this.getPermissionRestrictionCondition(p, authContext, instanceNode))
            .reduce(
                (acc, node) => new BinaryOperationQueryNode(acc, BinaryOperator.OR, node),
                ConstBoolQueryNode.FALSE,
            );

        // we either need to match a permission with purely an access group, or one of the others
        const combined = new BinaryOperationQueryNode(
            pureAccessGroupCondition,
            BinaryOperator.OR,
            complexCondition,
        );
        return simplifyBooleans(combined);
    }

    getPermissionRestrictionCondition(
        permission: Permission,
        authContext: AuthContext,
        instanceNode: QueryNode,
    ): QueryNode {
        let accessGroupConditionNode: QueryNode;
        if (permission.restrictToAccessGroups) {
            const allowedAccessGroups = permission.getAllowedAccessGroups(authContext);
            accessGroupConditionNode = this.getAccessGroupConditionNode(
                allowedAccessGroups,
                instanceNode,
            );
        } else {
            accessGroupConditionNode = ConstBoolQueryNode.TRUE;
        }

        const restrictionNodes = permission.restrictions.map((restriction) => {
            if (!this.rootEntityType) {
                throw new Error(
                    `accessGroup-restricted permission profiles can only be used on root entities`,
                );
            }
            const fieldPath = new FieldPath({
                path: restriction.field,
                baseType: this.rootEntityType,
                canTraverseRootEntities: false,
                canUseCollectFields: false,
            });
            const fieldNode = createFieldPathNode(fieldPath, instanceNode);

            if (restriction.value !== undefined) {
                return new BinaryOperationQueryNode(
                    fieldNode,
                    BinaryOperator.EQUAL,
                    new LiteralQueryNode(restriction.value),
                );
            }

            if (restriction.valueTemplate !== undefined) {
                const values = permission.evaluateTemplate(restriction.valueTemplate, authContext);
                
                if (fieldPath.isList) {
                    return new BinaryOperationQueryNode(
                        new CountQueryNode(
                            new IntersectionQueryNode([
                                fieldNode,
                                new LiteralQueryNode(values),
                            ])
                        ),
                        BinaryOperator.GREATER_THAN_OR_EQUAL,
                        new LiteralQueryNode(1)
                    );
                }

                return new BinaryOperationQueryNode(
                    fieldNode,
                    BinaryOperator.IN,
                    new LiteralQueryNode(values),
                );
            }

            if (restriction.claim !== undefined) {
                const claimValue = authContext.claims?.[restriction.claim];
                const claimValues = isReadonlyArray(claimValue) ? claimValue : [claimValue];
                const sanitizedClaimValues = claimValues.filter(
                    (v) => !!v && typeof v === 'string',
                );
                if (!sanitizedClaimValues.length) {
                    return ConstBoolQueryNode.FALSE;
                }
                if (fieldPath.isList) {
                    return new BinaryOperationQueryNode(
                        new CountQueryNode(
                            new IntersectionQueryNode([
                                fieldNode,
                                new LiteralQueryNode(sanitizedClaimValues),
                            ])
                        ),
                        BinaryOperator.GREATER_THAN_OR_EQUAL,
                        new LiteralQueryNode(1)
                    );
                }
                return new BinaryOperationQueryNode(
                    fieldNode,
                    BinaryOperator.IN,
                    new LiteralQueryNode(sanitizedClaimValues),
                );
            }

            throw new Error(`Invalid permission restriction (field: ${restriction.field})`);
        });

        return restrictionNodes.reduce(
            (acc: QueryNode, node) => new BinaryOperationQueryNode(acc, BinaryOperator.AND, node),
            accessGroupConditionNode,
        );
    }

    private getPureAccessGroupCondition(
        applicablePermissions: ReadonlyArray<Permission>,
        authContext: AuthContext,
        instanceNode: QueryNode,
    ): QueryNode {
        if (!applicablePermissions.length) {
            return ConstBoolQueryNode.FALSE;
        }

        if (applicablePermissions.some((permission) => !permission.restrictToAccessGroups)) {
            return ConstBoolQueryNode.TRUE;
        }
        if (applicablePermissions.some((p) => p.restrictions.length)) {
            throw new Error(`Did not expect permissions with restrictions`);
        }

        const allowedAccessGroups = this.getAllowedAccessGroups(applicablePermissions, authContext);
        return this.getAccessGroupConditionNode(allowedAccessGroups, instanceNode);
    }

    private getAccessGroupConditionNode(
        allowedAccessGroups: ReadonlyArray<string>,
        instanceNode: QueryNode,
    ) {
        if (!this.accessGroupField) {
            if (this.rootEntityType) {
                throw new Error(
                    `Using accessGroup-restricted permission profile on type ${this.rootEntityType.name} which does not have an accessGroup field`,
                );
            } else {
                throw new Error(
                    `accessGroup-restricted permission profiles can only be used on root entities`,
                );
            }
        }

        const accessGroupNode = new FieldQueryNode(instanceNode, this.accessGroupField);
        return new BinaryOperationQueryNode(
            accessGroupNode,
            BinaryOperator.IN,
            new LiteralQueryNode(allowedAccessGroups),
        );
    }

    private getApplicablePermissions(
        authContext: AuthContext,
        operation: AccessOperation,
    ): ReadonlyArray<Permission> {
        return this.profile.permissions.filter(
            (permission) =>
                permission.allowsOperation(operation) &&
                permission.appliesToAuthContext(authContext),
        );
    }

    private getAllowedAccessGroups(
        applicablePermissions: ReadonlyArray<Permission>,
        authContext: AuthContext,
    ) {
        return flatMap(
            applicablePermissions,
            (permission) => permission.getAllowedAccessGroups(authContext)!,
        );
    }

    getExplanationForCondition(
        authContext: AuthContext,
        operation: AccessOperation,
        context: ConditionExplanationContext,
    ): string | undefined {
        const applicablePermissions = this.getApplicablePermissions(authContext, operation);

        if (!applicablePermissions.length) {
            return this.getGeneralExplanation(context);
        }

        // if we only restrict by access group, we can provide a more detailed explanation
        if (
            applicablePermissions.every((p) => p.restrictToAccessGroups && !p.restrictions.length)
        ) {
            const allowedAccessGroups = this.getAllowedAccessGroups(
                applicablePermissions,
                authContext,
            );
            const prefix = this.getExplanationPrefixForAccessGroups(context);
            return `${prefix}${allowedAccessGroups.join(', ')})`;
        }

        // if we only restrict by a single field, that's also ok
        if (applicablePermissions.every((permission) => !permission.restrictToAccessGroups)) {
            const restrictedFields = new Set<string>();
            for (const permission of applicablePermissions) {
                for (const restriction of permission.restrictions) {
                    restrictedFields.add(restriction.field);
                }
            }
            if (restrictedFields.size == 1) {
                return this.getExplanationForSingleField(context, [...restrictedFields][0]);
            }
        }

        return this.getGenericDataDependentExplanation(context);
    }

    getExplanationPrefixForAccessGroups(context: ConditionExplanationContext): string {
        const accessGroupFieldName = this.accessGroupField
            ? this.accessGroupField.name
            : this.accessGroupField;
        const typeName = (this.rootEntityType && this.rootEntityType.name) || '';
        switch (context) {
            case ConditionExplanationContext.BEFORE_WRITE:
                return `${typeName} objects with this access group (allowed access groups: `;
            case ConditionExplanationContext.SET:
                return `set ${typeName}.${accessGroupFieldName} to this value (allowed values: `;
        }
    }

    getExplanationForSingleField(context: ConditionExplanationContext, fieldName: string): string {
        const typeName = (this.rootEntityType && this.rootEntityType.name) || '';
        switch (context) {
            case ConditionExplanationContext.BEFORE_WRITE:
                return `this ${typeName} object`;
            case ConditionExplanationContext.SET:
                return `set ${typeName}.${fieldName} to this value`;
        }
    }

    getGeneralExplanation(context: ConditionExplanationContext): string {
        const typeName = (this.rootEntityType && this.rootEntityType.name) || '';
        switch (context) {
            case ConditionExplanationContext.BEFORE_WRITE:
                return `${typeName} objects`;
            case ConditionExplanationContext.SET:
                return `update ${typeName} objects`;
        }
    }

    getGenericDataDependentExplanation(context: ConditionExplanationContext): string {
        const typeName = (this.rootEntityType && this.rootEntityType.name) || '';
        switch (context) {
            case ConditionExplanationContext.BEFORE_WRITE:
                return `this ${typeName} object`;
            case ConditionExplanationContext.SET:
                return `set these values in ${typeName} objects`;
        }
    }
}
