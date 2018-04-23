/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';
const http = require('http');
const AuroraApi = require('nanoleaf-aurora-client');

// you have to require the utils module and call adapter function
var utils =    require(__dirname + '/lib/utils'); // Get common adapter utils

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

// is called if a subscribed state changes
adapter.on("stateChange", function (id, state) {
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
											.catch(function(err) {
												adapter.log.warn("Error turn on light panels, " + formatError(err));
											});
									else
										auroraAPI.turnOff()
											.catch(function(err) {
												adapter.log.warn("Error turn off light panels, " + formatError(err));
											});
									break;
				// Brithness
				case "brightness":	auroraAPI.setBrightness(state.val)
										.catch(function(err) {
											adapter.log.warn("Error while setting brightness value " + state.val + ", " + formatError(err));
										});
									break;
				// Hue
				case "hue":			auroraAPI.setHue(state.val)
										.catch(function(err) {
											adapter.log.warn("Error while setting hue value " + state.val + ", " + formatError(err));
										});
									break;
				// Saturation
				case "saturation":	auroraAPI.setSat(state.val)
										.catch(function(err) {
											adapter.log.warn("Error while setting saturation value " + state.val + ", " + formatError(err));
										});
									break;
				// Color Temeperature
				case "colorTemp":	auroraAPI.setColourTemperature(state.val)
										.catch(function(err) {
											adapter.log.warn("Error while setting color temeperature " + state.val + ", " + formatError(err));
										});
									break;
				// Current effect
				case "effect":		auroraAPI.setEffect(state.val)
										.catch(function(err) {
											adapter.log.warn("Error while setting effect \"" + state.val + "\", " + formatError(err));
										});
									break;
				// Indentify
				case "identify":	auroraAPI.identify()
										.catch(function(err) {
											adapter.log.warn("Error while triggering identification, " + formatError(err));
										});
									break;
			}
		}
	}
});

// start here!
adapter.on("ready", function () {
    main();
});

function StartPollingTimer() {
	pollingTimer = setTimeout(statusUpdate, adapter.config.pollingInterval);
}

function StopPollingTimer() {
	clearTimeout(pollingTimer);
	pollingTimer = null;
}

function StartConnectTimer(isReconnect) {
	connectTimer = setTimeout(connect, adapter.config.reconnectInterval * 1000, isReconnect);
}

function StopConnectTimer() {
	clearTimeout(connectTimer);
	connectTimer = null;
}

function formatError(err) {
	if (!err) return "Error: unknown";
	
	var message = err;
		
	if (Number.isInteger(err))
		message = "HTTP error " + err;
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
	auroraAPI.getInfo()
		.then(function(info) {
			StartPollingTimer();
			// update States
			writeStates(JSON.parse(info));
		})
		.catch(function(err) {
			StopPollingTimer();
			adapter.unsubscribeStates("*");								// unsubscribe state changes
			adapter.setState("info.connection", false, true);			// set disconnect state
			adapter.log.warn("Connection to \"" + auroraAPI.host + ":" + auroraAPI.port + "\" lost, " + formatError(err) + ". Try to reconnect...");
			StartConnectTimer(true);									// start connect timer
		});
}

// write States
function writeStates(states) {
	adapter.setState("LightPanels.state", states.state.on.value, true);
	adapter.setState("LightPanels.brightness", states.state.brightness.value, true);
	adapter.setState("LightPanels.hue", states.state.hue.value, true);
	adapter.setState("LightPanels.saturation", states.state.sat.value, true);
	adapter.setState("LightPanels.colorTemp", states.state.ct.value, true);
	adapter.setState("LightPanels.colorMode", states.state.colorMode, true);
	adapter.setState("LightPanels.effect", states.effects.select, true);
	adapter.setState("LightPanels.effectsList", JSON.stringify(states.effects.effectsList), true);
	
	adapter.setState("LightPanels.info.name", states.name, true);
	adapter.setState("LightPanels.info.serialNo", states.serialNo, true);
	adapter.setState("LightPanels.info.firmwareVersion", states.firmwareVersion, true);
	adapter.setState("LightPanels.info.model", states.model, true);
	
	adapter.setState("Rhythm.info.connected", states.rhythm.rhythmConnected, true);
	adapter.setState("Rhythm.info.active", states.rhythm.rhythmActive, true);
	adapter.setState("Rhythm.info.hardwareVersion", states.rhythm.hardwareVersion, true);
	adapter.setState("Rhythm.info.firmwareVersion", states.rhythm.firmwareVersion, true);
	adapter.setState("Rhythm.info.auxAvailable", states.rhythm.auxAvailable, true);
	adapter.setState("Rhythm.info.rhythmMode", states.rhythm.rhythmMode, true);
}

// write Adapter configuration (adapter restarts automatically!)
function writeConfig() {
	adapter.getForeignObject("system.adapter." + adapter.namespace, function (err, obj) {
	    if (err) {
	        adapter.log.error(formatError(err));
	    }
	    else {
	        obj.native = adapter.config;
	        adapter.setForeignObject(obj._id, obj, function (err) {
	            if (err) adapter.log.error(formatError(err));
	        });
	    }
	});
}

// automatically obtain an auth token when device is in pairing mode
function getAuthToken(address, port) {
	adapter.log.info("Try to obtain authorization token from \"" + address + ":" + port + "\" (device has to be in pairing mode!)");
	
	const options = {
		hostname: address,
		port: port,
		path: "/api/v1/new",
		method: "POST",
		timeout: defaultTimeout
	}
	
	const req = http.request(options, (res) => {
		const { statusCode } = res;
		const contentType = res.headers['content-type'];

		switch (statusCode) {
			case 200:	if (!/^application\/json/.test(contentType)) {
					    	adapter.log.error("Invalid content-type. Expected \"application/json\" but received " + contentType);
					    	return;
						}
						break;
			case 401:	adapter.log.error("Getting authorization token failed because access is unauthorized (is the device in pairing mode?)");
						break;
			case 403:	adapter.log.error("Getting authorization token failed because permission denied (is the device in pairing mode?)");
						return;
						break;
			default:	adapter.log.error("Connection to \"" + address + ":" + port +  "\" failed, Status Code: " + statusCode);
						return;
		}
		
		var rawData = "";
		res.on("data", (chunk) => { rawData += chunk; });
		res.on("end", () => {
		    try {
				const parsedData = JSON.parse(rawData);
				if (parsedData["auth_token"]) {
					adapter.log.info("Got new Authentification Token: \"" + parsedData["auth_token"] + "\"");
					adapter.config.authtoken = parsedData["auth_token"];
					writeConfig();
					return;		// Adapter restarts automatically
				}
				else {
					adapter.log.error("JOSN response does not contain an \"auth_token\"");
					return;
				}
		    }
		    catch (err) {
				adapter.log.error("Error JOSN parsing received data: " + formatError(err));
				return;
		    }
		});
	});
	
	req.on("error", (err) => {
		adapter.log.error("Connection to \"" + address + ":" + port + "\" failed, " + formatError(err));
		return;
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
		// authorization token missing?
		if (/missing.*accesstoken/i.test(err)) {
			adapter.log.warn("No authorization token specified");
			getAuthToken(adapter.config.host, adapter.config.port);
		}
		else adapter.log.error(err);
	}

}

function main() {
	// connection state false
	adapter.setState("info.connection", false, true);
	        
    adapter.log.info("Nanoleaf adapter \"" + adapter.namespace + "\" starting...");
    
    // connect to nanoleaf controller and test connection
    init();
}
