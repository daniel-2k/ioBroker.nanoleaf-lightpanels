![Logo](admin/nanoleaf-lightpanels.png)
# ioBroker.nanoleaf-lightpanels Adapter
=================

[![NPM version](https://img.shields.io/npm/v/iobroker.nanoleaf-lightpanels.svg)](https://www.npmjs.com/package/iobroker.nanoleaf-lightpanels)
[![Downloads](https://img.shields.io/npm/dm/iobroker.nanoleaf-lightpanels.svg)](https://www.npmjs.com/package/iobroker.nanoleaf-lightpanels)

[![NPM](https://nodei.co/npm/iobroker.nanoleaf-lightpanels.png?downloads=true)](https://nodei.co/npm/iobroker.nanoleaf-lightpanels/)

This is an ioBroker Adapter to control the nanoleaf Light Panels (formerly nanoleaf Aurora) through the nanoleaf Light Panels OpenAPI.

## Connection to the nanoleaf Light Panels Controller:
1. In the adapter settings you can set the IP address and port of the nanoleaf Light Panels Controller. The nanoleaf Light Panels OpenAPI needs an authorization token to grant access to the REST-API. If you have already one, you can enter the token.
   If you don't have an authorization token you need to request it from the nanoleaf Light Panels OpenAPI.
   The adapter can do this automatically when it starts (see 2.).
2. Set the nanoleaf Light Panel Controller into pairing mode by pressing the power button for 5-7 seconds until the white LED flashes.
3. Start the adapter within 30 seconds.
   The adapter will now try to obtain automatically an authorization key. You will see it in the log whether this was successful.
   The indicator of the adapter should switch from yellow to green when the adapter is connected to nanoleaf Light Panels Controller.
4. Have fun!

Because the nanoleaf Light Panels OpenAPI doesn't support long polling or websockets the only way to update the states is polling.
You can set the polling interval in the adapter settings.

## Alexa
You can control the nanoleaf Light Panels with Alexa via ioBroker (Cloud-Adapter).
Power on/off, brightness, color and color temperature ius supported.
You have to set up the datapoints
* state (for power on/off)
* hue (for color)
* saturation (for color)
* brightness (for color)
* colorTemp (for color temperature)
in Cloud adapter under the same smartname.

## Changelog

### 0.2.0 (2018-05-03)
* (daniel_2k) adjusted types and roles of states according API JSON response data types
* (daniel_2k) compatible with node.js 4.x

### 0.1.0 (2018-04-23)
* (daniel_2k) initial release

## License
The MIT License (MIT)