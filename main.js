'use strict';

const utils = require('@iobroker/adapter-core');
const sucks = require('sucks');
const nodeMachineId = require('node-machine-id');
const EcoVacsAPI = sucks.EcoVacsAPI;
const VacBot = sucks.VacBot;

class EcovacsDeebot extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: 'ecovacs-deebot',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.deviceName = null;
        this.vacbot = null;
        this.speedMode = 'normal';
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState(this.deviceName+'.info.connection', false);
        this.connect();
        this.subscribeStates('*');
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState(this.deviceName+'.info.connection', false);
            this.log.info('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }

        let channel = this.getChannelById(id);
        if (channel === 'control') {
            let state = this.getStateById(id);
            if (state === 'speedMode') {
                this.speedMode = state.val;
                this.log.info("speedMode: "+this.speedMode);
            }
            else {
                switch (state) {
                    case 'clean':
                        this.vacbot.run(state, 'auto', this.speedMode);
                        this.log.info("run: "+state);
                        this.log.info("speedMode: "+this.speedMode);
                        break;
                    case 'stop':
                    case 'edge':
                    case 'spot':
                    case 'charge':
                        this.vacbot.run(state);
                        break;
                }
            }
        }
    }

    getChannelById(id) {
        let channel = id.split('.')[3];
        return channel;
    }

    getStateById(id) {
        let state = id.split('.')[4];
        return state;
    }

    async connect() {
        if ((!this.config.email)||(!this.config.password)||(!this.config.countrycode)) {
            this.error('Missing values in adapter config',true);
            return;
        }

        const password_hash = EcoVacsAPI.md5(this.config.password);
        const device_id = EcoVacsAPI.md5(nodeMachineId.machineIdSync());
        const countries = sucks.countries;
        const continent = countries[this.config.countrycode.toUpperCase()].continent.toLowerCase();

        const api = new EcoVacsAPI(device_id, this.config.countrycode, continent);
        api.connect(this.config.email, password_hash).then(() => {
            api.devices().then((devices) => {
                this.log.info("Devices:" + JSON.stringify(devices));
                let vacuum = devices[0];
                this.deviceName = vacuum.nick;
                this.createStates();
                this.vacbot = new VacBot(api.uid, EcoVacsAPI.REALM, api.resource, api.user_access_token, vacuum, continent);
                this.vacbot.on('ready', (event) => {
                    this.vacbot.on('ChargeState', (chargestatus) => {
                        this.setState(this.deviceName+'.info.chargestatus', chargestatus);
                        if (chargestatus === 'charging') {
                            this.setState(this.deviceName+'.info.cleanstatus', '');
                        }
                    });
                    this.vacbot.on('CleanReport', (cleanstatus) => {
                        this.setState(this.deviceName+'.info.cleanstatus', cleanstatus);
                        if (cleanstatus === 'auto') {
                            this.setState(this.deviceName+'.info.chargestatus', '');
                        }
                    });
                    this.vacbot.on('BatteryInfo', (batterystatus) => {
                        this.setState(this.deviceName+'.info.battery', Math.round(batterystatus*100));
                    });
                    this.vacbot.on('Lifespan', (value) => {
                        this.setState(this.deviceName+'.consumable.filter', value);
                    });
                    this.vacbot.on('Error', (message) => {
                        this.error(message,false);
                    });
                });
                this.vacbot.connect_and_wait_until_ready();
                this.setState(this.deviceName+'.info.connection', true);
                /*this.speedMode = this.getState(this.deviceName+'.control.speedMode',function (err, state) {}).val;
                this.log.info("speedMode: "+this.speedMode);*/
            });
        }).catch((e) => {
            this.error('Failure in connecting!',true);
        });
    }

    error(message,stop) {
        if (stop) {
            this.setState(this.deviceName + '.info.connection', false);
        }
        this.setState(this.deviceName+'.info.error', message);
        this.log.error(message);
    }

    async createStates() {
        const buttons = new Map();
        buttons.set('clean', 'start automatic cleaning');
        buttons.set('edge', 'start edge cleaning');
        buttons.set('spot', 'start spot cleaning');
        buttons.set('stop', 'stop cleaning');
        buttons.set('charge', 'go back to charging station');
        for (const [objectName, name] of buttons) {
            await this.setObjectNotExists(this.deviceName+'.control.'+objectName, {
                type: 'state',
                common: {
                    name: name,
                    type: 'boolean',
                    role: 'button',
                    read: true,
                    write: true
                },
                native: {},
            });
        }
        /*await this.setObjectNotExists(this.deviceName+'.control.speedMode', {
            type: 'state',
            common: {
                name: 'Speed mode (normal or high)',
                type: 'string',
                role: 'value',
                read: true,
                write: true,
                def: 'normal'
            },
            native: {},
        });*/
        await this.setObjectNotExists(this.deviceName+'.info.battery', {
            type: 'state',
            common: {
                name: 'Battery status',
                type: 'integer',
                role: 'value.battery',
                read: true,
                write: true,
                unit: '%'
            },
            native: {},
        });
        await this.setObjectNotExists(this.deviceName+'.info.connection', {
            type: 'state',
            common: {
                name: 'Connection status',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: true
            },
            native: {},
        });
        await this.setObjectNotExists(this.deviceName + '.info.cleanstatus', {
            type: 'state',
            common: {
                name: 'Clean status',
                type: 'string',
                role: 'indicator.status',
                read: true,
                write: true
            },
            native: {},
        });
        await this.setObjectNotExists(this.deviceName + '.info.chargestatus', {
            type: 'state',
            common: {
                name: 'Charge status',
                type: 'string',
                role: 'indicator.status',
                read: true,
                write: true
            },
            native: {},
        });
        await this.setObjectNotExists(this.deviceName + '.info.error', {
            type: 'state',
            common: {
                name: 'Error messages',
                type: 'string',
                role: 'indicator.error',
                read: true,
                write: true
            },
            native: {},
        });
        const consumable = new Map();
        consumable.set('filter','Remaining lifetime of the filter');
        consumable.set('main_brush','Remaining lifetime of the main brush');
        consumable.set('side_brush','Remaining lifetime of the side brush');
        for (let key of consumable.keys()) {
            await this.setObjectNotExists(this.deviceName+'.consumable.'+key, {
                type: 'state',
                common: {
                    name: consumable.get(key),
                    type: 'integer',
                    role: 'level',
                    read: true,
                    write: true,
                    unit: '%'
                },
                native: {},
            });
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new EcovacsDeebot(options);
} else {
    // otherwise start the instance directly
    new EcovacsDeebot();
}