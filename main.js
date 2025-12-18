/* jshint -W097 */ // jshint strict:false
/*jslint node: true */
'use strict';

// you have to require the utils module and call adapter function
let utils = require('@iobroker/adapter-core'); // Get common adapter utils
let adapter;

// constants
const SSDPUPNP = require(`${__dirname}/lib/node-upnp-ssdp`);
const DNS = require('dns');
const NET = require('net');
const AURORA_API = require(`${__dirname}/lib/nanoleaf-aurora-api`);
const STATE_EXCLUDES = ['brightness_duration']; // Exclude list for states
const MIN_POLLING_INTERVAL = 500; // minimum polling interval in milliseconds
const MIN_RECONNECT_INTERVAL = 10; // minimum interval for reconnect attempts in seconds
const DEFAULT_TIMEOUT = 10000;
const KEEPALIVE_INTERVAL = 75000; // interval in ms when device is not alive anymore
const MIN_KEEPALIVE_POLLING_INTERVAL = 10; // minimum interval in seconds for polling keep alive detection
const SSDP_MSEARCH_TIMEOUT = 5000; // time to wait for getting SSDP answers for a MSEARCH
const MSEARCH_ST = 'ssdp:all'; // Service type for MESEARCH -> all to develop all kind of nanoleaf devices
const SEMVER = require('semver');

// nanoleaf device definitions
const NANOLEAF_DEVICES = {
	lightpanels: {
		model: 'NL22',
		deviceName: 'LightPanels',
		name: 'Light Panels',
		SSDP_NT_ST: 'nanoleaf_aurora:light',
		SSEFirmware: '3.1.0',
		hasTouch: false,
	},
	canvas: {
		model: 'NL29',
		deviceName: 'Canvas',
		name: 'Canvas',
		SSDP_NT_ST: 'nanoleaf:nl29',
		SSEFirmware: '1.1.0',
		hasTouch: true,
	},
	shapes: {
		model: 'NL42',
		deviceName: 'Shapes',
		name: 'Shapes',
		SSDP_NT_ST: 'nanoleaf:nl42',
		SSEFirmware: '4.0.2',
		hasTouch: true,
	},
	elements: {
		model: 'NL52',
		deviceName: 'Elements',
		name: 'Elements',
		SSDP_NT_ST: 'nanoleaf:nl52',
		SSEFirmware: '1.0.0',
		hasTouch: true,
	},
	lines: {
		model: 'NL59',
		deviceName: 'Lines',
		name: 'Lines',
		SSDP_NT_ST: 'nanoleaf:nl59',
		SSEFirmware: '1.0.0',
		hasTouch: false,
	},
	skylight: {
		model: 'NL64',
		deviceName: 'Skylight',
		name: 'Skylight',
		SSDP_NT_ST: 'nanoleaf:nl64',
		SSEFirmware: '1.0.0',
		hasTouch: false,
	},
};
// variables
let auroraAPI; // Instance of auroraAPI-Client
let isConnected; // indicates connection to device (same value as info.connection state)
let lastError; // keeps the last error occurred
let commandQueue = []; // Array for all state changes (commands) to process (Queue)
let commandQueueProcessing = false; // flag to show that command queue processing is in progress
let NLdevice; // holds the nanoleaf device type which will be processed
let NL_UUID; // UUID of NL device received via SSDP
let SSDP_devices = []; // list of devices found via SSDP MSEARCH
let SSEenabled; // indicates if SSE is enabled
let SSDP; // SSDP object

// Timers
let pollingTimer;
let connectTimer;
let keepAliveTimer;
let SSDP_mSearchTimer;

let pollingInterval;
let reconnectInterval;
let keepAlivePollingInterval;

function startAdapter(options) {
	options = options || {};

	Object.assign(options, {
		name: 'nanoleaf-lightpanels',
	});

	adapter = new utils.Adapter(options);

	adapter.on('ready', function () {
		adapter.log.info(`Nanoleaf adapter '${adapter.namespace}' started.`);
		main();
	});

	// is called when adapter shuts down - callback has to be called under any circumstances!
	adapter.on('unload', function (callback) {
		try {
			adapter.log.info(`Shutting down Nanoleaf adapter '${adapter.namespace}'...`);
			StopPollingTimer();
			StopConnectTimer();
			SSDP.close();
			auroraAPI.stopSSE();
			callback();
		} catch (_e) {
			callback();
		}
	});

	// Some message was sent to adapter instance
	adapter.on('message', function (obj) {
		adapter.log.debug(`Incoming adapter message: ${obj.command}`);

		switch (obj.command) {
			case 'getAuthToken': {
				adapter.log.info(
					`Try to obtain authorization token from '${obj.message.host}:${obj.message.port}' (device has to be in pairing mode!)`,
				);

				let messageObj = {};

				AURORA_API.getAuthToken(obj.message.host, obj.message.port)
					.then(function (authToken) {
						messageObj.message = 'SuccessGetAuthToken';
						messageObj.authToken = authToken;

						adapter.log.info(`Got new Authentication Token: '${authToken}'`);
					})
					.catch(function (error) {
						messageObj.message = error.errorCode;

						adapter.log.error(error.message);
						if (error.messageDetail) {
							adapter.log.debug(error.messageDetail);
						}
					})
					.finally(function () {
						if (obj.callback) {
							adapter.sendTo(obj.from, obj.command, messageObj, obj.callback);
						}
					});
				break;
			}
			case 'searchDevice': {
				SSDP_mSearch(function (devices) {
					adapter.log.debug(`MSEARCH: ${devices.length} devices found!`);

					SSDP_mSearchTimer = null;

					if (obj.callback) {
						adapter.sendTo(obj.from, obj.command, devices, obj.callback);
					}
				});
				break;
			}
			default:
				adapter.log.debug(`Invalid adapter message send: ${obj}`);
		}
	});

	// is called if a subscribed state changes
	adapter.on('stateChange', function (id, state) {
		if (state) {
			adapter.log.debug(`State change ${state.ack ? 'status' : 'command'}: id: ${id}: ${JSON.stringify(state)}`);
		}

		// acknowledge false for command
		if (state && !state.ack) {
			let stateID = id.split('.');
			// get state name
			let stateName = stateID.pop();
			// get device name
			let DeviceName = stateID.pop();

			if (DeviceName == NLdevice.deviceName || DeviceName == 'Rhythm') {
				commandQueue.push({ stateName, state, id });
				adapter.log.debug(
					`Command '${stateName}' with value '${state.val}' added to queue! Queue length: ${
						commandQueue.length
					}`,
				);

				// start processing commands when not in progress
				if (!commandQueueProcessing) {
					adapter.log.debug('Start processing commands...');
					processCommandQueue();
				}
			}
		}
	});

	return adapter;
}

// process command queue
function processCommandQueue() {
	let nextCommand = commandQueue.shift();

	if (!nextCommand) {
		commandQueueProcessing = false;
		adapter.log.debug('No further commands in queue. Processing finished.');
		return;
	}
	let stateName = nextCommand.stateName;
	let state = nextCommand.state;
	let id = nextCommand.id;
	commandQueueProcessing = true;

	adapter.log.debug(
		`Process new command '${stateName}' with value '${state.val}' from queue. Commands remaining: ${
			commandQueue.length
		}`,
	);

	switch (stateName) {
		// Power On/Off
		case 'state':
			if (state.val) {
				auroraAPI
					.turnOn()
					.then(function () {
						adapter.log.debug('OpenAPI: Device turned on');
						adapter.setState(id, { ack: true });
					})
					.catch(function (err) {
						logApiError('OpenAPI: Error turning on light panels', err);
					})
					.then(function () {
						processCommandQueue();
					});
			} else {
				auroraAPI
					.turnOff()
					.then(function () {
						adapter.log.debug('OpenAPI: Device turned off');
						adapter.setState(id, { ack: true });
					})
					.catch(function (err) {
						logApiError('OpenAPI: Error turning off light panels', err);
					})
					.then(function () {
						processCommandQueue();
					});
			}
			break;
		// Brightness
		case 'brightness':
			adapter.getState(`${NLdevice.deviceName}.brightness_duration`, function (err, obj) {
				let duration = 0;

				if (err) {
					adapter.log.error(`Error while reading 'brightness_duration' object: ${err}`);
				} else if (Number.isInteger(obj.val)) {
					duration = obj.val;
				}

				auroraAPI
					.setBrightness(parseInt(state.val), duration) // parseInt to fix vis colorPicker
					.then(function () {
						adapter.log.debug(
							`OpenAPI: Brightness set to ${state.val} with duration of ${duration} seconds`,
						);
						adapter.setState(id, { ack: true });
					})
					.catch(function (err) {
						logApiError(
							`OpenAPI: Error while setting brightness value ${state.val} with duration of ${
								duration
							} seconds`,
							err,
						);
					})
					.then(function () {
						processCommandQueue();
					});
			});
			break;
		// Hue
		case 'hue':
			auroraAPI
				.setHue(parseInt(state.val)) // parseInt to fix vis colorPicker
				.then(function () {
					adapter.log.debug(`OpenAPI: Hue set to ${state.val}`);
					adapter.setState(id, { ack: true });
				})
				.catch(function (err) {
					logApiError(`OpenAPI: Error while setting hue value ${state.val}`, err);
				})
				.then(function () {
					processCommandQueue();
				});
			break;
		// Saturation
		case 'saturation':
			auroraAPI
				.setSat(parseInt(state.val)) // parseInt to fix vis colorPicker
				.then(function () {
					adapter.log.debug(`OpenAPI: Saturation set to ${state.val}`);
					adapter.setState(id, { ack: true });
				})
				.catch(function (err) {
					logApiError(`OpenAPI: Error while setting saturation value ${state.val}`, err);
				})
				.then(function () {
					processCommandQueue();
				});
			break;
		// Color Temperature
		case 'colorTemp':
			auroraAPI
				.setColourTemperature(state.val)
				.then(function () {
					adapter.log.debug(`OpenAPI: Color temperature set to ${state.val}`);
					adapter.setState(id, { ack: true });
				})
				.catch(function (err) {
					logApiError(`OpenAPI: Error while setting color temperature ${state.val}`, err);
				})
				.then(function () {
					processCommandQueue();
				});
			break;
		// RGB Color
		case 'colorRGB': {
			let rgb = RGBHEXtoRGBDEC(state.val);
			if (rgb) {
				auroraAPI
					.setRGB(rgb.R, rgb.G, rgb.B)
					.then(function () {
						adapter.log.debug(`OpenAPI: RGB color set to ${state.val} (${rgb.R},${rgb.G},${rgb.B})`);
						adapter.setState(id, { ack: true });
					})
					.catch(function (err) {
						logApiError(`OpenAPI: Error while setting RGB color R=${rgb.R}, G=${rgb.G}, B=${rgb.B}`, err);
					})
					.then(function () {
						processCommandQueue();
					});
			} else {
				adapter.log.error(`OpenAPI: set RGB color: Supplied RGB hex string '${state.val}' is invalid!`);
				processCommandQueue();
			}
			break;
		}
		// Current effect
		case 'effect':
			auroraAPI
				.setEffect(state.val)
				.then(function () {
					adapter.log.debug(`OpenAPI: Effect set to '${state.val}'`);
					adapter.setState(id, { ack: true });
				})
				.catch(function (err) {
					logApiError(`OpenAPI: Error while setting effect '${state.val}'`, err);
				})
				.then(function () {
					processCommandQueue();
				});
			break;
		// write effect
		case 'effectWrite':
			try {
				let effectObj = JSON.parse(state.val);

				auroraAPI
					.writeEffect(effectObj)
					.then(function (data) {
						adapter.log.debug(`OpenAPI: Write Effect '${state.val}'`);
						adapter.setState(id, { ack: true });
						//write response
						adapter.setState(`${id}Response`, { val: data, ack: true });
					})
					.catch(function (err) {
						logApiError(`OpenAPI: Error while writing effect '${state.val}'`, err);
					})
					.then(function () {
						processCommandQueue();
					});
			} catch (err) {
				adapter.log.error(`The supplied value for 'effectWrite' is no valid JSON! Error: ${err.message}`);
			}
			break;
		// Identify
		case 'identify':
			auroraAPI
				.identify()
				.then(function () {
					adapter.log.debug('OpenAPI: Identify panels enabled!');
					adapter.setState(id, { ack: true });
				})
				.catch(function (err) {
					logApiError('OpenAPI: Error while triggering identification', err);
				})
				.then(function () {
					processCommandQueue();
				});
			break;
		// Rhythm Mode
		case 'rhythmMode':
			auroraAPI
				.setRhythmMode(state.val)
				.then(function () {
					adapter.log.debug(`OpenAPI: Rhythm mode set to '${state.val}'`);
					adapter.setState(id, { ack: true });
				})
				.catch(function (err) {
					logApiError(`OpenAPI: Error while setting rhythm mode '${state.val}'`, err);
				})
				.then(function () {
					processCommandQueue();
				});
			break;
		// no valid command -> skip and warn if not in exclude list
		default:
			if (!STATE_EXCLUDES.includes(stateName)) {
				adapter.log.warn(`Command for state '${stateName} invalid, skipping...`);
			}
			processCommandQueue();
	}
}

// clear command queue
function clearCommandQueue() {
	commandQueue.length = 0;

	adapter.log.debug('Command queue cleared!');
}

// convert HSV color to RGB color
/**
 * @param hue
 * @param saturation
 * @param value
 * @returns {string}
 */
function HSVtoRGB(hue, saturation, value) {
	let h, i, f, s, v, p, q, t, r, g, b;

	s = saturation / 100;
	v = value / 100;

	if (s == 0) {
		// achromatic (Gray)
		r = g = b = v;
	} else {
		h = hue / 60;
		i = Math.floor(h);
		f = h - i;
		p = v * (1 - s);
		q = v * (1 - s * f);
		t = v * (1 - s * (1 - f));

		switch (i) {
			case 0:
				r = v;
				g = t;
				b = p;
				break;
			case 1:
				r = q;
				g = v;
				b = p;
				break;
			case 2:
				r = p;
				g = v;
				b = t;
				break;
			case 3:
				r = p;
				g = q;
				b = v;
				break;
			case 4:
				r = t;
				g = p;
				b = v;
				break;
			default:
				r = v;
				g = p;
				b = q;
				break;
		}
	}

	// convert to hex
	return `#${`0${Math.round(r * 255).toString(16)}`.slice(-2)}${`0${Math.round(g * 255).toString(16)}`.slice(
		-2,
	)}${`0${Math.round(b * 255).toString(16)}`.slice(-2)}`;
}

// convert RGB hex string to decimal RGB components object
function RGBHEXtoRGBDEC(RGBHEX) {
	let pattern = new RegExp('^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$', 'i');
	let RGBDEC = {};
	let res;

	if ((res = pattern.exec(RGBHEX.trim()))) {
		RGBDEC.R = parseInt(res[1], 16);
		RGBDEC.G = parseInt(res[2], 16);
		RGBDEC.B = parseInt(res[3], 16);

		return RGBDEC;
	}
	return null;
}

function getDevice(url, ip, name) {
	let devInfo;
	const pattern = /http:\/\/([0-9a-zA-Z.]+)?:([0-9]{1,5})/gi;

	let res = pattern.exec(url);

	if (res && res.length == 3) {
		devInfo = {};
		// check if host in url is available (workaround for nanoleaf firmware bug)
		if (res[1]) {
			devInfo.host = res[1];
		} else {
			// host is missing, use IP address from packet header
			adapter.log.debug(
				`Host in location string '${url}' seems to be missing or invalid, use address '${
					ip
				}' from packet header instead!`,
			);
			devInfo.host = ip;
		}
		devInfo.port = res[2];
		devInfo.name = name;
	}
	return devInfo;
}

function StartPollingTimer() {
	let interval;

	// if SSE with keep alive polling enables, use keep alive polling interval instead of update polling interval
	if (SSEenabled && adapter.config.keepAlivePolling) {
		interval = keepAlivePollingInterval * 1000;
	} else {
		interval = pollingInterval;
	}

	pollingTimer = setTimeout(statusUpdate, interval, true);
	adapter.log.debug(`Polling timer started with ${interval} ms`);
}

function StopPollingTimer() {
	clearTimeout(pollingTimer);
	pollingTimer = null;
	adapter.log.debug('Polling timer stopped!');
}

function StartConnectTimer(isReconnect) {
	connectTimer = setTimeout(connect, reconnectInterval * 1000, isReconnect);
	adapter.log.debug(`Connect timer started with ${reconnectInterval * 1000} ms`);
}

function StopConnectTimer() {
	clearTimeout(connectTimer);
	connectTimer = null;
	adapter.log.debug('Connect timer stopped!');
}

function resetKeepAliveTimer() {
	clearTimeout(keepAliveTimer);
	keepAliveTimer = setTimeout(function () {
		reconnect('No ssdp:alive detected');
	}, KEEPALIVE_INTERVAL);
}

// subscribe states changes on nanoleaf device using server sent events
function startSSE() {
	auroraAPI
		.startSSE(function (data, error) {
			if (error) {
				adapter.log.error(error);
			} else {
				adapter.log.debug(`SSE data '${JSON.stringify(data)}' received!`);
				statusUpdate(false, data);
			}
		})
		.then(function () {
			adapter.log.debug('SSE subscription started, listening...');
		})
		.catch(function (error) {
			throw error;
		});
}

// close SSE connection
function stopSSE() {
	auroraAPI.stopSSE();
	adapter.log.debug('SSE connection closed!');
}

function formatError(err) {
	if (!err) {
		return 'Error: unknown';
	}

	let message = err;

	if (Number.isInteger(err)) {
		message = `HTTP status ${err}`;
		switch (err) {
			case 200:
				message += ' (OK)';
				break;
			case 204:
				message += ' (No Content)';
				break;
			case 400:
				message += ' (Bad Request)';
				break;
			case 401:
				message += ' (Unauthorized)';
				break;
			case 403:
				message += ' (Forbidden)';
				break;
			case 404:
				message += ' (Not Found)';
				break;
			case 422:
				message += ' (Unprocessable Entity)';
				break;
		}
	} else {
		if (/ECONNRESET/i.test(err.code)) {
			message += ' (Timeout)';
		}

		if (!/error/i.test(err)) {
			message = `Error: ${message}`;
		}
	}

	return message;
}

// logging of actions via API. Only bad requests or unprocessable entity (invalid data supplied) logs error, all other only in debug
function logApiError(msg, err) {
	let errormsg = `${msg}, ${formatError(err)}`;

	if (Number.isInteger(err)) {
		switch (err) {
			case 400:
				adapter.log.error(errormsg);
				break;
			case 404:
				adapter.log.warn(errormsg);
				break;
			case 422:
				adapter.log.error(errormsg);
				break;
			default:
				adapter.log.debug(errormsg);
		}
	} else {
		adapter.log.debug(errormsg);
	}
}

// Update states via polling
function statusUpdate(polling, data) {
	// polling mode
	if (polling) {
		auroraAPI
			.getInfo()
			.then(function (info) {
				StartPollingTimer(); // restart polling timer for next update

				// update states only when no SSE is used (skip updates when keep alive polling is active)
				if (!SSEenabled) {
					adapter.log.debug('Updating changed states...');
					writeStates(JSON.parse(info));
				}
			})
			.catch(function (err) {
				adapter.log.debug(`Updating states failed: ${formatError(err)}`);
				reconnect(err);
			});
	} else {
		// SSE mode
		try {
			let updateColorRGB = false;

			for (let event of data.events) {
				switch (data.eventID) {
					case AURORA_API.Events.state:
						switch (event.attr) {
							case AURORA_API.StateAttributes.on:
								writeState('state', event.value);
								break;
							case AURORA_API.StateAttributes.brightness:
								writeState('brightness', event.value);
								updateColorRGB = true;
								break;
							case AURORA_API.StateAttributes.hue:
								writeState('hue', event.value);
								updateColorRGB = true;
								break;
							case AURORA_API.StateAttributes.saturation:
								writeState('saturation', event.value);
								updateColorRGB = true;
								break;
							case AURORA_API.StateAttributes.cct:
								writeState('colorTemp', event.value);
								break;
							case AURORA_API.StateAttributes.colorMode:
								writeState('colorMode', event.value);
								break;
							default:
								adapter.log.warn(
									`Attribute '${event.attribute}' for event ID '${
										data.eventID
									}' is not implemented. Please report that to the developer!`,
								);
						}
						break;
					case AURORA_API.Events.effects:
						switch (event.attr) {
							case AURORA_API.EventAttributes.event:
								writeState('effect', event.value);
								break;
							case AURORA_API.EventAttributes.eventList:
								updateEventList(event.value);
								break;
							default:
								adapter.log.warn(
									`Attribute '${event.attribute}' for event ID '${
										data.eventID
									}' is not implemented. Please report that to the developer!`,
								);
						}
						break;
					case AURORA_API.Events.touch:
						writeState('touch.gesture', event.gesture, true);
						writeState('touch.panelID', event.panelId, true);
						break;
					default:
						adapter.log.warn(
							`Invalid eventID '${
								data.eventID
							}' received from device. Please report that to the developer!`,
						);
				}
			}
			// update colorRGB if colorMode = hs if necessary
			if (updateColorRGB) {
				// read  old state
				adapter.getStates(`${NLdevice.deviceName}.*`, function (err, states) {
					if (err) {
						adapter.log.error(
							`Error reading States from '${NLdevice.deviceName}' ${err}. No Update of 'colorRGB'!`,
						);
					} else {
						if (states[`${adapter.namespace}.${NLdevice.deviceName}.colorMode`].val == 'hs') {
							writeState(
								'colorRGB',
								HSVtoRGB(
									states[`${adapter.namespace}.${NLdevice.deviceName}.hue`].val,
									states[`${adapter.namespace}.${NLdevice.deviceName}.saturation`].val,
									states[`${adapter.namespace}.${NLdevice.deviceName}.brightness`].val,
								),
							);
						}
					}
				});
			}
		} catch (_e) {
			adapter.log.error('Invalid data received from nanoleaf controller, cannot process!');
			adapter.log.debug(`Invalid data: ${JSON.stringify(data)}`);
		}
	}
}

// write single State
function writeState(stateName, newState, forceUpdate) {
	// read  old state
	adapter.getState(`${NLdevice.deviceName}.${stateName}`, function (err, oldState) {
		if (err) {
			adapter.log.error(
				`Error reading state '${NLdevice.deviceName}.${stateName}': ${err}. State will not be updated!`,
			);
		} else {
			setChangedState(`${NLdevice.deviceName}.${stateName}`, oldState, newState, forceUpdate);
		}
	});
}

// write States
function writeStates(newStates) {
	// read all old states
	adapter.getStates('*', function (err, oldStates) {
		if (err) {
			throw `Error reading states: ${err}!`;
		} else {
			setChangedState(
				`${NLdevice.deviceName}.state`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.state`],
				newStates.state.on.value,
			);
			setChangedState(
				`${NLdevice.deviceName}.brightness`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.brightness`],
				newStates.state.brightness.value,
			);
			setChangedState(
				`${NLdevice.deviceName}.hue`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.hue`],
				newStates.state.hue.value,
			);
			setChangedState(
				`${NLdevice.deviceName}.saturation`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.saturation`],
				newStates.state.sat.value,
			);
			setChangedState(
				`${NLdevice.deviceName}.colorTemp`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.colorTemp`],
				newStates.state.ct.value,
			);
			// write RGB color only when colorMode is 'hs'
			if (newStates.state.colorMode === 'hs') {
				setChangedState(
					`${NLdevice.deviceName}.colorRGB`,
					oldStates[`${adapter.namespace}.${NLdevice.deviceName}.colorRGB`],
					HSVtoRGB(newStates.state.hue.value, newStates.state.sat.value, newStates.state.brightness.value),
				);
			}
			setChangedState(
				`${NLdevice.deviceName}.colorMode`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.colorMode`],
				newStates.state.colorMode,
			);
			setChangedState(
				`${NLdevice.deviceName}.effect`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.effect`],
				newStates.effects.select,
			);

			updateEventList(newStates.effects.effectsList);

			setChangedState(
				`${NLdevice.deviceName}.info.name`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.info.name`],
				newStates.name,
			);
			setChangedState(
				`${NLdevice.deviceName}.info.serialNo`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.info.serialNo`],
				newStates.serialNo,
			);
			setChangedState(
				`${NLdevice.deviceName}.info.firmwareVersion`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.info.firmwareVersion`],
				newStates.firmwareVersion,
			);
			setChangedState(
				`${NLdevice.deviceName}.info.model`,
				oldStates[`${adapter.namespace}.${NLdevice.deviceName}.info.model`],
				newStates.model,
			);

			// Rhythm module only available with nanoleaf Light-Panels, others have built in module and here we get no info about Rhythm
			if (typeof newStates.rhythm === 'object') {
				let oldConnectedState = oldStates[`${adapter.namespace}.Rhythm.info.connected`];
				let newConnectedState = newStates.rhythm.rhythmConnected;

				setChangedState('Rhythm.info.connected', oldConnectedState, newConnectedState);

				// current connected state is true
				if (newConnectedState) {
					// last connection state was false -> create states
					if (!oldConnectedState || (oldConnectedState && !oldConnectedState.val)) {
						adapter.log.info('Rhythm module attached!');
						CreateRhythmModuleStates();
					}
					// Update states
					setChangedState(
						'Rhythm.info.active',
						oldStates[`${adapter.namespace}.Rhythm.info.active`],
						newStates.rhythm.rhythmActive,
					);
					setChangedState(
						'Rhythm.info.hardwareVersion',
						oldStates[`${adapter.namespace}.Rhythm.info.hardwareVersion`],
						newStates.rhythm.hardwareVersion,
					);
					setChangedState(
						'Rhythm.info.firmwareVersion',
						oldStates[`${adapter.namespace}.Rhythm.info.firmwareVersion`],
						newStates.rhythm.firmwareVersion,
					);
					setChangedState(
						'Rhythm.info.auxAvailable',
						oldStates[`${adapter.namespace}.Rhythm.info.auxAvailable`],
						newStates.rhythm.auxAvailable,
					);
					setChangedState(
						'Rhythm.rhythmMode',
						oldStates[`${adapter.namespace}.Rhythm.rhythmMode`],
						newStates.rhythm.rhythmMode,
					);
				} else {
					// module is not connected anymore
					// last connection state was true -> delete states
					if (oldConnectedState && oldConnectedState.val) {
						adapter.log.info('Rhythm module detached!');
						DeleteRhythmModuleStates();
					}
				}
			}
		}
	});
}

// set changed state value
function setChangedState(stateID, oldState, newStateValue, forceUpdate = false) {
	// check oldStates
	try {
		// set state only when value changed or value is not acknowledged or state is null (never had a value)
		if (oldState == null || oldState.val != newStateValue || forceUpdate || !oldState.ack) {
			if (forceUpdate) {
				adapter.log.debug(
					`Update from OpenAPI: value for state '${stateID}' updated >>>> force update value: ${
						newStateValue
					}`,
				);
			} else {
				adapter.log.debug(
					`Update from OpenAPI: value for state '${stateID}' changed >>>> set new value: ${newStateValue}`,
				);
			}
			adapter.setState(stateID, newStateValue, true);
		}
	} catch (err) {
		let mes = `State '${stateID}' does not exist and will be ignored!`;
		adapter.log.warn(mes);
		adapter.log.debug(`${mes} ${err}`);
	}
}

// write changes event list state and states of effect state
function updateEventList(effectsArray) {
	let effectsList;
	let effectsStates = {};

	adapter.getState(`${NLdevice.deviceName}.effectsList`, function (err, oldState) {
		if (err) {
			adapter.log.error(
				// eslint-disable-next-line no-undef
				`Error reading state '${NLdevice.deviceName}.${stateName}': ${err}. State will not be updated!`,
			);
		} else {
			// loop through effectsList and write it as semicolon separated string and new states object
			for (let i = 0; i < effectsArray.length; i++) {
				if (effectsList) {
					effectsList += `;${effectsArray[i]}`;
				} else {
					effectsList = effectsArray[i];
				}
				effectsStates[effectsArray[i]] = effectsArray[i];
			}
			setChangedState(`${NLdevice.deviceName}.effectsList`, oldState, effectsList);
			// updating states of effect if changed
			adapter.getObject(`${NLdevice.deviceName}.effect`, function (err, obj) {
				if (err) {
					// eslint-disable-next-line no-undef
					adapter.log.debug(`Error getting '${effectObject}': ${err}. States will not be updated!`);
				} else {
					// only if list has changed
					if (JSON.stringify(effectsStates) !== JSON.stringify(obj.common.states)) {
						adapter.log.debug(
							`Update from OpenAPI: possible states for state 'effect' changed >>>> set new states: ${JSON.stringify(
								effectsArray,
							)}`,
						);
						obj.common.states = effectsStates;
						adapter.setObject(`${NLdevice.deviceName}.effect`, obj, function (err) {
							if (err) {
								adapter.log.debug(`Error getting '${NLdevice.deviceName}.effect` + `': ${err}`);
							}
						});
					}
				}
			});
		}
	});
}

// sends a SSDP mSearch to discover nanoleaf devices
function SSDP_mSearch(callback) {
	// clear device list
	SSDP_devices = [];

	SSDP.mSearch(MSEARCH_ST);
	// start timer for collecting SSDP responses
	SSDP_mSearchTimer = setTimeout(callback, SSDP_MSEARCH_TIMEOUT, SSDP_devices);
}

// Create nanoleaf device
function createNanoleafDevice(deviceInfo, callback) {
	let model;
	let dev;
	let rhythmAvailable;
	let rhythmConnected;

	try {
		model = deviceInfo.model;
		rhythmAvailable = typeof deviceInfo.rhythm === 'object';
		rhythmConnected = rhythmAvailable && deviceInfo.rhythm.rhythmConnected;

		// loop through known nanoleaf devices and check model
		for (dev in NANOLEAF_DEVICES) {
			if (NANOLEAF_DEVICES[dev].model == model) {
				NLdevice = NANOLEAF_DEVICES[dev];
				break;
			}
		}

		// if no model found, Canvas are fallback
		if (!NLdevice) {
			NLdevice = NANOLEAF_DEVICES.canvas;
			adapter.log.warn(
				`nanoleaf device  '${
					model
				}' unknown! Using Canvas device as fallback. Please report this to the developer!`,
			);
		}

		// enable SSE instead of polling for firmwares higher then in specification given and disable SSE when selected in admin
		if (SEMVER.gt(deviceInfo.firmwareVersion, NLdevice.SSEFirmware) && !adapter.config.disableSSE) {
			SSEenabled = true;
		} else {
			SSEenabled = false;
		}
	} catch (_e) {
		adapter.log.error(
			'Invalid device info received from nanoleaf controller. Cannot detect device. Please check device!',
		);
		adapter.log.debug(`Invalid device info: ${JSON.stringify(deviceInfo)}`);
		adapter.stop(); // stop adapter, cannot proceed here!
	}

	deleteNanoleafDevices(model); // delete all other nanoleaf device models if existing

	// if Rhythm module available -> create Rhythm device, else delete it
	if (rhythmAvailable) {
		CreateRhythmDevice(rhythmConnected);
	} else {
		DeleteRhythmDevice();
	}

	adapter.log.debug(`nanoleaf Device '${NLdevice.name}' (${model}) detected!`);

	// create the device if not exists
	adapter.getObject(NLdevice.deviceName, function (err, obj) {
		if (err) {
			throw err;
		}
		if (obj == null) {
			adapter.log.info(`New nanoleaf device '${NLdevice.name}' (${model}) detected!`);

			// Create nanoleaf Device
			adapter.setObjectNotExists(NLdevice.deviceName, {
				type: 'device',
				common: {
					name: `${NLdevice.name} Device`,
					icon: `/icons/${NLdevice.deviceName.toLocaleLowerCase()}.png`,
				},
				native: {},
			});
		}
		// create info Channel
		adapter.setObjectNotExists(`${NLdevice.deviceName}.info`, {
			type: 'channel',
			common: {
				name: `${NLdevice.name} Device Information`,
				icon: `/icons/${NLdevice.deviceName.toLocaleLowerCase()}.png`,
			},
			native: {},
		});
		// create info "firmwareVersion" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.info.firmwareVersion`, {
			type: 'state',
			common: {
				name: 'Firmware Version of nanoleaf device',
				type: 'string',
				read: true,
				write: false,
				role: 'info.version',
			},
			native: {},
		});
		// create info "model" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.info.model`, {
			type: 'state',
			common: {
				name: 'Model of nanoleaf device',
				type: 'string',
				read: true,
				write: false,
				role: 'info.model',
			},
			native: {},
		});
		// create info "name" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.info.name`, {
			type: 'state',
			common: {
				name: 'Name of nanoleaf device',
				type: 'string',
				read: true,
				write: false,
				role: 'info.name',
			},
			native: {},
		});
		// create info "serialNo" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.info.serialNo`, {
			type: 'state',
			common: {
				name: 'Serial No. of nanoleaf device',
				type: 'string',
				read: true,
				write: false,
				role: 'info.serial',
			},
			native: {},
		});
		// create "state" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.state`, {
			type: 'state',
			common: {
				name: 'Power State',
				type: 'boolean',
				def: false,
				read: true,
				write: true,
				role: 'switch.light',
				desc: 'Switch on/off',
			},
			native: {},
		});
		// create "brightness" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.brightness`, {
			type: 'state',
			common: {
				name: 'Brightness level',
				type: 'number',
				unit: '%',
				def: 100,
				min: 0,
				max: 100,
				read: true,
				write: true,
				role: 'level.dimmer',
				desc: 'Brightness level in %',
			},
			native: {},
		});
		// remove duration from brightness object (upgrade from older versions)
		adapter.getObject(`${NLdevice.deviceName}.brightness`, function (err, obj) {
			if (err) {
				throw err;
			}
			if (obj != null && typeof obj.native.duration !== 'undefined') {
				delete obj.native.duration;
				adapter.setObject(`${NLdevice.deviceName}.brightness`, obj, function (err) {
					if (err) {
						throw err;
					}
				});
			}
		});
		// create "brightness duration" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.brightness_duration`, {
			type: 'state',
			common: {
				name: 'Brightness duration',
				type: 'number',
				unit: 'sec',
				def: 0,
				min: 0,
				max: 60,
				read: true,
				write: true,
				role: 'level.interval',
				desc: 'Brightness transition duration in seconds',
			},
			native: {},
		});
		// create "hue" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.hue`, {
			type: 'state',
			common: {
				name: 'Hue value',
				type: 'number',
				unit: '°',
				def: 100,
				min: 0,
				max: 360,
				read: true,
				write: true,
				role: 'level.color.hue',
				desc: 'Hue value',
			},
			native: {},
		});
		// create "saturation" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.saturation`, {
			type: 'state',
			common: {
				name: 'Saturation value',
				type: 'number',
				unit: '%',
				def: 100,
				min: 0,
				max: 100,
				read: true,
				write: true,
				role: 'level.color.saturation',
				desc: 'Saturation value',
			},
			native: {},
		});
		// create "colorMode" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.colorMode`, {
			type: 'state',
			common: {
				name: 'Color Mode',
				type: 'string',
				read: true,
				write: false,
				role: 'value.color.mode',
				desc: 'Color Mode',
			},
			native: {},
		});
		// create "colorRGB" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.colorRGB`, {
			type: 'state',
			common: {
				name: 'RGB Color',
				type: 'string',
				read: true,
				write: true,
				role: 'level.color.rgb',
				desc: 'Color in RGB hex format (#000000 to #FFFFFF)',
			},
			native: {},
		});
		// create "colorTemp" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.colorTemp`, {
			type: 'state',
			common: {
				name: 'Color Temperature',
				type: 'number',
				unit: 'K',
				def: 4000,
				min: 1200,
				max: 6500,
				read: true,
				write: true,
				role: 'level.color.temperature',
				desc: 'Color Temperature',
			},
			native: {},
		});
		// create "effect" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.effect`, {
			type: 'state',
			common: {
				name: 'Current effect',
				type: 'string',
				read: true,
				write: true,
				role: 'text',
				states: [],
				desc: 'Current effect',
			},
			native: {},
		});
		// create "effectsList" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.effectsList`, {
			type: 'state',
			common: {
				name: 'Effects list',
				type: 'string',
				read: true,
				write: false,
				role: 'text',
				desc: 'List of available effects',
			},
			native: {},
		});
		// create "effectWrite" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.effectWrite`, {
			type: 'state',
			common: {
				name: 'Write effect',
				type: 'string',
				read: true,
				write: true,
				role: 'text',
				desc: 'Writes a user defined effect to the device',
			},
			native: {},
		});
		// create "effectWriteResponse" state
		adapter.setObjectNotExists(`${NLdevice.deviceName}.effectWriteResponse`, {
			type: 'state',
			common: {
				name: 'Response of write effect request',
				type: 'string',
				read: true,
				write: false,
				role: 'text',
				desc: 'Response of the write request for user defined effect',
			},
			native: {},
		});

		// touch event only for supported devices
		if (NLdevice.hasTouch) {
			adapter.log.debug("Touch capability available, create 'touch' event channel");
			// create "touch" Channel
			adapter.setObjectNotExists(`${NLdevice.deviceName}.touch`, {
				type: 'channel',
				common: {
					name: `${NLdevice.name} Touch event`,
				},
				native: {},
			});
			// create touch "gesture" state
			adapter.setObjectNotExists(`${NLdevice.deviceName}.touch.gesture`, {
				type: 'state',
				common: {
					name: 'Gesture of touch event',
					type: 'number',
					read: true,
					write: false,
					role: 'value',
					states: {
						0: 'Single Tap',
						1: 'Double Tap',
						2: 'Swipe Up',
						3: 'Swipe Down',
						4: 'Swipe Left',
						5: 'Swipe Right',
					},
				},
				native: {},
			});
			// create touch "panelID" state
			adapter.setObjectNotExists(`${NLdevice.deviceName}.touch.panelID`, {
				type: 'state',
				common: {
					name: 'Panel ID of touch event',
					type: 'number',
					read: true,
					write: false,
					role: 'value',
				},
				native: {},
			});
		} else {
			adapter.getObject(`${NLdevice.deviceName}.touch`, function (err, obj) {
				if (err) {
					throw err;
				}
				// if existent, delete it
				if (obj != null) {
					adapter.log.debug("No touch capability, delete 'touch' event channel");
					adapter.deleteChannel(NLdevice.deviceName, 'touch');
				}
			});
		}
		// create "identify" state
		adapter.setObjectNotExists(
			`${NLdevice.deviceName}.identify`,
			{
				type: 'state',
				common: {
					name: 'Identify panels',
					type: 'boolean',
					read: false,
					write: true,
					role: 'button',
					desc: 'Causes the panels to flash in unison',
				},
				native: {},
			},
			// last state to be created, after this start adapter processing with callback function
			function () {
				callback(deviceInfo);
			},
		);
	});
}

// delete all nanoleaf devices
//		Parameter 'ignoreModel': ignore deletion of this device model
function deleteNanoleafDevices(ignoreModel) {
	let device;

	// loop through all known devices and delete if not ignored
	for (device in NANOLEAF_DEVICES) {
		// delete device if not ignored
		if (ignoreModel !== NANOLEAF_DEVICES[device].model) {
			// check if device is still existing
			adapter.getObject(NANOLEAF_DEVICES[device].deviceName, function (err, obj) {
				if (err) {
					throw err;
				}
				// delete it
				if (obj != null) {
					let devicename = obj._id.substring(obj._id.lastIndexOf('.') + 1);

					adapter.log.debug(`Delete '${devicename}' device...`);
					// first, delete all states
					adapter.getStates(`${devicename}.*`, function (err, states) {
						for (let id in states) {
							adapter.delObject(id);
						}
					});
					// second, delete all channels
					adapter.getChannelsOf(devicename, function (err, channels) {
						for (let i in channels) {
							adapter.deleteChannel(devicename, channels[i]._id);
						}
					});
					// last, delete device
					adapter.deleteDevice(devicename);
				}
			});
		}
	}
}

// Creates Rhythm Device
function CreateRhythmDevice(connected) {
	// check if Rhythm Device already exists
	adapter.getObject('Rhythm', function (err, obj) {
		if (err) {
			throw err;
		}
		// if not existent, create it
		if (obj == null) {
			adapter.log.debug('Rhythm module information available. Creating Rhythm device...');

			// create Rhythm Device
			adapter.setObjectNotExists('Rhythm', {
				type: 'device',
				common: {
					name: 'Light Panels Rhythm Module Device',
					icon: '/icons/rhythm.png',
				},
				native: {},
			});
		}
		// create Rhythm Channel
		adapter.setObjectNotExists('Rhythm.info', {
			type: 'channel',
			common: {
				name: 'Light Panels Rhythm Module Device Information',
				icon: '/icons/rhythm.png',
			},
			native: {},
		});
		// create "connected" state
		adapter.setObjectNotExists('Rhythm.info.connected', {
			type: 'state',
			common: {
				name: 'Rhythm module connected to nanoleaf light panels',
				type: 'boolean',
				read: true,
				write: false,
				role: 'indicator.connected',
			},
			native: {},
		});
		adapter.delObject('Rhythm.info.rhythmMode'); // state moved outside info channel (clean up for older versions)

		// create rhythm module states if connected, else delete these
		if (connected) {
			CreateRhythmModuleStates();
		}
	});
}

// Deletes Rhythm device
function DeleteRhythmDevice() {
	// check if Rhythm Device exists
	adapter.getObject('Rhythm', function (err, obj) {
		if (err) {
			throw err;
		}
		// if existent, delete it
		if (obj != null) {
			adapter.log.debug('Rhythm module is not available. Delete Rhythm device...');

			adapter.deleteDevice('Rhythm');
		}
	});
}

// Creates Rhythm module states
function CreateRhythmModuleStates() {
	// create "active" state
	adapter.setObjectNotExists('Rhythm.info.active', {
		type: 'state',
		common: {
			name: 'Rhythm module active',
			type: 'boolean',
			read: true,
			write: false,
			role: 'indicator',
		},
		native: {},
	});
	// create "auxAvailable" state
	adapter.setObjectNotExists('Rhythm.info.auxAvailable', {
		type: 'state',
		common: {
			name: 'AUX of rhythm module available',
			type: 'boolean',
			read: true,
			write: false,
			role: 'indicator',
		},
		native: {},
	});
	// create "firmwareVersion" state
	adapter.setObjectNotExists('Rhythm.info.firmwareVersion', {
		type: 'state',
		common: {
			name: 'Firmware Version of rhythm module',
			type: 'string',
			read: true,
			write: false,
			role: 'info.version',
		},
		native: {},
	});
	// create "hardwareVersion" state
	adapter.setObjectNotExists('Rhythm.info.hardwareVersion', {
		type: 'state',
		common: {
			name: 'Hardware Version of rhythm module',
			type: 'string',
			read: true,
			write: false,
			role: 'info.version.hw',
		},
		native: {},
	});
	// create "rhythmMode" state
	adapter.setObjectNotExists('Rhythm.rhythmMode', {
		type: 'state',
		common: {
			name: 'Mode of rhythm module',
			type: 'number',
			read: true,
			write: true,
			role: 'state',
			states: {
				0: 'Microphone',
				1: 'Aux Cable',
			},
		},
		native: {},
	});
}

// Deletes Rhythm module states
function DeleteRhythmModuleStates() {
	adapter.log.debug('Delete Rhythm module states...');
	adapter.delObject('Rhythm.info.active');
	adapter.delObject('Rhythm.info.auxAvailable');
	adapter.delObject('Rhythm.info.firmwareVersion');
	adapter.delObject('Rhythm.info.hardwareVersion');
	adapter.delObject('Rhythm.rhythmMode');
}

function startAdapterProcessing(deviceInfo) {
	// first states updates
	writeStates(deviceInfo);
	// subscribe state changes of nanoleaf device
	adapter.subscribeStates(`${NLdevice.deviceName}.*`);
	// subscribe rhythmMode when Light Panels device
	if (deviceInfo.model == NANOLEAF_DEVICES.lightpanels.model) {
		adapter.subscribeStates('Rhythm.rhythmMode');
	}

	// if SSE enabled start SSE and bind SSDP notify events for keep alive
	if (SSEenabled) {
		startSSE();

		// Keep alive with polling when enabled
		if (adapter.config.keepAlivePolling) {
			StartPollingTimer(); // start polling timer for updates
		} else {
			// keep alive with SSDP notify
			// handle SSDP Notify messages
			SSDP.on(`DeviceAvailable:${NLdevice.SSDP_NT_ST}`, SSDP_notify);
			// handle device becomes unavailable
			SSDP.on(`DeviceUnavailable:${NLdevice.SSDP_NT_ST}`, SSDP_goodbye);

			adapter.log.debug('SSDP notify events initialized!');

			resetKeepAliveTimer();
		}
	} else {
		// else use polling
		StartPollingTimer();
	} // start polling timer for updates
}

function stopAdapterProcessing() {
	// stop processing commands by clearing queue
	clearCommandQueue();
	// if SSE enabled stop SSE and unbind SSDP events
	if (SSEenabled) {
		stopSSE();

		// stop keep alive polling when enabled
		if (adapter.config.keepAlivePolling) {
			StopPollingTimer();
		} else {
			// remove SSDP events only if no polling is active
			// remove SSDP notify events
			SSDP.removeAllListeners(`DeviceAvailable:${NLdevice.SSDP_NT_ST}`, SSDP_notify);
			SSDP.removeAllListeners(`DeviceUnavailable:${NLdevice.SSDP_NT_ST}`, SSDP_goodbye);
			adapter.log.debug('SSDP notify events disabled!');
		}
	} else {
		// else stop polling
		StopPollingTimer();
	}

	adapter.unsubscribeStates(`${NLdevice.deviceName}.*`); // unsubscribe state changes
	adapter.unsubscribeStates('Rhythm.rhythmMode');
}

// connection loss detected, stop adapter processing and start reconnect
function reconnect(err) {
	adapter.log.warn(
		`Connection to '${auroraAPI.host}:${auroraAPI.port}' lost, ${formatError(err)}. Try to reconnect...`,
	);
	stopAdapterProcessing();
	setConnectedState(false); // set disconnect state
	lastError = err;
	StartConnectTimer(true); // start connect timer
}

function setConnectedState(connected) {
	adapter.setState('info.connection', connected, true);
	isConnected = connected;
}

function connect(isReconnect) {
	// establish connection through sending info-request
	auroraAPI
		.getInfo()
		.then(function (info) {
			StopConnectTimer();
			setConnectedState(true); // set connection state to true
			adapter.log.info(`${isReconnect ? 'Reconnected' : 'Connected'} to '${auroraAPI.host}:${auroraAPI.port}'`);

			let deviceInfo = JSON.parse(info);

			// create nanoleaf device and start adapter processing with callback
			createNanoleafDevice(deviceInfo, startAdapterProcessing);
		})
		.catch(function (err) {
			let message = `Connection to '${auroraAPI.host}:${auroraAPI.port}' failed with ${formatError(err)}. `;
			let messageDetail = 'Please check hostname/IP, device and connection!';

			// is HTTP error
			if (Number.isInteger(err)) {
				// special message for 401 and 403
				if (err == 401 || err == 403) {
					messageDetail = 'Permission denied, please check authorization token!';
					adapter.log.error(message + messageDetail);
				} else {
					adapter.log.error(`${message + messageDetail} Stopping...`);
					adapter.stop();
				}
			} else {
				// other error, try to reconnect
				// log only if error changed or not timeout for reconnect attempt
				if (
					(lastError === undefined || err.code != lastError.code) &&
					!(isReconnect && err.code == 'ETIMEDOUT')
				) {
					adapter.log.error(
						`${message + messageDetail}Retry in ${adapter.config.reconnectInterval}s intervals...`,
					);
					lastError = err;
				} else {
					adapter.log.debug(message);
				}

				StartConnectTimer(isReconnect); // start reconnect timer
			}
		});
}

function SSDP_notify(data) {
	adapter.log.debug(`ssdp:alive NOTIFY received: ${JSON.stringify(data)}`);

	// only if connected
	if (isConnected) {
		// check UUID if set
		if (NL_UUID) {
			if (NL_UUID == data.usn) {
				adapter.log.debug(`${data.usn} matched nanoleaf device UUID! Keep alive...`);
				resetKeepAliveTimer(); // if match, keep alive
			}
		} else {
			// if not set check device and set UUID
			let dev = getDevice(data.location, data.address);

			// check device
			if (dev) {
				// if adapter host is IP, directly check if match
				if (NET.isIPv4(adapter.config.host)) {
					if (dev.host == adapter.config.host) {
						NL_UUID = data.usn;
						adapter.log.debug(`nanoleaf ${NL_UUID} from device '${dev.host}' set!`);
						resetKeepAliveTimer();
					}
				} else {
					// resolve hostname and then match
					DNS.lookup(adapter.config.host, function (err, address) {
						if (err) {
							adapter.log.error(
								`Error while looking up DNS '${adapter.config.host}'. Error: ${err.code} (${
									err.message
								}).`,
							);
						} else if (dev.host == address) {
							NL_UUID = data.usn;
							adapter.log.debug(
								`nanoleaf ${NL_UUID} from device '${adapter.config.host}' (${dev.host}) set!`,
							);
							resetKeepAliveTimer();
						}
					});
				}
			} else {
				adapter.log.debug(`Invalid location '${data.location}' received from device.`);
			}
		}
	}
}

function SSDP_goodbye(data) {
	// only if connected
	if (isConnected) {
		adapter.log.debug(`ssdp:byebye NOTIFY received: ${JSON.stringify(data)}`);
		reconnect('ssdp:byebye from device received');
	}
}

function SSDP_msearch_result(data) {
	let dev;

	// only when timer for collecting devices is running
	if (SSDP_mSearchTimer) {
		// loop through all known nanoleaf devices
		for (dev in NANOLEAF_DEVICES) {
			// if matching ST found, add it to found devices
			if (NANOLEAF_DEVICES[dev].SSDP_NT_ST == data.st) {
				let devInfo;

				adapter.log.debug(
					`SSDP M-Search found device with USN: ${data.usn} and OpenAPI location: ${data.location}`,
				);

				// get device info
				devInfo = getDevice(
					data.location,
					data.address,
					data['nl-devicename'] ? data['nl-devicename'] : 'Nanoleaf device',
				);

				if (devInfo) {
					SSDP_devices.push(devInfo);
				}

				break;
			}
		}
	}
}

// init SSDP for nanoleaf (event binding)
function initSSDP() {
	SSDP = SSDPUPNP.start(adapter.config.adapterAddress);
	// handle MSEARCH responses
	SSDP.on('DeviceFound', SSDP_msearch_result);

	adapter.log.debug("SSDP 'DeviceFound' event initialized!");
}

function init() {
	try {
		// initialize timer intervals (override when interval is to small)
		if (adapter.config.pollingInterval < MIN_POLLING_INTERVAL) {
			pollingInterval = MIN_POLLING_INTERVAL;
		} else {
			pollingInterval = adapter.config.pollingInterval;
		}
		if (adapter.config.reconnectInterval < MIN_RECONNECT_INTERVAL) {
			reconnectInterval = MIN_RECONNECT_INTERVAL;
		} else {
			reconnectInterval = adapter.config.reconnectInterval;
		}
		if (adapter.config.keepAlivePollingInterval < MIN_KEEPALIVE_POLLING_INTERVAL) {
			keepAlivePollingInterval = MIN_KEEPALIVE_POLLING_INTERVAL;
		} else {
			keepAlivePollingInterval = adapter.config.keepAlivePollingInterval;
		}

		initSSDP(); // fist initialize SSDP for MSEARCH events

		// check mandatory settings
		if (!adapter.config.host || !adapter.config.port || !adapter.config.authtoken) {
			throw 'Please check adapter config (host, port, authorization token) first!';
		}

		// initialize Aurora API
		auroraAPI = new AURORA_API({
			host: adapter.config.host,
			base: '/api/v1/',
			port: adapter.config.port,
			accessToken: adapter.config.authtoken,
			timeout: DEFAULT_TIMEOUT,
		});

		// continue initialization with connecting
		adapter.log.info(`Connecting to '${auroraAPI.host}:${auroraAPI.port}'...`);
		connect(false);
	} catch (err) {
		adapter.log.error(err);
	}
}

function main() {
	setConnectedState(false); // connection state false
	init(); // connect to nanoleaf controller and test connection
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
	module.exports = startAdapter;
} else {
	startAdapter(); // or start the instance directly
}
