/*
 * Copyright 2016 Turner Broadcasting System, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

const request = require('request'),
    FeedGenerator = require('../lib/feed-generator.js'),
    amqp = require('amqplib/callback_api'),
    debugLog = require('debug')('cnn-google-newsstand:Task:google-newsstand-latest'),
    config = require('../config.js'),
    cloudamqpConnectionString = config.get('cloudamqpConnectionString'),
    latestFG = new FeedGenerator(),
    entertainmentFG = new FeedGenerator(),
    healthFG = new FeedGenerator(),
    opinionsFG = new FeedGenerator(),
    politicsFG = new FeedGenerator(),
    techFG = new FeedGenerator(),
    usFG = new FeedGenerator(),
    worldFG = new FeedGenerator();


    var connection = null;

// kick off connection
function start() {
    // connect to CloudAMQP and use/create the queue to subscribe to
    amqp.connect(cloudamqpConnectionString, (error, amqpConn) => {
        // error handling, restart
        if (error) {
            console.error('error:', error);
            return setTimeout(start, 1000);
        }
        amqpConn.on('error', (error) => {
            if (error.message !== 'amqpConn closing') {
                console.error(error.message);
            }
        });
        amqpConn.on("close", () => {
        console.error("reconnecting");
        return setTimeout(start, 1000);
        });
        console.log('connected');
        connection = amqpConn;
        startWorker();
    });
}

function startWorker() {
    connection.createChannel((error, channel) => {
        if (closeOnErr(error)) return;
        channel.on('error', (error) => {
            console.error('channel error', error.message);
        });
        channel.on('close', () => {
            console.log('channel closed');
        });

        const exchangeName = config.get('exchangeName');

        channel.assertExchange(exchangeName, 'topic', { durable: true });

        channel.assertQueue(config.get('queueNameArticles'), { durable: true }, (error, queueName) => {
            const routingKeys = config.get('routingKeysArticles');

            routingKeys.forEach((routingKey) => {
                channel.bindQueue(queueName.queue, exchangeName, routingKey);
            });

            channel.prefetch(1);

            channel.consume(
                queueName.queue,
                (message) => {
                    let mappedToASection = false;

                    debugLog(`AMQP Message: ${message.fields.routingKey}: ${message.content.toString()}`);
                    debugLog(`Adding url to latest feed: ${JSON.parse(message.content.toString()).url}`);
                    latestFG.urls = JSON.parse(message.content.toString()).url;

                    if (/\/entertainment\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to entertainment feed: ${JSON.parse(message.content.toString()).url}`);
                        entertainmentFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/politics\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to politics feed: ${JSON.parse(message.content.toString()).url}`);
                        politicsFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/health\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to health feed: ${JSON.parse(message.content.toString()).url}`);
                        healthFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/opinions|opinion\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to opinions feed: ${JSON.parse(message.content.toString()).url}`);
                        opinionsFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/tech\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to tech feed: ${JSON.parse(message.content.toString()).url}`);
                        techFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/us|crime|justice\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to us feed: ${JSON.parse(message.content.toString()).url}`);
                        usFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (/\/world\//.test(JSON.parse(message.content.toString()).url)) {
                        debugLog(`Adding url to world feed: ${JSON.parse(message.content.toString()).url}`);
                        worldFG.urls = JSON.parse(message.content.toString()).url;
                        mappedToASection = true;
                    }

                    if (!mappedToASection) {
                        debugLog(`${JSON.parse(message.content.toString()).url} - DEFAULTING to world feed`);
                        worldFG.urls = JSON.parse(message.content.toString()).url;
                    }

                    channel.ack(message);
                },
                {noAck: false, exclusive: true}
            );
        });
    });
}

// kickoff
start();


function closeOnErr(error) {
    if (!error) return false;
    console.error('error', error);
    connection.close();
    return true;
}

function postToLSD(data, feedName) {
    let endpoint = `/cnn/content/google-newsstand/${feedName}.xml`,
        hosts = config.get('lsdHosts');

    debugLog('postToLSD() called');
    // debugLog(data);

    hosts.split(',').forEach((host) => {
        request.post({
            url: `http://${host}${endpoint}`,
            body: data,
            headers: {'Content-Type': 'application/rss+xml'}
        },
        (error/* , response, body*/) => {
            if (error) {
                debugLog(error.stack);
            } else {
                debugLog(`Successfully uploaded data to ${hosts} at ${endpoint}`);
                // debugLog(body);
            }
        });
    });
}

function fgProcessContent(fg) {
    fg.processContent().then(
        // success
        (rssFeed) => {
            console.log(rssFeed);

            postToLSD(rssFeed, 'latest');

            // post to LSD endpoint
            latestFG.urls = 'clear';
            debugLog(latestFG.urls);
        },

        // failure
        (error) => {
            console.log(error);
        }
    );
}

// brutish force.  This is not the final solution, but it works just fine
setInterval(() => {
    debugLog('Generate latest Feed interval fired');

    if (latestFG.urls && latestFG.urls.length > 0) {
        fgProcessContent(latestFG);
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate entertainment Feed interval fired');

    if (entertainmentFG.urls && entertainmentFG.urls.length > 0) {
        fgProcessContent(entertainmentFG);
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate health Feed interval fired');

    if (healthFG.urls && healthFG.urls.length > 0) {
        fgProcessContent(healthFG);
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate opinions Feed interval fired');

    if (opinionsFG.urls && opinionsFG.urls.length > 0) {
        fgProcessContent(opinionsFG);
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate politics Feed interval fired');

    if (politicsFG.urls && politicsFG.urls.length > 0) {
        fgProcessContent(politicsFG);
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate tech Feed interval fired');

    if (techFG.urls && techFG.urls.length > 0) {
        fgProcessContent(techFG);
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate us Feed interval fired');

    if (usFG.urls && usFG.urls.length > 0) {
       fgProcessContent(usFG);
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));

setInterval(() => {
    debugLog('Generate world Feed interval fired');

    if (worldFG.urls && worldFG.urls.length > 0) {
        fgProcessContent(worldFG);
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));
