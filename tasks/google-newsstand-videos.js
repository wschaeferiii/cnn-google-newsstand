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
    debugLog = require('debug')('cnn-google-newsstand:Task:google-newsstand-videos'),
    config = require('../config.js'),
    cloudamqpConnectionString = config.get('cloudamqpConnectionString'),
    fg = new FeedGenerator();

var connection = null;


// connect to CloudAMQP
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

// use/create the queue to subscribe to
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

        channel.assertQueue(config.get('queueNameVideos'), { durable: true }, (error, queueName) => {
            const routingKeys = config.get('routingKeysVideos');

            routingKeys.forEach((routingKey) => {
                channel.bindQueue(queueName.queue, exchangeName, routingKey);
            });

            channel.prefetch(1);

            channel.consume(
                queueName.queue,
                (message) => {
                    debugLog(`AMQP Message: ${message.fields.routingKey}: ${message.content.toString()}`);
                    debugLog(`Adding url to fg: ${JSON.parse(message.content.toString()).url} -> ${fg.urls}`);
                    fg.urls = JSON.parse(message.content.toString()).url;
                    channel.ack(message);
                },
                { noAck: false, exclusive: true }
            );
        });
    });
};

// kickoff
start()

function closeOnErr(error) {
    if (!error) return false;
    console.error('error', error);
    connection.close();
    return true;
}

function postToLSD(data) {
    let endpoint = '/cnn/content/google-newsstand/videos.xml',
        hosts = config.get('lsdHosts');

    debugLog('postToLSD() called');
    // debugLog(data);

    hosts.split(',').forEach((host) => {
        request.post({
            url: `http://${host}${endpoint}`,
            body: data,
            headers: { 'Content-Type': 'application/rss+xml' }
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



setInterval(() => {
    debugLog('Generate Feed interval fired');
    debugLog(fg.urls);

    if (fg.urls && fg.urls.length > 0) {
        fg.processContent().then(
            // success
            (rssFeed) => {
                console.log(rssFeed);

                // postToLSD(rssFeed);

                // post to LSD endpoint
                fg.urls = 'clear';
                debugLog(fg.urls);
            },

            // failure
            (error) => {
                console.log(error);
            }
        );
    } else {
        debugLog('no updates');
    }
}, config.get('gnsTaskIntervalMS'));
