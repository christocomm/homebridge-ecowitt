import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { EcowittAccessory } from './EcowittAccessory';
import { GW1000 } from './GW1000';
import { WH25 } from './WH25';
import { WH31 } from './WH31';
import { WH41 } from './WH41';
import { WH65 } from './WH65';
import { WH55 } from './WH55';
import { WH57 } from './WH57';
import { WH51 } from './WH51';

import * as restify from 'restify';
import * as crypto from 'crypto';
import { platform } from 'node:os';
//import { timeStamp } from 'node:console';
//import { type } from 'node:os';

// interface SensorInfo {
//   name: string;
//   model: string;
//   displayName: string;
// }

interface StationInfo {
  model: string;
  serialNumber: string;
  hardwareRevision: string;
  softwareRevision: string;
  firmwareRevision: string;
  frequency: string;
  PASSKEY: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sensors: any [];
}

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class EcowittPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  public wxDataReportServer: restify.Server;
  public wxDataReport = null;

  public wxStationInfo: StationInfo = {
    model: '',
    serialNumber: this.config.mac,
    hardwareRevision: '',
    softwareRevision: '',
    firmwareRevision: '',
    frequency: '',
    PASSKEY: crypto
      .createHash('md5')
      .update(this.config.mac)
      .digest('hex').toUpperCase(),
    sensors: [],
  };

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {

    this.log.info('config:', JSON.stringify(this.config, undefined, 2));

    this.wxDataReportServer = restify.createServer();
    this.wxDataReportServer.use(restify.plugins.bodyParser());

    this.log.info('Data report path:', this.config.path);
    this.log.info('Data report port:', this.config.port);

    this.wxDataReportServer.post(
      this.config.path,
      (req, res, next) => {
        this.log.info('Data source address:', req.socket.remoteAddress);
        this.log.info('Request:', req.toString());
        this.wxDataReportReport(req.body);
        next();
      });


    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');

      this.wxUnregisterAccessories();

      this.wxDataReportServer.listen(this.config.port, () => {
        this.log.info('Listening at %s', this.wxDataReportServer.url);
      });
    });
  }

  //----------------------------------------------------------------------------

  public serviceUuid(name: string) {
    const serviceId = this.config.mac + '_' + name;
    return this.api.hap.uuid.generate(serviceId);
  }

  //----------------------------------------------------------------------------

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }


  wxDataReportReport(dataReport) {
    if (dataReport.PASSKEY !== this.wxStationInfo.PASSKEY) {
      this.log.error('Report not for this station:', JSON.stringify(dataReport, undefined, 2));
      return;
    }

    this.log.info('Data report:', JSON.stringify(dataReport, undefined, 2));

    if (!this.wxDataReport) {
      this.wxDataReport = dataReport;
      this.wxRegisterAccessories(dataReport);
    } else {
      this.wxDataReport = dataReport;
    }

    this.wxUpdateAccessories(dataReport);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addSensorType(add: boolean, type: string, channel: any = undefined) {
    if (add) {
      this.wxStationInfo.sensors.push(
        {
          type: type,
          channel: channel,
        });

      if (channel) {
        this.log.info(`Discovered sensor: ${type} channel: ${channel}`);
      } else {
        this.log.info(`Discovered sensor: ${type}`);
      }
    }
  }

  wxUnregisterAccessories() {
    this.log.info('Unregistering cached accessories:', this.accessories.length);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.accessories);
  }

  wxRegisterAccessories(dataReport) {
    this.wxStationInfo.model = dataReport.model;
    this.wxStationInfo.hardwareRevision = dataReport.stationtype;
    this.wxStationInfo.frequency = dataReport.freq;

    const version = this.wxStationInfo.hardwareRevision.match(/GW1000_(.*)/);
    this.wxStationInfo.firmwareRevision = Array.isArray(version) ? version[1] : '';


    this.log.info('Discovering sensors');

    this.addSensorType(/GW1000/.test(dataReport.model), 'GW1000');
    this.addSensorType(dataReport.wh25batt !== undefined, 'WH25');
    this.addSensorType(dataReport.wh57batt !== undefined, 'WH57');
    this.addSensorType(dataReport.wh65batt !== undefined, 'WH65');

    if (!this.config?.th?.hidden) {
      for (let channel = 1; channel <= 8; channel++) {
        this.addSensorType(dataReport[`batt${channel}`] !== undefined, 'WH31', channel);
      }
    }

    if (!this.config?.pm25?.hidden) {
      for (let channel = 1; channel <= 4; channel++) {
        this.addSensorType(dataReport[`pm25batt${channel}`] !== undefined, 'WH41', channel);
      }
    }

    if (!this.config?.soil?.hidden) {
      for (let channel = 1; channel <= 8; channel++) {
        this.addSensorType(dataReport[`soilbatt${channel}`] !== undefined, 'WH51', channel);
      }
    }

    if (!this.config?.leak?.hidden) {
      for (let channel = 1; channel <= 4; channel++) {
        this.addSensorType(dataReport[`leakbatt${channel}`] !== undefined, 'WH55', channel);
      }
    }

    this.log.info('WX Station:', JSON.stringify(this.wxStationInfo, undefined, 2));

    for (const sensor of this.wxStationInfo.sensors) {
      const sensorId = this.config.mac +
        '-' +
        sensor.type +
        (sensor.channel > 0 ? '-' + sensor.channel.toString() : '');
      const uuid = this.api.hap.uuid.generate(sensorId);

      this.log.info('sensorId:', sensorId, 'uuid:', uuid);

      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        // the accessory already exists
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
        // existingAccessory.context.device = device;
        // this.api.updatePlatformAccessories([existingAccessory]);

        // create the accessory handler for the restored accessory
        // this is imported from `platformAccessory.ts`
        //new EcowittAccessory(this, existingAccessory);

        // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
        // remove platform accessories when no longer present
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
        this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
        //} else {
      }
      {
        // the accessory does not yet exist, so we need to create it
        this.log.info('Adding new accessory type:', sensor.type, 'channel:', sensor.channel);

        // create a new sensor accessory
        const accessory = new this.api.platformAccessory(sensor.type, uuid);

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        //accessory.context.sensorInfo = sensorInfo;

        switch (sensor.type) {
          case 'GW1000':
            sensor.accessory = new GW1000(this, accessory);
            break;

          case 'WH25':
            sensor.accessory = new WH25(this, accessory);
            break;

          case 'WH31':
            sensor.accessory = new WH31(this, accessory, sensor.channel);
            break;

          case 'WH41':
            sensor.accessory = new WH41(this, accessory, sensor.channel);
            break;

          case 'WH51':
            sensor.accessory = new WH51(this, accessory, sensor.channel);
            break;

          case 'WH55':
            sensor.accessory = new WH55(this, accessory, sensor.channel);
            break;

          case 'WH57':
            sensor.accessory = new WH57(this, accessory);
            break;

          case 'WH65':
            sensor.accessory = new WH65(this, accessory);
            break;

          default:
            this.log.error('Unhandled sensor type:', sensor.type);
            break;
        }

        // link the sensor accessory to the platform
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  wxUpdateAccessories(dataReport) {
    const dateUTC = new Date(dataReport.dateutc);
    this.log.info('Report time:', dateUTC);

    for (const sensor of this.wxStationInfo.sensors) {
      this.log.info('Updating:', sensor.type, sensor.channel);
      sensor.accessory.update(dataReport);
    }
  }
}