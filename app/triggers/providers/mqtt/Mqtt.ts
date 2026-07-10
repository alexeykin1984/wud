// @ts-nocheck
import fs from 'fs/promises';
import mqtt from 'mqtt';
import Trigger from '../Trigger';
import * as registry from '../../../registry';
import Hass from './Hass';
import {
    registerContainerAdded,
    registerContainerUpdated,
} from '../../../event';
import { flatten } from '../../../model/container';
import logger from '../../../log';
import * as containerStore from '../../../store/container';
const log = logger.child({ component: 'Mqtt' });

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

/**
 * Return registered triggers.
 * @returns {{id: string}[]}
 */
function getTriggers() {
    return registry.getState().trigger;
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
                })
                .default({
                    enabled: false,
                    prefix: hassDefaultPrefix,
                    discovery: false,
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
            hass: this.configuration.hass,
        };
    }

    async initTrigger() {
        // Enforce simple mode
        this.configuration.mode = 'simple';

        const options = {
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

        this.client = await mqtt.connectAsync(this.configuration.url, options);
        if (this.configuration.hass.enabled) {
            this.hass = new Hass({
                client: this.client,
                configuration: this.configuration,
                log: this.log,
            });
        }
        if (this.client) {
            const updateTopic = `${this.configuration.topic}/local/update/#`;
            this.client.subscribe(updateTopic, (err) => {
                if (!err) {
                    log.info(`Подписка на топик "${updateTopic}" оформлена`);
                } else {
                    log.error('Ошибка при подписке:', err);
                }
            });

            this.client.on('message', (receivedTopic, message) => {
                this.handleMessage(receivedTopic, message);
            });
        }
        registerContainerAdded((container) => this.trigger(container));
        registerContainerUpdated((container) => this.trigger(container));
    }

    private handleMessage(receivedTopic: string, message: Buffer): void {
        const containerNameToUpdate = receivedTopic.split('/').at(-1);
        const isUpdate = message.toString();

        log.info(
            `Получено уведомление об обновлении [${containerNameToUpdate}]: ${isUpdate}`,
        );

        if (isUpdate) {
            this.executeTrigger({
                containerName: containerNameToUpdate,
                hass: this.hass,
            });
        }
    }

    async executeTrigger({ containerName, hass }) {
        const triggerType = 'dockercompose';
        const triggerName = 'app';
        log.info(
            `Ищу контейнер с именем ${containerName}. Список контейнеров:`,
        );
        containerStore
            .getContainers({})
            .forEach((container) => log.info(container.name));
        const containersToTrigger = containerStore.getContainers({
            name: containerName,
        });
        log.info(containersToTrigger);
        if (containersToTrigger) {
            log.info(containersToTrigger);
            const containerToTrigger = containersToTrigger[0];
            log.info(containerToTrigger);
            const triggerToRun = getTriggers()[`${triggerType}.${triggerName}`];
            if (triggerToRun) {
                try {
                    if (hass) {
                        this.setInstallInProgress(containerToTrigger);
                    }
                    await triggerToRun.trigger(containerToTrigger);
                    log.info(
                        `Trigger executed with success (type=${triggerType}, name=${triggerName}, container=${JSON.stringify(containerToTrigger)})`,
                    );
                } catch (e) {
                    log.warn(
                        `Error when running trigger ${triggerType}.${triggerName} (${e.message})`,
                    );
                }
            }
        }
    }

    async setInstallInProgress(container) {
        log.info(container);
        const containerTopic = getContainerTopic({
            baseTopic: this.configuration.topic,
            container,
        });
        this.log.debug(`Статус установки в HA ${containerTopic}`);
        await this.client.publish(
            containerTopic,
            JSON.stringify({
                ...flatten(container),
                in_progress: true,
            }),
            {
                retain: true,
            },
        );
    }

    /**
     * Send an MQTT message with new image version details.
     *
     * @param container the container
     * @returns {Promise}
     */
    async trigger(container) {
        const containerTopic = getContainerTopic({
            baseTopic: this.configuration.topic,
            container,
        });

        this.log.debug(`Publish container result to ${containerTopic}`);
        return this.client.publish(
            containerTopic,
            JSON.stringify(flatten(container)),
            {
                retain: true,
            },
        );
    }

    /**
     * Mqtt trigger does not support batch mode.
     * @returns {Promise<void>}
     */

    async triggerBatch() {
        throw new Error('This trigger does not support "batch" mode');
    }
}

export default Mqtt;
