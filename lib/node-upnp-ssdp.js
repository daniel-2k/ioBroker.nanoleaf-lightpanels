const dgram = require('dgram');
const util = require('util');
const events = require('events');
const _ = require('underscore');

const SSDP_PORT = 1900;
const SSDP_MSEARCHREPLY_PORT = 5000;
const BROADCAST_ADDR = '239.255.255.250';
const SSDP_ALIVE = 'ssdp:alive';
const SSDP_BYEBYE = 'ssdp:byebye';
const SSDP_UPDATE = 'ssdp:update';
const SSDP_ALL = 'ssdp:all';

const SSDP_NTS_EVENTS = {
	[SSDP_ALIVE]: 'DeviceAvailable',
	[SSDP_BYEBYE]: 'DeviceUnavailable',
	[SSDP_UPDATE]: 'DeviceUpdate',
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const UPNP_FIELDS = [
	'host',
	'server',
	'location',
	'st',
	'usn',
	'nts',
	'nt',
	'bootid.upnp.org',
	'configid.upnp.org',
	'nextbootid.upnp.org',
	'searchport.upnp.org',
];

function messageLines(msg) {
	return msg.toString('ascii').split('\r\n');
}

function toKeyPair(header) {
	let result;
	const splitCharIndex = header.indexOf(':');
	if (splitCharIndex > 0) {
		result = {};
		result[header.slice(0, splitCharIndex).toLowerCase().trim()] = header.slice(splitCharIndex + 1).trim();
	}
	return result;
}

function mSearchResponseParser(msg, rinfo) {
	const headers = messageLines(msg);
	// add address to headers
	headers.push(`address: ${rinfo.address}`);
	if (headers[0] === 'HTTP/1.1 200 OK') {
		return _.chain(headers)
			.map(toKeyPair)
			.compact()
			.reduce(function (memo, obj) {
				return _.extend(memo, obj);
			}, {})
			.value();
	}
	return void 0;
}

function notifyResponseParser(msg, rinfo) {
	const headers = messageLines(msg);
	// add address to headers
	headers.push(`address: ${rinfo.address}`);
	if (headers[0] === 'NOTIFY * HTTP/1.1') {
		return _.chain(headers)
			.map(toKeyPair)
			.compact()
			.reduce(function (memo, obj) {
				return _.extend(memo, obj);
			}, {})
			.value();
	}
	return void 0;
}

function announceDiscoveredDevice(emitter) {
	return function (msg, rinfo) {
		const device = mSearchResponseParser(msg, rinfo);
		if (device) {
			emitter.emit('DeviceFound', device);
		}
	};
}

function announceDevice(emitter) {
	return function (msg, rinfo) {
		const device = notifyResponseParser(msg, rinfo);
		if (device) {
			emitter.emit(SSDP_NTS_EVENTS[device.nts], device);
			emitter.emit(`${SSDP_NTS_EVENTS[device.nts]}:${device.nt}`, device);
		}
	};
}

function Ssdp(interface) {
	events.EventEmitter.call(this);

	const udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true }, announceDevice(this));
	udpServer.bind(SSDP_PORT, function onConnected() {
		udpServer.addMembership(BROADCAST_ADDR, interface);
	});

	this.close = function (callback) {
		udpServer.close(callback);
	};

	this.mSearch = function (st) {
		if (typeof st !== 'string') {
			st = SSDP_ALL;
		}

		const message =
			`M-SEARCH * HTTP/1.1\r\n` +
			`Host:${BROADCAST_ADDR}:${SSDP_PORT}\r\n` +
			`ST:${st}\r\n` +
			`Man:"ssdp:discover"\r\n` +
			`MX:2\r\n\r\n`;

		const mSearchListener = dgram.createSocket({ type: 'udp4', reuseAddr: true }, announceDiscoveredDevice(this));
		const mSearchRequester = dgram.createSocket({ type: 'udp4', reuseAddr: true });

		mSearchListener.on('listening', function () {
			mSearchRequester.send(
				new Buffer(message, 'ascii'),
				0,
				message.length,
				SSDP_PORT,
				BROADCAST_ADDR,
				function closeMSearchRequester() {
					mSearchRequester.close();
				},
			);
		});

		mSearchRequester.on('listening', function () {
			mSearchListener.bind(mSearchRequester.address().port);
		});

		mSearchRequester.bind(SSDP_MSEARCHREPLY_PORT, interface);

		// MX is set to 2, wait for 1 additional sec. before closing the server
		setTimeout(function () {
			mSearchListener.close();
		}, 3000);
	};
}

util.inherits(Ssdp, events.EventEmitter);

module.exports.start = function (interface) {
	return new Ssdp(interface);
};
