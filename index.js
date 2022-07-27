// This project is derived from a [blog post](https://jungleeforce.com/2021/11/11/connecting-to-salesforce-using-pub-sub-api-grpc/) from techinjungle.
// Official Pub/Sub API pilot repo: https://github.com/developerforce/pub-sub-api-pilot

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const jsforce = require('jsforce');
const avro = require('avro-js');
const certifi = require('certifi');

// Load config from .env file
require('dotenv').config();
const {
    SALESFORCE_LOGIN_URL,
    SALESFORCE_USERNAME,
    SALESFORCE_PASSWORD,
    SALESFORCE_TOKEN,
    PUB_SUB_ENDPOINT,
    PUB_SUB_PROTO_FILE,
    PUB_SUB_TOPIC_NAME,
    PUB_SUB_EVENT_RECEIVE_LIMIT
} = process.env;

/**
 * Connects to Salesforce using jsForce
 * This is required to obtain an access token that the Pub/Sub API uses.
 * @returns the Salesforce connection
 */
async function connectToSalesforce() {
    const sfConnection = new jsforce.Connection({
        loginUrl: SALESFORCE_LOGIN_URL
    });
    await sfConnection.login(
        SALESFORCE_USERNAME,
        SALESFORCE_PASSWORD + SALESFORCE_TOKEN
    );
    console.log(
        `Connected to Salesforce org ${sfConnection.instanceUrl} as ${SALESFORCE_USERNAME}`
    );
    return sfConnection;
}

/**
 * Connects to the Pub/Sub API and returns a gRPC client
 * @param {jsforce.Connection} sfConnection the Salesforce connection
 * @returns a gRPC client
 */
function connectToPubSubApi(sfConnection) {
    // Read certificates
    const rootCert = fs.readFileSync(certifi);

    // Load proto definition
    const packageDef = protoLoader.loadSync(PUB_SUB_PROTO_FILE, {});
    const grpcObj = grpc.loadPackageDefinition(packageDef);
    const sfdcPackage = grpcObj.eventbus.v1;

    // Prepare gRPC connection
    const metaCallback = (_params, callback) => {
        const meta = new grpc.Metadata();
        meta.add('accesstoken', sfConnection.accessToken);
        meta.add('instanceurl', sfConnection.instanceUrl);
        meta.add('tenantid', sfConnection.userInfo.organizationId);
        callback(null, meta);
    };
    const callCreds =
        grpc.credentials.createFromMetadataGenerator(metaCallback);
    const combCreds = grpc.credentials.combineChannelCredentials(
        grpc.credentials.createSsl(rootCert),
        callCreds
    );

    // Return pub/sub gRPC client
    const client = new sfdcPackage.PubSub(PUB_SUB_ENDPOINT, combCreds);
    console.log(`Pub/Sub API client is ready to connect`);
    return client;
}

/**
 * Requests the event schema for a topic
 * @param {Object} client Pub/Sub API gRPC client
 * @param {string} topicName name of the topic that we're fetching
 * @returns {Object} parsed event schema `{id: string, type: Object}`
 */
async function getEventSchema(client, topicName) {
    return new Promise((resolve, reject) => {
        client.GetTopic({ topicName }, (err, response) => {
            if (err) {
                // Handle error
                reject(err);
            } else {
                // Get the schema information
                const schemaId = response.schemaId;
                client.GetSchema({ schemaId }, (error, res) => {
                    if (error) {
                        // Handle error
                        reject(err);
                    } else {
                        const schemaType = avro.parse(res.schemaJson);
                        console.log(`Topic schema loaded: ${topicName}`);
                        resolve({
                            id: schemaId,
                            type: schemaType
                        });
                    }
                });
            }
        });
    });
}

/**
 * Subscribes to a topic using the gRPC client and an event schema
 * @param {Object} client Pub/Sub API gRPC client
 * @param {string} topicName name of the topic that we're subscribing to
 * @param {Object} schema event schema associated with the topic
 * @param {string} schema.id
 * @param {Object} schema.type
 */
function subscribe(client, topicName, schema) {
    const subscription = client.Subscribe(); //client here is the grpc client.
    //Since this is a stream, you can call the write method multiple times.
    //Only the required data is being passed here, the topic name & the numReqested
    //Once the system has received the events == to numReqested then the stream will end.
    const subscribeRequest = {
        topicName,
        numRequested: PUB_SUB_EVENT_RECEIVE_LIMIT
    };
    subscription.write(subscribeRequest);
    console.log(
        `Subscribe request sent for ${subscribeRequest.numRequested} events from ${topicName}...`
    );

    // Listen to new events.
    subscription.on('data', (data) => {
        if (data.events) {
            const latestReplayId = data.latestReplayId.readBigUInt64BE();
            console.log(
                `Received ${data.events.length} events, latest replay ID: ${latestReplayId}`
            );
            const parsedEvents = data.events.map((event) =>
                _parseEvent(schema, event)
            );
            console.log(
                'gRPC event payloads: ',
                JSON.stringify(parsedEvents, null, 2)
            );
        } else {
            // If there are no events then every 270 seconds the system will keep publishing the latestReplayId.
        }
    });
    subscription.on('end', () => {
        console.log('gRPC stream ended');
    });
    subscription.on('error', (err) => {
        // Handle errors
        console.error('gRPC stream error: ', JSON.stringify(err));
    });
    subscription.on('status', (status) => {
        console.log('gRPC stream status: ', status);
    });
}

function _parseEvent(schema, event) {
    const allFields = schema.type.getFields();
    const replayId = event.replayId.readBigUInt64BE().toString();
    const payload = schema.type.fromBuffer(event.event.payload); // This schema is the same which we retreived earlier in the GetSchema rpc.
    payload.ChangeEventHeader.nulledFields = _parseFieldBitmap(
        schema,
        payload.ChangeEventHeader.nulledFields
    );
    payload.ChangeEventHeader.diffFields = _parseFieldBitmap(
        allFields,
        payload.ChangeEventHeader.diffFields
    );
    payload.ChangeEventHeader.changedFields = _parseFieldBitmap(
        allFields,
        payload.ChangeEventHeader.changedFields
    );
    return {
        replayId,
        payload
    };
}

function _parseFieldBitmap(allFields, fieldBitmapsAsHex) {
    if (fieldBitmapsAsHex.length === 0) {
        return [];
    }
    const impactedFields = [];
    for (let fieldBitmapAsHex of fieldBitmapsAsHex) {
        let binValue = _hexToBin(fieldBitmapAsHex.substring(2)); // Removing 0x prefix
        binValue = _reverseBytes(binValue); // Reverse byte order to match expected format
        // Use bitmap to figure out impacted field indexes
        for (let i = 0; i < binValue.length; i++) {
            if (binValue[i] === '1') {
                impactedFields.push(allFields[i].getName());
            }
        }
    }
    return impactedFields;
}

function _reverseBytes(input) {
    let output = '';
    for (let i = input.length / 8 - 1; i >= 0; i--) {
        output += input.substring(i * 8, (i + 1) * 8);
    }
    return output;
}

function _hexToBin(hex) {
    hex = hex.replaceAll('0', '0000');
    hex = hex.replaceAll('1', '0001');
    hex = hex.replaceAll('2', '0010');
    hex = hex.replaceAll('3', '0011');
    hex = hex.replaceAll('4', '0100');
    hex = hex.replaceAll('5', '0101');
    hex = hex.replaceAll('6', '0110');
    hex = hex.replaceAll('7', '0111');
    hex = hex.replaceAll('8', '1000');
    hex = hex.replaceAll('9', '1001');
    hex = hex.replaceAll('A', '1010');
    hex = hex.replaceAll('B', '1011');
    hex = hex.replaceAll('C', '1100');
    hex = hex.replaceAll('D', '1101');
    hex = hex.replaceAll('E', '1110');
    hex = hex.replaceAll('F', '1111');
    return hex;
}

/**
 * Publishes a payload to a topic using the gRPC client
 * @param {Object} client Pub/Sub API gRPC client
 * @param {string} topicName name of the topic that we're subscribing to
 * @param {Object} schema event schema associated with the topic
 * @param {string} schema.id
 * @param {Object} schema.type
 * @param {Object} payload
 */
async function publish(client, topicName, schema, payload) {
    return new Promise((resolve, reject) => {
        client.Publish(
            {
                topicName,
                events: [
                    {
                        id: '124', // this can be any string
                        schemaId: schema.id,
                        payload: schema.type.toBuffer(payload)
                    }
                ]
            },
            (err, response) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(response);
                }
            }
        );
    });
}

async function run() {
    try {
        const sfConnection = await connectToSalesforce();
        const client = connectToPubSubApi(sfConnection);
        const topicSchema = await getEventSchema(client, PUB_SUB_TOPIC_NAME);
        subscribe(client, PUB_SUB_TOPIC_NAME, topicSchema);
    } catch (err) {
        console.error('Fatal error: ', err);
    }
}

run();
