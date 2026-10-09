import fs from 'fs/promises';
import mqtt, { IClientOptions, MqttClient } from 'mqtt';
import Trigger, { RollbackReport, TriggerConfiguration } from '../Trigger';
import Hass from './Hass';
import {
    registerContainerAdded,
    registerContainerUpdated,
} from '../../../event';
import { Container, flatten } from '../../../model/container';
import { isOneshot } from '../../../runtime/mode';
import { isReleaseSummaryEnabled, getReleaseSummary } from './GithubRelease';

const containerDefaultTopic = 'wud/container';
const hassDefaultPrefix = 'homeassistant';

/**
 * Get container topic.
 * @param baseTopic
 * @param container
 * @return {string}
 */
function getContainerTopic({ baseTopic, container }) {
    const containerName = container.name.replace(/\./g, '-');
    return `${baseTopic}/${container.watcher}/${containerName}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Environment variables are split on every underscore, so
 * `..._HASS_RELEASE_SUMMARY` and `..._HASS_GITHUB_TOKEN` are received as
 * `hass.release.summary` and `hass.github.token`.
 * Fold them back to the `hass.release_summary` and `hass.github_token` keys.
 */
function normalizeHassConfiguration<T>(configuration: T): T {
    if (!isPlainObject(configuration) || !isPlainObject(configuration.hass)) {
        return configuration;
    }
    const { release, github, ...hass } = configuration.hass;
    if (!isPlainObject(release) && !isPlainObject(github)) {
        return configuration;
    }
    if (isPlainObject(release)) {
        const { summary, ...releaseOthers } = release;
        if (summary !== undefined && hass.release_summary === undefined) {
            hass.release_summary = summary;
        }
        if (Object.keys(releaseOthers).length > 0) {
            hass.release = releaseOthers;
        }
    } else if (release !== undefined) {
        hass.release = release;
    }
    if (isPlainObject(github)) {
        const { token, ...githubOthers } = github;
        if (token !== undefined && hass.github_token === undefined) {
            hass.github_token = token;
        }
        if (Object.keys(githubOthers).length > 0) {
            hass.github = githubOthers;
        }
    } else if (github !== undefined) {
        hass.github = github;
    }
    return { ...configuration, hass };
}

export interface MqqtConfiguration extends TriggerConfiguration {
    url: string;
    topic: string;
    clientid: string;
    user: string;
    password: string;
    hass: {
        enabled: boolean;
        prefix: string;
        discovery: boolean;
        discovery_entities: 'all' | 'summary';
        deviceid: string;
        devicename: string;
        release_summary: boolean;
        github_token?: string;
    };
    tls: {
        clientkey: string;
        clientcert: string;
        cachain: string;
        rejectunauthorized: boolean;
    };
}

/**
 * MQTT Trigger implementation
 */
class Mqtt extends Trigger {
    /**
     * Get the Trigger configuration schema.
     * @returns {*}
     */
    getConfigurationSchema() {
        return this.joi.object().keys({
            url: this.joi
                .string()
                .uri({
                    scheme: ['mqtt', 'mqtts', 'tcp', 'tls', 'ws', 'wss'],
                })
                .required(),
            topic: this.joi.string().default(containerDefaultTopic),
            clientid: this.joi
                .string()
                .default(`wud_${Math.random().toString(16).substring(2, 10)}`),
            user: this.joi.string(),
            password: this.joi.string(),
            hass: this.joi
                .object({
                    enabled: this.joi.boolean().default(false),
                    prefix: this.joi.string().default(hassDefaultPrefix),
                    discovery: this.joi.boolean().when('enabled', {
                        is: true,
                        then: this.joi.boolean().default(true),
                    }),
                    discovery_entities: this.joi
                        .string()
                        .valid('all', 'summary')
                        .default('all'),
                    deviceid: this.joi.string().default('wud'),
                    devicename: this.joi.string().default('wud'),
                    release_summary: this.joi.boolean().default(false),
                    github_token: this.joi.string(),
                })
                .default({
                    enabled: false,
                    prefix: hassDefaultPrefix,
                    discovery: false,
                    discovery_entities: 'all',
                    deviceid: 'wud',
                    devicename: 'wud',
                    release_summary: false,
                }),
            tls: this.joi
                .object({
                    clientkey: this.joi.string(),
                    clientcert: this.joi.string(),
                    cachain: this.joi.string(),
                    rejectunauthorized: this.joi.boolean().default(true),
                })
                .default({
                    clientkey: undefined,
                    clientcert: undefined,
                    cachain: undefined,
                    rejectunauthorized: true,
                }),
        });
    }

    declare configuration: MqqtConfiguration;

    /**
     * Validate the configuration (accepting the env var form of the hass keys).
     */
    validateConfiguration(
        configuration: TriggerConfiguration,
    ): TriggerConfiguration {
        return super.validateConfiguration(
            normalizeHassConfiguration(configuration),
        );
    }

    /**
     * Sanitize sensitive data
     * @returns {*}
     */
    maskConfiguration() {
        return {
            ...this.configuration,
            url: this.configuration.url,
            topic: this.configuration.topic,
            user: this.configuration.user,
            password: Mqtt.mask(this.configuration.password),
            hass: this.configuration.hass?.github_token
                ? {
                      ...this.configuration.hass,
                      github_token: Mqtt.mask(
                          this.configuration.hass.github_token,
                      ),
                  }
                : this.configuration.hass,
        };
    }

    private hass: Hass;
    private client: MqttClient;

    async initTrigger() {
        // Enforce simple mode
        this.configuration.mode = 'simple';

        if (this.configuration.hass.enabled) {
            this.hass = new Hass({
                configuration: this.configuration,
                log: this.log,
            });
        }

        // Set MQTT connection options and create client
        const options: IClientOptions = {
            clientId: this.configuration.clientid,
        };
        if (this.configuration.user) {
            options.username = this.configuration.user;
        }
        if (this.configuration.password) {
            options.password = this.configuration.password;
        }
        if (this.configuration.tls.clientkey) {
            options.key = await fs.readFile(this.configuration.tls.clientkey);
        }
        if (this.configuration.tls.clientcert) {
            options.cert = await fs.readFile(this.configuration.tls.clientcert);
        }
        if (this.configuration.tls.cachain) {
            options.ca = [await fs.readFile(this.configuration.tls.cachain)];
        }
        options.rejectUnauthorized = this.configuration.tls.rejectunauthorized;
        options.manualConnect = true;
        options.reconnectPeriod = 10000; // Reconnect every 10 seconds
        if (this.hass && !isOneshot()) {
            options.will = this.hass.getWill();
        }
        this.client = mqtt.connect(this.configuration.url, options);

        // Register MQTT connection event handlers
        this.client.on('connect', () => {
            this.log.debug('MQTT client connected');
            if (this.hass && !isOneshot()) {
                this.hass.updateConnectionStatusSensor(true);
            }
        });

        this.client.on('reconnect', () => {
            this.log.debug('MQTT client reconnecting');
        });

        this.client.on('close', () => {
            this.log.debug('MQTT connection closed');
        });

        this.client.on('disconnect', (packet) => {
            this.log.debug(
                `MQTT client disconnected, reasonCode: ${packet?.reasonCode}`,
            );
        });

        this.client.on('error', (error: mqtt.ErrorWithReasonCode) => {
            const message =
                error?.code &&
                error?.message &&
                !error.message.includes(error.code.toString())
                    ? `${error.message} (${error.code})`
                    : error?.message || error?.code || error;
            this.log.error(`MQTT client error (${message})`);
        });

        this.client.on('end', () => {
            this.log.debug('MQTT client ended');
        });

        // Start MQTT client and initialize HA integration if enabled
        this.client.connect();
        if (this.hass) {
            this.hass.init(this.client);
        }
        registerContainerAdded((container) => this.trigger(container));
        registerContainerUpdated((container) => this.trigger(container));
    }

    /**
     * Send an MQTT message with new image version details.
     *
     * @param container the container
     */
    async trigger(container: Container) {
        if (!this.client || !this.client.connected) {
            throw new Error('MQTT client is not connected');
        }
        const containerTopic = getContainerTopic({
            baseTopic: this.configuration.topic,
            container,
        });

        // Only wait for GitHub when the release summary is enabled so that the
        // default behaviour (and its timing) stays strictly unchanged.
        const { hass } = this.configuration;
        const releaseSummary = isReleaseSummaryEnabled(hass)
            ? await getReleaseSummary(container, {
                  token: hass.github_token,
                  log: this.log,
              })
            : undefined;

        this.log.debug(`Publish container result to ${containerTopic}`);
        return new Promise<void>((resolve, reject) => {
            this.client.publish(
                containerTopic,
                JSON.stringify({
                    ...flatten(container),
                    release_summary: releaseSummary,
                }),
                {
                    retain: true,
                },
                (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                },
            );
        });
    }

    /**
     * Mqtt trigger does not support batch mode.
     */

    async triggerBatch() {
        throw new Error('This trigger does not support "batch" mode');
    }

    /**
     * This trigger supports rollback notifications.
     */
    supportsRollbackNotifications(): boolean {
        return true;
    }

    /**
     * Publish a rollback report on the `<topic>/rollback` MQTT topic.
     * @param rollbackReport the rollback report
     */
    async triggerRollback(rollbackReport: RollbackReport) {
        const rollbackTopic = `${this.configuration.topic}/rollback`;
        this.log.debug(`Publish rollback report to ${rollbackTopic}`);
        this.client.publish(rollbackTopic, JSON.stringify(rollbackReport));
    }

    /**
     * Deregister the component
     */
    async deregisterComponent(): Promise<void> {
        if (this.hass && !isOneshot()) {
            this.hass.updateConnectionStatusSensor(false);
        }
        this.client.end(true);
    }
}

export default Mqtt;
