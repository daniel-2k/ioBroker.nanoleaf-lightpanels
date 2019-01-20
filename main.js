/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

// you have to require the utils module and call adapter function
var utils = require(__dirname + '/lib/utils'); // Get common adapter utils

// adapter will be restarted automatically every time as the configuration changed, e.g system.adapter.nanoleaf-lightpanels.0
var adapter = new utils.Adapter("nanoleaf-lightpanels");

// constants
const http = require("http");
const AuroraApi = require("nanoleaf-aurora-client");
const minPollingInterval = 500;			// milliseconds
const minReconnectInterval = 10;		// seconds
const defaultTimeout = 10000;

// nanoleaf device definitions
const nanoleafDevices = {lightpanels: {model: "NL22", deviceName: "LightPanels", name: "Light Panels"}, canvas: {model: "NL29", deviceName: "Canvas", name: "Canvas" }};

// variables
var auroraAPI;							// Instance of auroraAPI-Client
var lastError;							// keeps the last error occurred
var commandQueue = [];					// Array for all state changes (commands) to process (Queue)
var commandQueueProcessing = false;		// flag to show that command queue processing is in progress
var NLdevice;							// holds the nanoleaf device id which will be processed

// Timers
var pollingTimer;
var connectTimer;

var pollingInterval;
var reconnectInterval;

// start here!
adapter.on("ready", function () {
	adapter.log.info("Nanoleaf adapter \"" + adapter.namespace + "\" started.");
	main();
});

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

		if (DeviceName == NLdevice) {
			commandQueue.push({stateName, state});
			adapter.log.debug("Command \"" + stateName + "\" with value \"" + state.val + "\" added to queue! Queue length: " + commandQueue.length);

			// start processing commands when not in progress
			if (!commandQueueProcessing) {
				adapter.log.debug("Start processing commands...");
				processCommandQueue();
			}
		}
	}
});

// process command queue
function processCommandQueue() {
	var nextCommand = commandQueue.shift();

	if (!nextCommand) {
		commandQueueProcessing = false;
		adapter.log.debug("No further commands in queue. Processing finished.");
		return;
	}
	var stateName = nextCommand.stateName;
	var state = nextCommand.state;
	commandQueueProcessing = true;

	adapter.log.debug("Process new command \"" + stateName + "\" with value \"" + state.val + "\" from queue. Commands remaining: " + commandQueue.length);

	switch (stateName) {
		// Power On/Off
		case "state":		if (state.val)
								auroraAPI.turnOn()
									.then(function() {
										adapter.log.debug("OpenAPI: Device turned on");
									})
									.catch(function(err) {
										logApiError("OpenAPI: Error turning on light panels", err);
									})
									.then(function() {
										processCommandQueue();
									});
							else
								auroraAPI.turnOff()
									.then(function() {
										adapter.log.debug("OpenAPI: Device turned off");
									})
									.catch(function(err) {
										logApiError("OpenAPI: Error turning off light panels", err);
									})
									.then(function() {
										processCommandQueue();
									});
							break;
		// Brithness
		case "brightness":	auroraAPI.setBrightness(parseInt(state.val)) // parseInt to fix vis colorPicker
								.then(function() {
									adapter.log.debug("OpenAPI: Brightness set to " + state.val);
								})
								.catch(function(err) {
									logApiError("OpenAPI: Error while setting brightness value " + state.val, err);
								})
								.then(function() {
									processCommandQueue();
								});
							break;
		// Hue
		case "hue":			auroraAPI.setHue(parseInt(state.val)) // parseInt to fix vis colorPicker
								.then(function() {
									adapter.log.debug("OpenAPI: Hue set to " + state.val);
								})
								.catch(function(err) {
									logApiError("OpenAPI: Error while setting hue value " + state.val, err);
								})
								.then(function() {
									processCommandQueue();
								});
							break;
		// Saturation
		case "saturation":	auroraAPI.setSat(parseInt(state.val)) // parseInt to fix vis colorPicker
								.then(function() {
									adapter.log.debug("OpenAPI: Saturation set to " + state.val);
								})
								.catch(function(err) {
									logApiError("OpenAPI: Error while setting saturation value " + state.val, err);
								})
								.then(function() {
									processCommandQueue();
								});
							break;
		// Color Temeperature
		case "colorTemp":	auroraAPI.setColourTemperature(state.val)
								.then(function() {
									adapter.log.debug("OpenAPI: Color temperature set to " + state.val);
								})
								.catch(function(err) {
									logApiError("OpenAPI: Error while setting color temeperature " + state.val, err);
								})
								.then(function() {
									processCommandQueue();
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
										logApiError("OpenAPI: Error while setting RGB color R=" + rgb.R + ", G=" + rgb.G + ", B=" + rgb.B, err);
									})
									.then(function() {
										processCommandQueue();
									});
							}
							else {
								adapter.log.error("OpenAPI: set RGB color: Supplied RGB hex string \"" + state.val + "\" is invalid!");
								processCommandQueue();
							}
							break;
		// Current effect
		case "effect":		auroraAPI.setEffect(state.val)
								.then(function() {
									adapter.log.debug("OpenAPI: Effect set to \"" + state.val + "\"");
								})
								.catch(function(err) {
									logApiError("OpenAPI: Error while setting effect \"" + state.val + "\"", err);
								})
								.then(function() {
									processCommandQueue();
								});
							break;
		// Indentify
		case "identify":	auroraAPI.identify()
								.then(function() {
									adapter.log.debug("OpenAPI: Identify panels enabled!");
								})
								.catch(function(err) {
									logApiError("OpenAPI: Error while triggering identification", err);
								})
								.then(function() {
									processCommandQueue();
								});
							break;
		}
}

// clear command queue
function clearCommandQueue() {
	commandQueue.length = 0;

	adapter.log.debug("Command queue cleared!");
}

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
	pollingTimer = setTimeout(statusUpdate, pollingInterval);
}

function StopPollingTimer() {
	adapter.log.debug("Polling timer stopped!");
	clearTimeout(pollingTimer);
	pollingTimer = null;
}

function StartConnectTimer(isReconnect) {
	connectTimer = setTimeout(connect, reconnectInterval * 1000, isReconnect);
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

// loggin of actions via API. Only bad requests (invalid data supplied) logs error, all other only in debug
function logApiError(msg, err) {
	var errormsg = msg + ", " + formatError(err);
	
	if (Number.isInteger(err) && err == 400)
		adapter.log.error(errormsg);
	else adapter.log.debug(errormsg);
}

// Update states via polling
function statusUpdate() {
	auroraAPI.getInfo()
		.then(function(info) {
			StartPollingTimer();	// restart polling timer for next update
			// update States
			writeStates(JSON.parse(info));
		})
		.catch(function(err) {
			adapter.log.debug("Updating states failed: " + formatError(err));
			stopAdapterProcessing();
			adapter.setState("info.connection", false, true);			// set disconnect state
			adapter.log.warn("Connection to \"" + auroraAPI.host + ":" + auroraAPI.port + "\" lost, " + formatError(err) + ". Try to reconnect...");
			lastError = err;
			StartConnectTimer(true);									// start connect timer
		});
}

// write States
function writeStates(newStates) {
	// read all old states
	adapter.getStates("*", function (err, oldStates) {		
		if (err) {
			adapter.log.error("Error reading states: " + err + ". Update polling stopped!");
			StopPollingTimer();		// stop polling because something is wrong
		}
		else {
			setChangedState(NLdevice + ".state", 		oldStates[adapter.namespace + "." + NLdevice + ".state"]		, newStates.state.on.value);
			setChangedState(NLdevice + ".brightness", 	oldStates[adapter.namespace + "." + NLdevice + ".brightness"], newStates.state.brightness.value);
			setChangedState(NLdevice + ".hue",			oldStates[adapter.namespace + "." + NLdevice + ".hue"]		, newStates.state.hue.value);
			setChangedState(NLdevice + ".saturation", 	oldStates[adapter.namespace + "." + NLdevice + ".saturation"], newStates.state.sat.value);
			setChangedState(NLdevice + ".colorTemp",	oldStates[adapter.namespace + "." + NLdevice + ".colorTemp"]	, newStates.state.ct.value);
			// write RGB color only when colorMode is 'hs'
			if (newStates.state.colorMode == "hs")
				setChangedState(NLdevice + ".colorRGB",	oldStates[adapter.namespace + "." + NLdevice + ".colorRGB"]	, HSVtoRGB(newStates.state.hue.value, newStates.state.sat.value, newStates.state.brightness.value));
			setChangedState(NLdevice + ".colorMode",	oldStates[adapter.namespace + "." + NLdevice + ".colorMode"]	, newStates.state.colorMode);
			setChangedState(NLdevice + ".effect",		oldStates[adapter.namespace + "." + NLdevice + ".effect"]	, newStates.effects.select);
			var effectsArray = newStates.effects.effectsList;
			var effectsList;
			var effectsStates = new Object({"*Solid*": "Solid", "*Dynamic*": "Dynamic"});
			// loop through effectsList and write it as semicolon separated string and new states object
			for (var i = 0; i < effectsArray.length; i++) {
				if (effectsList)
					effectsList += ";" + effectsArray[i];
				else
					effectsList = effectsArray[i];
				effectsStates[effectsArray[i]] = effectsArray[i];
			}
			setChangedState(NLdevice + ".effectsList", 	oldStates[adapter.namespace + "." + NLdevice + ".effectsList"], effectsList);
			// updating states of effect if changed
			adapter.getObject(NLdevice + ".effect", function (err, obj) {
				if (err) adapter.log.debug("Error getting \"" + effectObject + "\": " + err);
				else {
					// only if list has changed
					if (JSON.stringify(effectsStates) != JSON.stringify(obj.common.states)) {
						adapter.log.debug("Update from OpenAPI: possible states for state \"effect\" changed >>>> set new states: " + JSON.stringify(effectsArray));
						obj.common.states = effectsStates;
						adapter.setObject(NLdevice + ".effect", obj, function (err) {
							if (err) adapter.log.debug("Error getting \"" + NLdevice + ".effect" + "\": " + err)
						});
					}
				}
			});
			
			setChangedState(NLdevice + ".info.name",			oldStates[adapter.namespace + "." + NLdevice + ".info.name"]				, newStates.name);
			setChangedState(NLdevice + ".info.serialNo",		oldStates[adapter.namespace + "." + NLdevice + ".info.serialNo"]			, newStates.serialNo);
			setChangedState(NLdevice + ".info.firmwareVersion", oldStates[adapter.namespace + "." + NLdevice + ".info.firmwareVersion"]	, newStates.firmwareVersion);
			setChangedState(NLdevice + ".info.model",			oldStates[adapter.namespace + "." + NLdevice + ".info.model"]			, newStates.model);

			// Rhythm module only available with nanoleaf Light-Panels, Canvas has built in module and here we get no info about Rhythm
			if (typeof newStates.rhythm === "object") {
				let oldConnectedState = oldStates[adapter.namespace + ".Rhythm.info.connected"];
				let newConnectedState = newStates.rhythm.rhythmConnected;

				setChangedState("Rhythm.info.connected", oldConnectedState, newConnectedState);

				// current connected state is true
				if (newConnectedState) {
					// last connection state was false -> create states
					if (!oldConnectedState || (oldConnectedState && !oldConnectedState.val)) {
						adapter.log.info("Rhythm module attached!");
						adapter.log.debug("Creating Rhythm states...");
						CreateRhythmStates();
					}

					// update states
					setChangedState("Rhythm.info.active",			oldStates[adapter.namespace + ".Rhythm.info.active"],			newStates.rhythm.rhythmActive);
					setChangedState("Rhythm.info.hardwareVersion",	oldStates[adapter.namespace + ".Rhythm.info.hardwareVersion"],	newStates.rhythm.hardwareVersion);
					setChangedState("Rhythm.info.firmwareVersion",	oldStates[adapter.namespace + ".Rhythm.info.firmwareVersion"],	newStates.rhythm.firmwareVersion);
					setChangedState("Rhythm.info.auxAvailable",		oldStates[adapter.namespace + ".Rhythm.info.auxAvailable"],		newStates.rhythm.auxAvailable);
					setChangedState("Rhythm.info.rhythmMode",		oldStates[adapter.namespace + ".Rhythm.info.rhythmMode"],		newStates.rhythm.rhythmMode);
				}
				// module is not connected anymore
				else {
					// last connection state was true -> delete states
					if (oldConnectedState && oldConnectedState.val) {
						adapter.log.info("Rhythm module detached!");
						adapter.log.debug("Deleting Rhythm states...");
						DeleteRhythmStates()
					}
				};
			}
		}
	});
}

// set changed state value
function setChangedState(stateID, oldState, newStateValue) {
	// check oldStates
	try {
		// set state only when value changed or value is not acknowledged or state is null (never had a value)
		if (oldState == null || oldState.val != newStateValue || !oldState.ack) {
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

// Create nanoleaf deviceP
function createNanoleafDevice(model, rhythmAvailable, callback) {
	var nameProp;

	switch (model) {
		// Canvas
		case nanoleafDevices.canvas.model:
			NLdevice = nanoleafDevices.canvas.deviceName;
			nameProp = nanoleafDevices.canvas.name;
			break;
		// LightPanels
		case nanoleafDevices.lightpanels.model:
		// LightPanels are fallback
		default:
			NLdevice = nanoleafDevices.lightpanels.deviceName;
			nameProp = nanoleafDevices.lightpanels.name;
	}
	deleteNanoleafDevices(model);	// delete all other nanoleaf device models if existing

	// if Rhythm module available -> create Rhythm device, else delete it
	if (rhythmAvailable) CreateRhythmDevice();
	else DeleteRhythmDevice();

	adapter.log.debug("nanoleaf Device \"" + nameProp + "\" detected!");

	// create the device if not exists
	adapter.getObject(NLdevice, function (err, obj) {
		if (err) throw err;
		if (obj == null) {
			adapter.log.info("New nanoleaf device \"" + nameProp + "\" detected!");

			// Create nanoleaf Device
			adapter.createDevice(NLdevice,
				{
					"name": nameProp + " Device",
					"icon": "/icons/" + NLdevice.toLocaleLowerCase() + ".png"
				}, {}
			);
			// create info Channel
			adapter.createChannel(NLdevice, "info",
				{
					"name": nameProp + " Device Information",
					"icon": "/icons/" + NLdevice.toLocaleLowerCase() + ".png"
				}, {}
			);
			// create info "firmwareVersion" state
			adapter.createState(NLdevice, "info", "firmwareVersion",
				{
					"name": "Firmware Version of nanoleaf device",
					"type": "string",
					"read": true,
					"write": false,
					"role": "info.version"
				}, {}
			);
			// create info "model" state
			adapter.createState(NLdevice, "info", "model",
				{
					"name": "Model of nanoleaf device",
					"type": "string",
					"read": true,
					"write": false,
					"role": "info.model"
				}, {}
			);
			// create info "name" state
			adapter.createState(NLdevice, "info", "name",
				{
					"name": "Name of nanoleaf device",
					"type": "string",
					"read": true,
					"write": false,
					"role": "info.name"
				}, {}
			);
			// create info "serialNo" state
			adapter.createState(NLdevice, "info", "serialNo",
				{
					"name": "Serial No. of nanoleaf device",
					"type": "string",
					"read": true,
					"write": false,
					"role": "info.serial"
				}, {}
			);
			// create "state" state
			adapter.createState(NLdevice, "", "state",
				{
					"name": "Power State",
					"type": "boolean",
					"def": false,
					"read": true,
					"write": true,
					"role": "switch.light",
					"desc": "Switch on/off"
				}, {}
			);
			// create "brightness" state
			adapter.createState(NLdevice, "", "brightness",
				{
					"name": "Brightness level",
					"type": "number",
					"unit": "%",
					"def": 100,
					"min": 0,
					"max": 100,
					"read": true,
					"write": true,
					"role": "level.dimmer",
					"desc": "Brightness level in %"
				}, {}
			);
			// create "hue" state
			adapter.createState(NLdevice, "", "hue",
				{
					"name": "Hue value",
					"type": "number",
					"unit": "°",
					"def": 100,
					"min": 0,
					"max": 360,
					"read": true,
					"write": true,
					"role": "level.color.hue",
					"desc": "Hue value"
				}, {}
			);
			// create "saturation" state
			adapter.createState(NLdevice, "", "saturation",
				{
					"name": "Saturation value",
					"type": "number",
					"unit": "%",
					"def": 100,
					"min": 0,
					"max": 100,
					"read": true,
					"write": true,
					"role": "level.color.saturation",
					"desc": "Saturation value"
				}, {}
			);
			// create "colorMode" state
			adapter.createState(NLdevice, "", "colorMode",
				{
					"name": "Color Mode",
					"type": "string",
					"read": true,
					"write": false,
					"role": "value.color.mode",
					"desc": "Color Mode"
				}, {}
			);
			// create "colorRGB" state
			adapter.createState(NLdevice, "", "colorRGB",
				{
					"name": "RGB Color",
					"type": "string",
					"read": true,
					"write": true,
					"role": "level.color.rgb",
					"desc": "Color in RGB hex format (#000000 to #FFFFFF)"
				}, {}
			);
			// create "colorTemp" state
			adapter.createState(NLdevice, "", "colorTemp",
				{
					"name": "Color Temperature",
					"type": "number",
					"unit": "K",
					"def": 4000,
					"min": 1200,
					"max": 6500,
					"read": true,
					"write": true,
					"role": "level.color.temperature",
					"desc": "Color Temperature"
				}, {}
			);
			// create "effect" state
			adapter.createState(NLdevice, "", "effect",
				{
					"name": "Current effect",
					"type": "string",
					"read": true,
					"write": true,
					"role": "text",
					"states": [],
					"desc": "Current effect"
				}, {}
			);
			// create "effectsList" state
			adapter.createState(NLdevice, "", "effectsList",
				{
					"name": "Effects list",
					"type": "string",
					"read": true,
					"write": false,
					"role": "text",
					"desc": "List of available effects"
				}, {}
			);
			// create "identify" state
			adapter.createState(NLdevice, "", "identify",
				{
					"name": "Identify panels",
					"type": "boolean",
					"read": false,
					"write": true,
					"role": "button",
					"desc": "Causes the panels to flash in unison"
				}, {},
				// callback starts adapter processing
				function() { callback(); }
			);
		}
		else{
			callback();	// callback starts adapter processing
		}
	});
}

// delete all nanoleaf devices
//		Parameter 'ignoreModel': ignore deletion of this device model
function deleteNanoleafDevices(ignoreModel) {
	// delete canvas device if not ignored
	if (ignoreModel !== nanoleafDevices.canvas.model) {
		// check if device is still existing
		adapter.getObject(nanoleafDevices.canvas.deviceName, function (err, obj) {
			if (err) throw err;
			// delete it
			if (obj != null) {
				adapter.log.debug("Delete \"" + nanoleafDevices.canvas.deviceName + "\" device...");
				adapter.getStates(nanoleafDevices.canvas.deviceName + ".*", function (err, states) {
					for(var id in states)
						adapter.delObject(id);
				});
				adapter.deleteDevice(nanoleafDevices.canvas.deviceName);
			}
		});
	}
	// delete light panels device if not ignored
	if (ignoreModel !== nanoleafDevices.lightpanels.model) {
		// check if device is still existing
		adapter.getObject(nanoleafDevices.lightpanels.deviceName, function (err, obj) {
			if (err) throw err;
			// delete it
			if (obj != null) {
				adapter.log.debug("Delete \"" + nanoleafDevices.lightpanels.deviceName + "\" device...");
				adapter.getStates(nanoleafDevices.lightpanels.deviceName + ".*", function (err, states) {
					for(var id in states)
						adapter.delObject(id);
				});
				adapter.deleteDevice(nanoleafDevices.lightpanels.deviceName);
			}
		});
	}
}

// Creates Rhythm Device
function CreateRhythmDevice() {
	// check if Rhythm Device already exists
	adapter.getObject("Rhythm", function (err, obj) {
		if (err) throw err;
		// if not existent, create it
		if (obj == null) {
			adapter.log.debug("Rhythm module information available. Creating Rhythm device...");

			// create Rhythm Device
			adapter.createDevice("Rhythm",
				{
					"name": "Light Panels Rhythm Module Device",
					"icon": "/icons/rhythm.png"
				}, {}
			);
			// create Rhythm Channel
			adapter.createChannel("Rhythm", "info",
				{
					"name": "Light Panels Rhythm Module Device Information",
					"icon": "/icons/rhythm.png"
				}, {}
			);
			// create "connected" state
			adapter.createState("Rhythm", "info", "connected",
				{
					"name": "Rhythm module connected to nanoleaf light panels",
					"type": "boolean",
					"read": true,
					"write": false,
					"role": "indicator.connected"
				}, {}
			);
		}
	});
}

// Deletes Rhythm device
function DeleteRhythmDevice() {
	// check if Rhythm Device exists
	adapter.getObject("Rhythm", function (err, obj) {
		if (err) throw err;
		// if existent, delete it
		if (obj != null) {
			adapter.log.debug("Rhythm module is not available. Delete Rhythm device...");

			adapter.deleteDevice("Rhythm");
		}
	});
}

// Creates Rhythm info states
function CreateRhythmStates() {
	// create "active" state
	adapter.createState("Rhythm", "info", "active",
		{
			"name": "Rhythm module active",
			"type": "boolean",
			"read": true,
			"write": false,
			"role": "indicator"
		}, {}
	);
	// create "auxAvailable" state
	adapter.createState("Rhythm", "info" , "auxAvailable",
		{
			"name": "AUX of rhythm module available",
			"type": "boolean",
			"read": true,
			"write": false,
			"role": "indicator"
		}, {}
	);
	// create "firmwareVersion" state
	adapter.createState("Rhythm", "info", "firmwareVersion",
		{
			"name": "Firmware Version of rhyhtm module",
			"type": "string",
			"read": true,
			"write": false,
			"role": "info.version"
		}, {}
	);
	// create "hardwareVersion" state
	adapter.createState("Rhythm", "info", "hardwareVersion",
		{
			"name": "Hardware Version of rhythm module",
			"type": "string",
			"read": true,
			"write": false,
			"role": "info.version.hw"
		}, {}
	);
	// create "rhythmMode" state
	adapter.createState("Rhythm", "info" , "rhythmMode",
		{
			"name": "Mode of rhythm module",
			"type": "number",
			"read": true,
			"write": false,
			"role": "value"
		}, {}
	);
}

// Deletes Rhythm info states
function DeleteRhythmStates() {
	adapter.deleteState("Rhythm", "info", "active");
	adapter.deleteState("Rhythm", "info", "hardwareVersion");
	adapter.deleteState("Rhythm", "info", "firmwareVersion");
	adapter.deleteState("Rhythm", "info", "auxAvailable");
	adapter.deleteState("Rhythm", "info", "rhythmMode");
}

function startAdapterProcessing() {
	// first update
	statusUpdate();
	// all states changes inside the adapters namespace are subscribed
	adapter.subscribeStates(NLdevice + ".*");
	// Start Status update polling
	StartPollingTimer();
	adapter.log.debug("Polling timer startet with " + pollingInterval + " ms");
}

function stopAdapterProcessing() {
	StopPollingTimer();
	clearCommandQueue();										// stop processing commands by clearing queue
	adapter.unsubscribeStates(NLdevice + ".*");					// unsubscribe state changes
}

function connect(isReconnect) {
	// establish connection through sending info-request
	auroraAPI.getInfo()
		.then(function(info) {
			StopConnectTimer();
			// set connection state to true
			adapter.setState("info.connection", true, true);
			adapter.log.info(((isReconnect) ? "Reconnected" : "Connected") + " to \"" + auroraAPI.host + ":" + auroraAPI.port);

			var deviceInfo = JSON.parse(info);

			// create nanoleaf device and start adapter processing with callback
			createNanoleafDevice(deviceInfo.model, typeof deviceInfo.rhythm === "object", startAdapterProcessing);
		})
		.catch(function(err) {
			var message = "Please check hostname/IP, device and connection!";
			// is HTTP error then special error messages
			if (Number.isInteger(err) && (err == 401 || err == 403)) message = "Permission denied, please check authorization token!"; 

			adapter.log.debug("Reconnect to \"" + auroraAPI.host + ":" + auroraAPI.port + "\" failed with " + formatError(err) + ", " + message);
			
			// log only if error changed
			if (lastError === undefined || err.code != lastError.code) {
				adapter.log.error("Connection to \"" + auroraAPI.host + ":" + auroraAPI.port + "\" failed, " + formatError(err) + ", " + message + ". Retry in " + adapter.config.reconnectInterval + "s intervals...");
				lastError = err;
			}
			StartConnectTimer(isReconnect);		// start reconnect timer
			adapter.log.debug("Connect timer startet with " + reconnectInterval * 1000 + " ms");
	});
}

function init() {
	try {
		// initialize timer intervals (override when intervall is to small)
		if (adapter.config.pollingInterval < minPollingInterval) pollingInterval = minPollingInterval;
		else pollingInterval = adapter.config.pollingInterval;
		if (adapter.config.reconnectInterval < minReconnectInterval) reconnectInterval = minReconnectInterval;
		else reconnectInterval = adapter.config.reconnectInterval;
		
		// initialize Aurora API
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
