const _ = require('underscore');
const fs = require('fs');
const http = require('http');
const https = require('https');
const lnurl = require('../');
const path = require('path');
const querystring = require('querystring');
const tmpDir = path.join(__dirname, 'tmp');
const url = require('url');

const lightningBackendRequestTypes = {
	channelRequest: 'openchannel',
	login: null,
	payRequest: 'addinvoice',
	withdrawRequest: 'payinvoice',
};

module.exports = {
	tmpDir,
	createServer: function(options) {
		options = _.defaults(options || {}, {
			host: 'localhost',
			port: 3000,
			lightning: {
				backend: process.env.LNURL_LIGHTNING_BACKEND || 'lnd',
				config: {},
			},
			tls: {
				certPath: path.join(tmpDir, 'tls.cert'),
				keyPath: path.join(tmpDir, 'tls.key'),
			},
			store: {
				backend: process.env.LNURL_STORE_BACKEND || 'memory',
				config: (process.env.LNURL_STORE_CONFIG && JSON.parse(process.env.LNURL_STORE_CONFIG)) || {},
			},
		});
		const server = lnurl.createServer(options);
		server.once('listening', () => {
			if (server.options.protocol === 'https') {
				const { certPath } = server.options.tls;
				server.ca = fs.readFileSync(certPath).toString();
			}
		});
		return server;
	},
	prepareMockLightningNode: function(backend, options, done) {
		if (_.isFunction(backend)) {
			done = backend;
			options = null;
			backend = process.env.LNURL_LIGHTNING_BACKEND || 'lnd';
		} else if (_.isFunction(options)) {
			done = options;
			options = null;
		}
		options = options || {};
		switch (backend) {
			case 'lnd':
				options = _.defaults(options || {}, {
					certPath: path.join(tmpDir, 'lnd-tls.cert'),
					keyPath: path.join(tmpDir, 'lnd-tls.key'),
					macaroonPath: path.join(tmpDir, 'lnd-admin.macaroon'),
				});
				break;
		}
		const mock = lnurl.Server.prototype.prepareMockLightningNode(backend, options, done);
		mock.backend = backend;
		mock.requestCounters = _.chain([
			'getinfo',
			'openchannel',
			'payinvoice',
			'addinvoice',
		]).map(function(key) {
			return [key, 0];
		}).object().value();
		mock.resetRequestCounters = function() {
			this.requestCounters = _.mapObject(this.requestCounters, () => {
				return 0;
			});
		};
		mock.expectNumRequestsToEqual = function(tag, total) {
			const type = lightningBackendRequestTypes[tag];
			if (!_.isUndefined(mock.requestCounters[type])) {
				if (mock.requestCounters[type] !== total) {
					throw new Error(`Expected ${total} requests of type: "${type}"`);
				}
			}
		};
		return mock;
	},
	request: function(method, requestOptions) {
		return new Promise((resolve, reject) => {
			const parsedUrl = url.parse(requestOptions.url);
			let options = _.chain(requestOptions).pick('ca', 'headers').extend({
				method: method.toUpperCase(),
				hostname: parsedUrl.hostname,
				port: parsedUrl.port,
				path: parsedUrl.path,
			}).value();
			options.headers = options.headers || {};
			if (requestOptions.qs) {
				options.path += '?' + querystring.stringify(requestOptions.qs);
			}
			let postData;
			if (requestOptions.form) {
				options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
				postData = querystring.stringify(requestOptions.form);
			} else if (requestOptions.body && requestOptions.json) {
				options.headers['Content-Type'] = 'application/json';
				postData = querystring.stringify(requestOptions.body);
			}
			if (postData) {
				options.headers['Content-Length'] = Buffer.byteLength(postData);
			}
			const request = parsedUrl.protocol === 'https:' ? https.request : http.request;
			const req = request(options, function(response) {
				let body = '';
				response.on('data', function(buffer) {
					body += buffer.toString();
				});
				response.on('end', function() {
					if (requestOptions.json) {
						try {
							body = JSON.parse(body);
						} catch (error) {
							return reject(error);
						}
					}
					resolve({ response, body });
				});
			});
			if (postData) {
				req.write(postData);
			}
			req.once('error', reject);
			req.end();
		});
	},
};
