/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';
const http = require('http');
const AuroraApi = require('nanoleaf-aurora-client');

// you have to require the utils module and call adapter function
var utils = require(__dirname + '/lib/utils'); // Get common adapter utils

const effectObjName = "LightPanels.effect";
const defaultTimeout = 10000;

var auroraAPI;	// Instance of auroraAPI-Client
// Timers
var pollingTimer;
var connectTimer;

// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.nanoleaf-lightpanels.0
var adapter = new utils.Adapter('nanoleaf-lightpanels');

// is called when adapter shuts down - callback has to be called under any circumstances!
adapter.on("unload", function (callback) {
	try {
		adapter.log.info("Shutting down Nanoleaf adapter \"" + adapter.namespace + "\"...");
		StopPollingTimer();
		StopConnectTimer();
		callback();
	}
	catch (e) {
		callback();
	}
});

// Some message was sent to adapter instance
adapter.on("message", function (obj) {
	adapter.log.debug("Incoming adapter message: " + obj.command);

	switch (obj.command) {
		case "getAuthToken":	getAuthToken(obj.message.host, obj.message.port, function (success, message) {
									var messageObj = new Object();
									messageObj.success = success;

									if (success) {
										messageObj.message = "SuccessGetAuthToken";
										messageObj.authToken = message;
									}
									else messageObj.message = message;

									if (obj.callback) adapter.sendTo(obj.from, obj.command, messageObj, obj.callback);
								});
								break;
		default:				adapter.log.debug("Invalid adapter message send: " + obj);
	}
});

// is called if a subscribed state changes
adapter.on("stateChange", function (id, state) {
	if (state)
		adapter.log.debug("State change " + ((state.ack) ? "status" : "command") + ": id: " + id + ": " + JSON.stringify(state));

	// acknowledge false for command
	if (state && !state.ack) {

		var stateID = id.split(".");
		// get Statename
		var stateName = stateID.pop();
		// get Devicename
		var DeviceName = stateID.pop();

		if (DeviceName == "LightPanels") {
			switch (stateName) {
				// Power On/Off
				case "state":		if (state.val)
										auroraAPI.turnOn()
											.then(function() {
												adapter.log.debug("OpenAPI: Device turned on");
											})
											.catch(function(err) {
												adapter.log.debug("OpenAPI: Error turning on light panels, " + formatError(err));
											});
									else
										auroraAPI.turnOff()
											.then(function() {
												adapter.log.debug("OpenAPI: Device turned off");
											})
											.catch(function(err) {
												adapter.log.debug("OpenAPI: Error turning off light panels, " + formatError(err));
											});
									break;
				// Brithness
				case "brightness":	auroraAPI.setBrightness(parseInt(state.val)) // parseInt to fix vis colorPicker
										.then(function() {
											adapter.log.debug("OpenAPI: Brightness set to " + state.val);
										})
										.catch(function(err) {
											adapter.log.debug("OpenAPI: Error while setting brightness value " + state.val + ", " + formatError(err));
										});
									break;
				// Hue
				case "hue":			auroraAPI.setHue(parseInt(state.val)) // parseInt to fix vis colorPicker
										.then(function() {
											adapter.log.debug("OpenAPI: Hue set to " + state.val);
										})
										.catch(function(err) {
											adapter.log.debug("OpenAPI: Error while setting hue value " + state.val + ", " + formatError(err));
										});
									break;
				// Saturation
				case "saturation":	auroraAPI.setSat(parseInt(state.val)) // parseInt to fix vis colorPicker
										.then(function() {
											adapter.log.debug("OpenAPI: Saturation set to " + state.val);
										})
										.catch(function(err) {
											adapter.log.debug("OpenAPI: Error while setting saturation value " + state.val + ", " + formatError(err));
										});
									break;
				// Color Temeperature
				case "colorTemp":	auroraAPI.setColourTemperature(state.val)
										.then(function() {
											adapter.log.debug("OpenAPI: Color temperature set to " + state.val);
										})
										.catch(function(err) {
											adapter.log.debug("OpenAPI: Error while setting color temeperature " + state.val + ", " + formatError(err));
										});
									break;
				// RGB Color
				case "colorRGB":	var rgb = RGBHEXtoRGBDEC(state.val);
									if (rgb) {
										auroraAPI.setRGB(rgb.R, rgb.G, rgb.B)
											.then(function() {
												adapter.log.debug("OpenAPI: RGB color set to " + state.val + " (" + rgb.R + "," + rgb.G + "," + rgb.B + ")");
											})
											.catch(function(err) {
												adapter.log.debug("OpenAPI: Error while setting RGB color R=" + rgb.R + ", G=" + rgb.G + ", B=" + rgb.B + " " + formatError(err));
											});
									}
									else
										adapter.log.debug("OpenAPI: set RGB color: Supplied RGB hex string \"" + state.val + "\" is invalid!");
									break;
				// Current effect
				case "effect":		auroraAPI.setEffect(state.val)
										.then(function() {
											adapter.log.debug("OpenAPI: Effect set to \"" + state.val + "\"");
										})
										.catch(function(err) {
											adapter.log.debug("OpenAPI: Error while setting effect \"" + state.val + "\", " + formatError(err));
										});
									break;
				// Indentify
				case "identify":	auroraAPI.identify()
										.then(function() {
											adapter.log.debug("OpenAPI: Identify panels enabled!");
										})
										.catch(function(err) {
											adapter.log.debug("OpenAPI: Error while triggering identification, " + formatError(err));
										});
									break;
			}
		}
	}
});

// start here!
adapter.on("ready", function () {
	adapter.log.info("Nanoleaf adapter \"" + adapter.namespace + "\" started.");
	main();
});

// convert HSV color to RGB color
function HSVtoRGB(hue, saturation, value) {
	var h, i, f, s, v, p, q, t, r, g, b;
	
	s = saturation / 100;
	v = value / 100;
	
	if (s == 0) // achromatisch (Grau)
		r = g = b = v;
	else {
		h = hue / 60;
		i = Math.floor(h);
		f = h - i;
		p = v * (1 - s);
		q = v * (1 - s * f);
		t = v * (1 - s * (1 - f));

		switch (i) {
			case 0:  r = v; g = t; b = p; break;
			case 1:  r = q; g = v; b = p; break;
			case 2:  r = p; g = v; b = t; break;
			case 3:  r = p; g = q; b = v; break;
			case 4:  r = t; g = p; b = v; break;
			default: r = v; g = p; b = q; break;
		}
	}

	// convert to hex
	return "#" + ("0" + (Math.round(r * 255)).toString(16)).slice(-2) +
				 ("0" + (Math.round(g * 255)).toString(16)).slice(-2) +
				 ("0" + (Math.round(b * 255)).toString(16)).slice(-2)
}

// convert RGB hex string to decimal RGB components object
function RGBHEXtoRGBDEC(RGBHEX) {
	var r, g, b;
	var patt = new RegExp("^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$", "i");
	var RGBDEC = new Object();
	var res;
		
	if (res = patt.exec(RGBHEX.trim())) {
		RGBDEC.R =  parseInt(res[1], 16);
		RGBDEC.G =  parseInt(res[2], 16);
		RGBDEC.B =  parseInt(res[3], 16);
		
		return RGBDEC;
	}
	else
		return null;
}

function StartPollingTimer() {
	adapter.log.debug("Polling timer startet with " + adapter.config.pollingInterval + " ms");
	pollingTimer = setTimeout(statusUpdate, adapter.config.pollingInterval);
}

function StopPollingTimer() {
	adapter.log.debug("Polling timer stopped!");
	clearTimeout(pollingTimer);
	pollingTimer = null;
}

function StartConnectTimer(isReconnect) {
	adapter.log.debug("Connect timer startet with " + adapter.config.reconnectInterval * 1000 + " ms");
	connectTimer = setTimeout(connect, adapter.config.reconnectInterval * 1000, isReconnect);
}

function StopConnectTimer() {
	adapter.log.debug("Connect timer stopped!");
	clearTimeout(connectTimer);
	connectTimer = null;
}

function formatError(err) {
	if (!err) return "Error: unknown";
	
	var message = err;
		
	if (Number.isInteger(err)) {
		message = "HTTP status " + err;
		switch (err) {
			case 200: message += " (OK)"; break;
			case 204: message += " (No Content)"; break;
			case 400: message += " (Bad Request)"; break;
			case 401: message += " (Unauthorized)"; break;
			case 403: message += " (Forbidden)"; break;
			case 404: message += " (Not Found)"; break;
			case 422: message += " (Unprocessable Entity)"; break;
		}
	}
	else {
		if (/ECONNRESET/i.test(err.code))
		message += " (Timeout)";
		
		if (!/error/i.test(err))
			message = "Error: " + message
	}
	
	return message;
}


// Update states via polling
function statusUpdate() {
	adapter.log.debug("Updating states...");
	auroraAPI.getInfo()
		.then(function(info) {
			StartPollingTimer();
			// update States
			writeStates(JSON.parse(info));
		})
		.catch(function(err) {
			adapter.log.debug("Update states failed: " + formatError(err));
			StopPollingTimer();
			adapter.unsubscribeStates("*");								// unsubscribe state changes
			adapter.setState("info.connection", false, true);			// set disconnect state
			adapter.log.warn("Connection to \"" + auroraAPI.host + ":" + auroraAPI.port + "\" lost, " + formatError(err) + ". Try to reconnect...");
			StartConnectTimer(true);									// start connect timer
		});
}

// write States
function writeStates(newStates) {
	adapter.log.debug("Writing new states...");
	// read all old states
	adapter.getStates("*", function (err, oldStates) {		
		if (err) {
			adapter.log.error("Error reading states: " + err + ". Update polling stopped!");
			StopPollingTimer();		// stop polling because something is wrong
		}
		else {
			setChangedState({"LightPanels.state": 				oldStates[adapter.namespace + ".LightPanels.state"]}				, newStates.state.on.value);
			setChangedState({"LightPanels.brightness": 			oldStates[adapter.namespace + ".LightPanels.brightness"]}			, newStates.state.brightness.value);
			setChangedState({"LightPanels.hue":					oldStates[adapter.namespace + ".LightPanels.hue"]}					, newStates.state.hue.value);
			setChangedState({"LightPanels.saturation": 			oldStates[adapter.namespace + ".LightPanels.saturation"]}			, newStates.state.sat.value);
			setChangedState({"LightPanels.colorTemp":			oldStates[adapter.namespace + ".LightPanels.colorTemp"]}			, newStates.state.ct.value);
			// write RGB color only when colorMode is 'hs'
			if (newStates.state.colorMode == "hs")
				setChangedState({"LightPanels.colorRGB":		oldStates[adapter.namespace + ".LightPanels.colorRGB"]}				, HSVtoRGB(newStates.state.hue.value, newStates.state.sat.value, newStates.state.brightness.value));
			setChangedState({"LightPanels.colorMode":			oldStates[adapter.namespace + ".LightPanels.colorMode"]}			, newStates.state.colorMode);
			setChangedState({"LightPanels.effect":				oldStates[adapter.namespace + ".LightPanels.effect"]}				, newStates.effects.select);
			var effectsArray = newStates.effects.effectsList;
			var effectsList;
			var effectsStates = new Object();
			// loop through effectsList and write it as semicolon separated string and new states object
			for (var i = 0; i < effectsArray.length; i++) {
				if (effectsList)
					effectsList += ";" + effectsArray[i];
				else
					effectsList = effectsArray[i];
				effectsStates[effectsArray[i]] = effectsArray[i];
			}
			setChangedState({"LightPanels.effectsList": 		oldStates[adapter.namespace + ".LightPanels.effectsList"]}			, effectsList);
			// updating states of effect if changed
			adapter.getObject(effectObjName, function (err, obj) {
				if (err) adapter.log.debug("Error getting \"" + effectObject + "\": " + err);
				else {
					// only if list has changed
					if (JSON.stringify(effectsStates) != JSON.stringify(obj.common.states)) {
						adapter.log.debug("Update from OpenAPI: possible states for state \"effect\" changed >>>> set new states: " + JSON.stringify(effectsArray));
						obj.common.states = effectsStates;
						adapter.setObject(effectObjName, obj, function (err) {
							if (err) adapter.log.debug("Error getting \"" + effectObjName + "\": " + err)
						});
					}
				}
			});
			
			setChangedState({"LightPanels.info.name":			oldStates[adapter.namespace + ".LightPanels.info.name"]}			, newStates.name);
			setChangedState({"LightPanels.info.serialNo":		oldStates[adapter.namespace + ".LightPanels.info.serialNo"]}		, newStates.serialNo);
			setChangedState({"LightPanels.info.firmwareVersion":oldStates[adapter.namespace + ".LightPanels.info.firmwareVersion"]}	, newStates.firmwareVersion);
			setChangedState({"LightPanels.info.model":			oldStates[adapter.namespace + ".LightPanels.info.model"]}			, newStates.model);
			
			setChangedState({"Rhythm.info.connected":			oldStates[adapter.namespace + ".Rhythm.info.connected"]}			, newStates.rhythm.rhythmConnected);
			setChangedState({"Rhythm.info.active":				oldStates[adapter.namespace + ".Rhythm.info.active"]}				, newStates.rhythm.rhythmActive);
			setChangedState({"Rhythm.info.hardwareVersion":		oldStates[adapter.namespace + ".Rhythm.info.hardwareVersion"]}		, newStates.rhythm.hardwareVersion);
			setChangedState({"Rhythm.info.firmwareVersion":		oldStates[adapter.namespace + ".Rhythm.info.firmwareVersion"]}		, newStates.rhythm.firmwareVersion);
			setChangedState({"Rhythm.info.auxAvailable":		oldStates[adapter.namespace + ".Rhythm.info.auxAvailable"]}			, newStates.rhythm.auxAvailable	);
			setChangedState({"Rhythm.info.rhythmMode":			oldStates[adapter.namespace + ".Rhythm.info.rhythmMode"]}			, newStates.rhythm.rhythmMode);
		}
	});
}

// set changed state value
function setChangedState(oldState, newStateValue) {
	// check oldStates
	try {
		var stateID = Object.keys(oldState)[0];
		// set state only when value changed or value is not acknowledged or state is null (never had a value)
		if (oldState[stateID] == null || oldState[stateID].val != newStateValue || !oldState[stateID].ack) {
			adapter.log.debug("Update from OpenAPI: value for state \"" + stateID + "\" changed >>>> set new value: " + newStateValue);
			adapter.setState(stateID, newStateValue, true);
		}
	}
	catch (err) {
		var mes = "State \"" + stateID + "\" does not exist and will be ignored!";
		adapter.log.warn(mes);
		adapter.log.debug(mes + " " + err);
	}
}

// automatically obtain an auth token when device is in pairing mode
function getAuthToken(address, port, callback) {
	adapter.log.info("Try to obtain authorization token from \"" + address + ":" + port + "\" (device has to be in pairing mode!)");
	
	const options = {
		hostname: address,
		port: port,
		path: "/api/v1/new",
		method: "POST",
		timeout: defaultTimeout
	};
	
	const req = http.request(options, (res) => {
		const statusCode = res.statusCode;
		const contentType = res.headers['content-type'];

		adapter.log.debug(formatError(statusCode));

		switch (statusCode) {
			case 200:	if (!/^application\/json/.test(contentType)) {
							adapter.log.debug("Invalid content-type. Expected \"application/json\" but received " + contentType);
							adapter.log.error("Error obtaining authorization token!");
							if (callback) callback(false, "ErrorJSON");
							return;
						}
						break;
			case 401:	adapter.log.error("Getting authorization token failed because access is unauthorized (is the device in pairing mode?)");
						if (callback) callback(false, "ErrorUnauthorized");
						return;
			case 403:	adapter.log.error("Getting authorization token failed because permission denied (is the device in pairing mode?)");
						if (callback) callback(false, "ErrorUnauthorized");
						return;
			default:	adapter.log.error("Connection to \"" + address + ":" + port +  "\" failed: " + formatError(statusCode));
						if (callback) callback(false, "ErrorConnection");
						return;
		}
		
		var rawData = "";
		res.on("data", (chunk) => { rawData += chunk; });
		res.on("end", () => {
			try {
				const parsedData = JSON.parse(rawData);
				if (parsedData["auth_token"]) {
					adapter.log.info("Got new Authentification Token: \"" + parsedData["auth_token"] + "\"");
					if (callback) callback(true, parsedData["auth_token"]);
				}
				else {
					adapter.log.debug("JOSN response does not contain an \"auth_token\"");
					adapter.log.error("No authorization token found!");
					if (callback) callback(false, "NoAuthTokenFound");
				}
			}
			catch (err) {
				adapter.log.debug("Error JOSN parsing received data: " + formatError(err));
				adapter.log.error("No authorization token found!");
				if (callback) callback(false, "NoAuthTokenFound");
			}
		});
	});
	
	req.on("error", (err) => {
		adapter.log.error("Connection to \"" + address + ":" + port + "\" failed, " + formatError(err));
		if (callback) callback(false, "ErrorConnection");
	});
			
	req.end();
}

function connect(isReconnect) {
	// establish connection through sending info-request
	auroraAPI.getInfo()
		.then(function(info) {
			StopConnectTimer();
			// set connection state to true
			adapter.setState("info.connection", true, true);
			adapter.log.info(((isReconnect) ? "Reconnected" : "Connected") + " to \"" + auroraAPI.host + ":" + auroraAPI.port);
			// Update stated directly from reply
			writeStates(JSON.parse(info));
			// all states changes inside the adapters namespace are subscribed
			adapter.subscribeStates("*");
			// Start Status update polling
			StartPollingTimer();
		})
		.catch(function(err) {
			// is HTTP error?
			if (Number.isInteger(err) && (err < 200 || err > 299)) {
				// special error message and no further connection attemps
				var addMessage = "";
				if (err == 401) addMessage = "Permission denied, please check authorization token!";
				else addMessage = "Please check hostname/IP and device!";
				adapter.log.error("Connection to \"" + auroraAPI.host + ":" + auroraAPI.port + "\" failed, " + formatError(err) + ". " + addMessage);
			}
			// everything else
			else {
				// log only if timer not running
				if (!connectTimer)
					adapter.log.error("Connection to \"" + auroraAPI.host + ":" + auroraAPI.port + "\" failed, " + formatError(err) + ". Retry in " + adapter.config.reconnectInterval + "s intervals...");
				StartConnectTimer(isReconnect);		// start reconnect timer
			}
	});
}


function init() {
	try {
		auroraAPI = new AuroraApi({
			host: adapter.config.host,
			base: "/api/v1/",
			port: adapter.config.port,
			accessToken: adapter.config.authtoken,
			timeout: defaultTimeout
		});
		
		// continue initialization with connecting
		adapter.log.info("Connecting to \"" + auroraAPI.host + ":" + auroraAPI.port + "\"...");
		connect();
	}
	catch(err) {
		adapter.log.error(err);
	}

}

function main() {
	// connection state false
	adapter.setState("info.connection", false, true);
	// connect to nanoleaf controller and test connection
	init();
}
