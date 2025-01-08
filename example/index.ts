import { ArangoDBAdapter, Project } from 'cruddl';
import { ApolloServer } from 'apollo-server';

// arangodb --starter.local --starter.mode=single  --starter.port=8529
const db = new ArangoDBAdapter({
    databaseName: 'test',
    url: 'http://localhost:8529',
    user: 'root',
    password: '',
});

const project = new Project({
    sources: [
        {
            name: 'schema.graphqls',
            body: `
      type Order @rootEntity {
        orderNumber: String
          items: [OrderItem]
          deliveryAddress: Address
        paymentInfo: PaymentInfo
      }

      type PaymentInfo @entityExtension {
        creditCardNumber: String
      }

      type OrderItem @childEntity {
        itemNumber: String
          quantity: Int
      }

      type Address @valueObject {
        street: String
        postalCode: String
        city: String
          country: Country @reference
      }

      type Country @rootEntity {
          isoCode: String @key
          description: String
      }`,
        },
        {
            name: 'permission-profiles.json',
            body: JSON.stringify({
                permissionProfiles: {
                    default: {
                        permissions: [
                            {
                                roles: ['users'],
                                access: 'readWrite',
                            },
                        ],
                    },
                },
            }),
        },
    ],
    getExecutionOptions: ({ context }) => ({ authContext: { authRoles: ['users'] } }),
    getOperationIdentifier: ({ context }) => context as object, // each operation is executed with a unique context object
});

try {
    const schema = project.createSchema(db);
    db.updateSchema(project.getModel()); // create missing collections
    const server = new ApolloServer({
        schema,
        context: ({ req }) => req, // pass request as context so we have a unique context object for each operation
    });
    server.listen(4000, () => console.log('Server is running on http://localhost:4000/'));
} catch (error: any) {
    console.log("Did you create the 'test' database?");
    console.log(error.stack);
}
