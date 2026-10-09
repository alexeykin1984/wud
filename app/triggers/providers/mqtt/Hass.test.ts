// @ts-nocheck
import log from '../../../log';
import Hass from './Hass';
import * as containerStore from '../../../store/container';
import * as registry from '../../../registry';
import axios from 'axios';
import { flatten } from '../../../model/container';
import { clearReleaseSummaryCache, getReleaseSummary } from './GithubRelease';

jest.mock('axios');

jest.mock('../../../configuration', () => ({
    ...jest.requireActual('../../../configuration'),
    getVersion: () => 'unknown',
}));

const containerData = [
    {
        containerName: 'container-name',
        data: {
            discoveryTopic:
                'homeassistant/update/topic_watcher-name_container-name/config',
            unique_id: 'topic_watcher-name_container-name',
            default_entity_id: 'update.topic_watcher-name_container-name',
            name: 'topic_watcher-name_container-name',
            topic: 'topic/watcher-name/container-name',
        },
    },
    {
        containerName: 'container-1.name',
        data: {
            discoveryTopic:
                'homeassistant/update/topic_watcher-name_container-1-name/config',
            unique_id: 'topic_watcher-name_container-1-name',
            default_entity_id: 'update.topic_watcher-name_container-1-name',
            name: 'topic_watcher-name_container-1-name',
            topic: 'topic/watcher-name/container-1-name',
        },
    },
];

let hass;
let mqttClientMock;
let messageHandler;

beforeEach(async () => {
    jest.resetAllMocks();
    messageHandler = undefined;
    mqttClientMock = {
        publish: jest.fn(() => {}),
        subscribe: jest.fn(),
        on: jest.fn((event, handler) => {
            if (event === 'message') {
                messageHandler = handler;
            }
        }),
    };
    hass = new Hass({
        configuration: {
            topic: 'topic',
            hass: {
                discovery: true,
                prefix: 'homeassistant',
                devicename: 'wud',
                deviceid: 'wud',
            },
        },
        log,
    });
    await hass.init(mqttClientMock);
});

test('init must subscribe to install topic pattern', () => {
    expect(mqttClientMock.subscribe).toHaveBeenCalledWith('topic/+/+/install');
});

test('init in oneshot mode must not subscribe to install topic pattern', async () => {
    const originalEnv = process.env.WUD_RUN_MODE;
    process.env.WUD_RUN_MODE = 'oneshot';
    try {
        const oneshotClientMock = {
            publish: jest.fn(),
            subscribe: jest.fn(),
            on: jest.fn(),
        };
        const oneshotHass = new Hass({
            configuration: {
                topic: 'topic',
                hass: {
                    discovery: true,
                    prefix: 'homeassistant',
                    devicename: 'wud',
                    deviceid: 'wud',
                },
            },
            log,
        });
        await oneshotHass.init(oneshotClientMock);
        expect(oneshotClientMock.subscribe).not.toHaveBeenCalled();
    } finally {
        if (originalEnv === undefined) {
            delete process.env.WUD_RUN_MODE;
        } else {
            process.env.WUD_RUN_MODE = originalEnv;
        }
    }
});

test('publishDiscoveryMessage must publish a discovery message expected by HA', async () => {
    await hass.publishDiscoveryMessage({
        discoveryTopic: 'my/discovery',
        stateTopic: 'my/state',
        kind: 'sensor',
        name: 'My state',
        options: {
            myOption: true,
        },
    });
    expect(mqttClientMock.publish).toHaveBeenCalledWith(
        'my/discovery',
        JSON.stringify({
            unique_id: 'my_state',
            default_entity_id: 'sensor.my_state',
            name: 'My state',
            device: {
                identifiers: ['wud'],
                manufacturer: 'wud',
                model: 'wud',
                name: 'wud',
                sw_version: 'unknown',
            },
            icon: 'mdi:docker',
            state_topic: 'my/state',
            myOption: true,
        }),
        { retain: true },
    );
});

test('publishDiscoveryMessage must sanitize entity id with special characters', async () => {
    await hass.publishDiscoveryMessage({
        discoveryTopic: 'my/discovery',
        stateTopic: 'my/state.with:special@chars',
        kind: 'sensor',
    });
    const discoveryPayload = JSON.parse(
        mqttClientMock.publish.mock.calls[0][1],
    );
    expect(discoveryPayload.unique_id).toEqual('my_state_with_special_chars');
    expect(discoveryPayload.default_entity_id).toEqual(
        'sensor.my_state_with_special_chars',
    );
});

test('publishDiscoveryMessage must use the configured device id and name', async () => {
    const configuredHass = new Hass({
        configuration: {
            topic: 'topic',
            hass: {
                discovery: true,
                prefix: 'homeassistant',
                deviceid: 'custom-device-id',
                devicename: 'Custom Device Name',
            },
        },
        log,
    });
    await configuredHass.init(mqttClientMock);

    await configuredHass.publishDiscoveryMessage({
        discoveryTopic: 'my/discovery',
        stateTopic: 'my/state',
        kind: 'sensor',
        name: 'My state',
    });

    const discoveryPayload = JSON.parse(
        mqttClientMock.publish.mock.calls[0][1],
    );
    expect(discoveryPayload.device).toEqual({
        identifiers: ['custom-device-id'],
        manufacturer: 'wud',
        model: 'custom-device-id',
        name: 'Custom Device Name',
        sw_version: 'unknown',
    });
});

test('addContainerSensor must publish sensor discovery message expected by HA', async () => {
    await hass.addContainerSensor({
        name: 'container-name',
        watcher: 'watcher-name',
        displayIcon: 'mdi:docker',
    });
    expect(mqttClientMock.publish).toHaveBeenCalledWith(
        'homeassistant/update/topic_watcher-name_container-name/config',
        JSON.stringify({
            unique_id: 'topic_watcher-name_container-name',
            default_entity_id: 'update.topic_watcher-name_container-name',
            name: 'topic_watcher-name_container-name',
            device: {
                identifiers: ['wud_watcher-name'],
                manufacturer: 'wud',
                model: 'Watcher watcher-name',
                name: 'wud (watcher-name)',
                sw_version: 'unknown',
            },
            icon: 'mdi:docker',
            state_topic: 'topic/watcher-name/container-name',
            force_update: true,
            value_template: '{{ value_json.image_tag_value }}',
            latest_version_topic: 'topic/watcher-name/container-name',
            latest_version_template:
                '{% if value_json.update_kind_kind == "digest" %}{{ value_json.result_digest[:15] }}{% elif value_json.result_tag is defined %}{{ value_json.result_tag }}{% elif value_json.result_digest is defined %}{{ value_json.result_digest[:15] }}{% else %}{{ value_json.image_tag_value }}{% endif %}',
            command_topic: 'topic/watcher-name/container-name/install',
            payload_install: 'INSTALL',
            in_progress_template:
                '{{ value_json.in_progress | default(false) }}',
            json_attributes_topic: 'topic/watcher-name/container-name',
        }),
        { retain: true },
    );
});

test('addContainerSensor must publish the container display name as title', async () => {
    await hass.addContainerSensor({
        name: 'container-name',
        displayName: 'my-container',
        watcher: 'watcher-name',
        displayIcon: 'mdi:docker',
    });
    const discoveryPayload = JSON.parse(
        mqttClientMock.publish.mock.calls[0][1],
    );

    // `name` drives the entity name; `title` is what the HA Updates page shows
    // as supporting text, since the headline is the (shared) device name.
    expect(discoveryPayload.name).toEqual('my-container');
    expect(discoveryPayload.title).toEqual('my-container');
});

test.each(containerData)(
    'removeContainerSensor must publish empty payloads on state and discovery topics expected by HA',
    async ({ containerName, data }) => {
        await hass.removeContainerSensor({
            name: containerName,
            watcher: 'watcher-name',
            displayIcon: 'mdi:docker',
        });
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            1,
            data.topic,
            '',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            2,
            data.discoveryTopic,
            '',
            { retain: true },
        );
    },
);

test.each(containerData)(
    'updateContainerSensors must publish all sensors expected by HA',
    async ({ containerName }) => {
        await hass.updateContainerSensors({
            name: containerName,
            watcher: 'watcher-name',
            displayIcon: 'mdi:docker',
        });
        expect(mqttClientMock.publish).toHaveBeenCalledTimes(15);

        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            1,
            'homeassistant/sensor/topic_total_count/config',
            JSON.stringify({
                unique_id: 'topic_total_count',
                default_entity_id: 'sensor.topic_total_count',
                name: 'Total container count',
                device: {
                    identifiers: ['wud'],
                    manufacturer: 'wud',
                    model: 'wud',
                    name: 'wud',
                    sw_version: 'unknown',
                },
                icon: 'mdi:docker',
                state_topic: 'topic/total_count',
            }),
            { retain: true },
        );

        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            2,
            'homeassistant/sensor/topic_update_count/config',
            JSON.stringify({
                unique_id: 'topic_update_count',
                default_entity_id: 'sensor.topic_update_count',
                name: 'Total container update count',
                device: {
                    identifiers: ['wud'],
                    manufacturer: 'wud',
                    model: 'wud',
                    name: 'wud',
                    sw_version: 'unknown',
                },
                icon: 'mdi:docker',
                state_topic: 'topic/update_count',
            }),
            { retain: true },
        );

        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            3,
            'homeassistant/binary_sensor/topic_update_status/config',
            JSON.stringify({
                unique_id: 'topic_update_status',
                default_entity_id: 'binary_sensor.topic_update_status',
                name: 'Total container update status',
                device: {
                    identifiers: ['wud'],
                    manufacturer: 'wud',
                    model: 'wud',
                    name: 'wud',
                    sw_version: 'unknown',
                },
                icon: 'mdi:docker',
                state_topic: 'topic/update_status',
                payload_on: 'true',
                payload_off: 'false',
            }),
            { retain: true },
        );

        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            4,
            'homeassistant/sensor/topic_watcher-name_total_count/config',
            JSON.stringify({
                unique_id: 'topic_watcher-name_total_count',
                default_entity_id: 'sensor.topic_watcher-name_total_count',
                name: 'Watcher watcher-name container count',
                device: {
                    identifiers: ['wud_watcher-name'],
                    manufacturer: 'wud',
                    model: 'Watcher watcher-name',
                    name: 'wud (watcher-name)',
                    sw_version: 'unknown',
                },
                icon: 'mdi:docker',
                state_topic: 'topic/watcher-name/total_count',
            }),
            { retain: true },
        );

        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            5,
            'homeassistant/sensor/topic_watcher-name_update_count/config',
            JSON.stringify({
                unique_id: 'topic_watcher-name_update_count',
                default_entity_id: 'sensor.topic_watcher-name_update_count',
                name: 'Watcher watcher-name container update count',
                device: {
                    identifiers: ['wud_watcher-name'],
                    manufacturer: 'wud',
                    model: 'Watcher watcher-name',
                    name: 'wud (watcher-name)',
                    sw_version: 'unknown',
                },
                icon: 'mdi:docker',
                state_topic: 'topic/watcher-name/update_count',
            }),
            { retain: true },
        );

        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            6,
            'homeassistant/binary_sensor/topic_watcher-name_update_status/config',
            JSON.stringify({
                unique_id: 'topic_watcher-name_update_status',
                default_entity_id:
                    'binary_sensor.topic_watcher-name_update_status',
                name: 'Watcher watcher-name container update status',
                device: {
                    identifiers: ['wud_watcher-name'],
                    manufacturer: 'wud',
                    model: 'Watcher watcher-name',
                    name: 'wud (watcher-name)',
                    sw_version: 'unknown',
                },
                icon: 'mdi:docker',
                state_topic: 'topic/watcher-name/update_status',
                payload_on: 'true',
                payload_off: 'false',
            }),
            { retain: true },
        );

        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            7,
            'topic/total_count',
            '0',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            8,
            'topic/update_count',
            '0',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            9,
            'topic/update_status',
            'false',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            10,
            'topic/watcher-name/total_count',
            '0',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            11,
            'topic/watcher-name/update_count',
            '0',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            12,
            'topic/watcher-name/update_status',
            'false',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            13,
            'homeassistant/sensor/topic_watcher-name_total_count/config',
            '',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            14,
            'homeassistant/sensor/topic_watcher-name_update_count/config',
            '',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenNthCalledWith(
            15,
            'homeassistant/binary_sensor/topic_watcher-name_update_status/config',
            '',
            { retain: true },
        );
    },
);

test('updateWatcherSensors must publish all watcher sensor messages expected by HA', async () => {
    await hass.updateWatcherSensors({
        watcher: {
            name: 'watcher-name',
        },
        isRunning: true,
    });
    expect(mqttClientMock.publish).toHaveBeenCalledWith(
        'homeassistant/binary_sensor/topic_watcher-name_running/config',
        JSON.stringify({
            unique_id: 'topic_watcher-name_running',
            default_entity_id: 'binary_sensor.topic_watcher-name_running',
            name: 'Watcher watcher-name running status',
            device: {
                identifiers: ['wud_watcher-name'],
                manufacturer: 'wud',
                model: 'Watcher watcher-name',
                name: 'wud (watcher-name)',
                sw_version: 'unknown',
            },
            icon: 'mdi:docker',
            state_topic: 'topic/watcher-name/running',
            payload_on: 'true',
            payload_off: 'false',
        }),
        { retain: true },
    );
});

describe('handleInstallCommand', () => {
    test('must trigger update and update in_progress flag', async () => {
        const mockContainer = {
            id: '1234567890ab',
            name: 'my-app',
            displayName: 'my-app',
            watcher: 'watcher-name',
        };
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            mockContainer,
        ]);
        jest.spyOn(containerStore, 'getContainer').mockReturnValue(
            mockContainer,
        );

        const dockerTriggerMock = {
            type: 'docker',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        const otherTriggerMock = {
            type: 'smtp',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        registry.getState().trigger = {
            docker: dockerTriggerMock,
            smtp: otherTriggerMock,
        };

        // Simulate incoming MQTT install command message
        await messageHandler(
            'topic/watcher-name/my-app/install',
            Buffer.from('INSTALL'),
        );

        // Should set in_progress: true first
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'topic/watcher-name/my-app',
            expect.stringContaining('"in_progress":true'),
            { retain: true },
        );

        // Should call docker trigger
        expect(dockerTriggerMock.trigger).toHaveBeenCalledWith(mockContainer);
        expect(otherTriggerMock.trigger).not.toHaveBeenCalled();

        // Should set in_progress: false in finally
        expect(mqttClientMock.publish).toHaveBeenLastCalledWith(
            'topic/watcher-name/my-app',
            expect.stringContaining('"in_progress":false'),
            { retain: true },
        );
    });

    test('must match container with dots replaced by dashes', async () => {
        const mockContainer = {
            id: '1234567890cd',
            name: 'my.dotted.app',
            displayName: 'my.dotted.app',
            watcher: 'watcher-name',
        };
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            mockContainer,
        ]);
        jest.spyOn(containerStore, 'getContainer').mockReturnValue(
            mockContainer,
        );

        const dockerComposeTriggerMock = {
            type: 'dockercompose',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        registry.getState().trigger = {
            compose: dockerComposeTriggerMock,
        };

        await messageHandler(
            'topic/watcher-name/my-dotted-app/install',
            Buffer.from('INSTALL'),
        );

        expect(dockerComposeTriggerMock.trigger).toHaveBeenCalledWith(
            mockContainer,
        );
    });

    test('should ignore messages if payload is not INSTALL', async () => {
        const mockContainer = {
            id: '1234567890ab',
            name: 'my-app',
            watcher: 'watcher-name',
        };
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            mockContainer,
        ]);
        const dockerTriggerMock = {
            type: 'docker',
            trigger: jest.fn(),
        };
        registry.getState().trigger = { docker: dockerTriggerMock };

        await messageHandler(
            'topic/watcher-name/my-app/install',
            Buffer.from('OTHER'),
        );
        expect(dockerTriggerMock.trigger).not.toHaveBeenCalled();
    });

    test('should ignore messages if topic does not match pattern', async () => {
        const mockContainer = {
            id: '1234567890ab',
            name: 'my-app',
            watcher: 'watcher-name',
        };
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            mockContainer,
        ]);
        const dockerTriggerMock = {
            type: 'docker',
            trigger: jest.fn(),
        };
        registry.getState().trigger = { docker: dockerTriggerMock };

        await messageHandler(
            'other/topic/watcher-name/my-app/install',
            Buffer.from('INSTALL'),
        );
        expect(dockerTriggerMock.trigger).not.toHaveBeenCalled();
    });

    test('should handle gracefully if container is not found', async () => {
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([]);
        const dockerTriggerMock = {
            type: 'docker',
            trigger: jest.fn(),
        };
        registry.getState().trigger = { docker: dockerTriggerMock };

        await messageHandler(
            'topic/watcher-name/unknown-app/install',
            Buffer.from('INSTALL'),
        );
        expect(dockerTriggerMock.trigger).not.toHaveBeenCalled();
    });

    test('must fire the associated command trigger when docker is excluded via wud.trigger.exclude', async () => {
        const mockContainer = {
            id: '1234567890ab',
            name: 'my-app',
            displayName: 'my-app',
            watcher: 'watcher-name',
            triggerExclude: 'docker.default',
        };
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            mockContainer,
        ]);
        jest.spyOn(containerStore, 'getContainer').mockReturnValue(
            mockContainer,
        );

        const dockerTriggerMock = {
            type: 'docker',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        const commandTriggerMock = {
            type: 'command',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        registry.getState().trigger = {
            'docker.default': dockerTriggerMock,
            'command.deploy': commandTriggerMock,
        };

        await messageHandler(
            'topic/watcher-name/my-app/install',
            Buffer.from('INSTALL'),
        );

        expect(commandTriggerMock.trigger).toHaveBeenCalledWith(mockContainer);
        expect(dockerTriggerMock.trigger).not.toHaveBeenCalled();
    });

    test('must fire a nomad trigger when it is the only associated update trigger', async () => {
        const mockContainer = {
            id: '1234567890ab',
            name: 'my-app',
            displayName: 'my-app',
            watcher: 'watcher-name',
        };
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            mockContainer,
        ]);
        jest.spyOn(containerStore, 'getContainer').mockReturnValue(
            mockContainer,
        );

        const nomadTriggerMock = {
            type: 'nomad',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        registry.getState().trigger = {
            'nomad.default': nomadTriggerMock,
        };

        await messageHandler(
            'topic/watcher-name/my-app/install',
            Buffer.from('INSTALL'),
        );

        expect(nomadTriggerMock.trigger).toHaveBeenCalledWith(mockContainer);
    });

    test('must still prefer a docker trigger over an associated command trigger by default', async () => {
        const mockContainer = {
            id: '1234567890ab',
            name: 'my-app',
            displayName: 'my-app',
            watcher: 'watcher-name',
        };
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            mockContainer,
        ]);
        jest.spyOn(containerStore, 'getContainer').mockReturnValue(
            mockContainer,
        );

        const dockerTriggerMock = {
            type: 'docker',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        const commandTriggerMock = {
            type: 'command',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        registry.getState().trigger = {
            'docker.default': dockerTriggerMock,
            'command.deploy': commandTriggerMock,
        };

        await messageHandler(
            'topic/watcher-name/my-app/install',
            Buffer.from('INSTALL'),
        );

        expect(dockerTriggerMock.trigger).toHaveBeenCalledWith(mockContainer);
        expect(commandTriggerMock.trigger).not.toHaveBeenCalled();
    });

    test('must not fire an opt-in trigger nor any other trigger when no update trigger is associated', async () => {
        const mockContainer = {
            id: '1234567890ab',
            name: 'my-app',
            displayName: 'my-app',
            watcher: 'watcher-name',
        };
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            mockContainer,
        ]);
        jest.spyOn(containerStore, 'getContainer').mockReturnValue(
            mockContainer,
        );

        const commandTriggerMock = {
            type: 'command',
            configuration: { includebydefault: false },
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        const smtpTriggerMock = {
            type: 'smtp',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        registry.getState().trigger = {
            'command.deploy': commandTriggerMock,
            'smtp.gmail': smtpTriggerMock,
        };

        await messageHandler(
            'topic/watcher-name/my-app/install',
            Buffer.from('INSTALL'),
        );

        expect(commandTriggerMock.trigger).not.toHaveBeenCalled();
        expect(smtpTriggerMock.trigger).not.toHaveBeenCalled();
    });

    test('must break a tie between two equally-associated command triggers by (type, name), not registration order', async () => {
        const mockContainer = {
            id: '1234567890ab',
            name: 'my-app',
            displayName: 'my-app',
            watcher: 'watcher-name',
        };
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            mockContainer,
        ]);
        jest.spyOn(containerStore, 'getContainer').mockReturnValue(
            mockContainer,
        );

        const testfix2Mock = {
            type: 'command',
            name: 'testfix2',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        const testfixMock = {
            type: 'command',
            name: 'testfix',
            trigger: jest.fn().mockResolvedValue(undefined),
        };
        // Registered out of alphabetical order on purpose, mirroring the
        // registry's actual (registration-order) iteration order rather
        // than declaration order, to prove the tie-break sorts rather than
        // just taking whichever key comes first in the object literal.
        registry.getState().trigger = {
            'command.testfix2': testfix2Mock,
            'command.testfix': testfixMock,
        };

        await messageHandler(
            'topic/watcher-name/my-app/install',
            Buffer.from('INSTALL'),
        );

        expect(testfixMock.trigger).toHaveBeenCalledWith(mockContainer);
        expect(testfix2Mock.trigger).not.toHaveBeenCalled();
    });
});

describe('discovery_entities: summary', () => {
    let summaryHass;

    beforeEach(async () => {
        summaryHass = new Hass({
            configuration: {
                topic: 'topic',
                hass: {
                    discovery: true,
                    discovery_entities: 'summary',
                    prefix: 'homeassistant',
                    devicename: 'wud',
                    deviceid: 'wud',
                },
            },
            log,
        });
        await summaryHass.init(mqttClientMock);
        mqttClientMock.publish.mockClear();
    });

    test('publishSummaryUpdates must publish empty array when no containers have updates', async () => {
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            {
                name: 'app1',
                updateAvailable: false,
            },
        ]);

        await summaryHass.publishSummaryUpdates();

        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'topic/updates',
            '[]',
            { retain: true },
        );
    });

    test('publishSummaryUpdates must publish formatted summary items for containers with updates', async () => {
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([
            {
                name: 'app1',
                displayName: 'App One',
                watcher: 'local',
                stack: 'my-stack',
                updateAvailable: true,
                updateKind: {
                    kind: 'tag',
                    localValue: '1.0.0',
                    remoteValue: '1.1.0',
                    semverDiff: 'minor',
                },
                result: {
                    link: 'https://github.com/release/1.1.0',
                },
            },
            {
                name: 'app2',
                displayName: 'app2',
                watcher: 'remote',
                labels: {
                    'com.docker.compose.project': 'compose-stack',
                },
                updateAvailable: true,
                updateKind: {
                    kind: 'digest',
                    localValue: 'sha256:11111111111111111111',
                    remoteValue: 'sha256:22222222222222222222',
                },
            },
            {
                name: 'app3',
                updateAvailable: false,
            },
        ]);

        await summaryHass.publishSummaryUpdates();

        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'topic/updates',
            JSON.stringify([
                {
                    name: 'app1',
                    displayName: 'App One',
                    kind: 'tag',
                    localValue: '1.0.0',
                    remoteValue: '1.1.0',
                    watcher: 'local',
                    stack: 'my-stack',
                    semverDiff: 'minor',
                    link: 'https://github.com/release/1.1.0',
                },
                {
                    name: 'app2',
                    displayName: 'app2',
                    kind: 'digest',
                    localValue: 'sha256:11111111111111111111',
                    remoteValue: 'sha256:22222222222222222222',
                    watcher: 'remote',
                    stack: 'compose-stack',
                },
            ]),
            { retain: true },
        );
    });

    test('addContainerSensor in summary mode must remove per-container update entity and refresh summary', async () => {
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([]);

        await summaryHass.addContainerSensor({
            name: 'my-app',
            watcher: 'local',
        });

        // Must remove the update entity discovery config
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/update/topic_local_my-app/config',
            '',
            { retain: true },
        );
        // Must NOT publish container update config
        const updateConfigCalls = mqttClientMock.publish.mock.calls.filter(
            ([topic, payload]) =>
                topic.includes('homeassistant/update/') && payload !== '',
        );
        expect(updateConfigCalls).toHaveLength(0);
    });

    test('removeContainerSensor in summary mode must clear container state and discovery topic and update summary', async () => {
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([]);

        await summaryHass.removeContainerSensor({
            name: 'my-app',
            watcher: 'local',
        });

        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'topic/local/my-app',
            '',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/update/topic_local_my-app/config',
            '',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'topic/updates',
            '[]',
            { retain: true },
        );
    });

    test('updateContainerSensors in summary mode must publish summary sensor and remove watcher sensors', async () => {
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([]);

        await summaryHass.updateContainerSensors({
            name: 'my-app',
            watcher: 'local',
        });

        // Global sensors discovery (total_count, total_update_count, total_update_status)
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/sensor/topic_total_count/config',
            expect.any(String),
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/sensor/topic_update_count/config',
            expect.any(String),
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/binary_sensor/topic_update_status/config',
            expect.any(String),
            { retain: true },
        );

        // Discovered summary sensor: sensor.wud_updates
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/sensor/topic_updates/config',
            JSON.stringify({
                unique_id: 'topic_updates',
                default_entity_id: 'sensor.wud_updates',
                name: 'updates',
                device: {
                    identifiers: ['wud'],
                    manufacturer: 'wud',
                    model: 'wud',
                    name: 'wud',
                    sw_version: 'unknown',
                },
                icon: 'mdi:package-up',
                state_topic: 'topic/update_count',
                json_attributes_topic: 'topic/updates',
                json_attributes_template:
                    "{{ {'updates': value_json} | tojson }}",
            }),
            { retain: true },
        );

        // Cleans up watcher sensors
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/sensor/topic_local_total_count/config',
            '',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/sensor/topic_local_update_count/config',
            '',
            { retain: true },
        );
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/binary_sensor/topic_local_update_status/config',
            '',
            { retain: true },
        );

        // Must NOT publish watcher sensor configs
        const watcherConfigs = mqttClientMock.publish.mock.calls.filter(
            ([topic, payload]) =>
                topic.includes('topic_local_') && payload !== '',
        );
        expect(watcherConfigs).toHaveLength(0);

        // Publishes summary payload to topic/updates
        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'topic/updates',
            '[]',
            { retain: true },
        );
    });

    test('updateWatcherSensors in summary mode must remove watcher status sensor', async () => {
        await summaryHass.updateWatcherSensors({
            watcher: {
                name: 'local',
            },
            isRunning: true,
        });

        expect(mqttClientMock.publish).toHaveBeenCalledWith(
            'homeassistant/binary_sensor/topic_local_running/config',
            '',
            { retain: true },
        );
        // Must not publish watcher status sensor payload or discovery config
        const nonDeleteCalls = mqttClientMock.publish.mock.calls.filter(
            ([, payload]) => payload !== '',
        );
        expect(nonDeleteCalls).toHaveLength(0);
    });
});

describe('release summary', () => {
    const releaseContainer = {
        id: 'container-id',
        name: 'container-name',
        displayName: 'My container',
        displayIcon: 'mdi:docker',
        watcher: 'watcher-name',
        updateAvailable: true,
        updateKind: { kind: 'tag', localValue: '1.0.0', remoteValue: '1.1.0' },
        labels: {
            'org.opencontainers.image.source': 'https://github.com/owner/repo',
        },
        image: {
            registry: { url: 'https://ghcr.io/v2' },
            name: 'owner/repo',
            tag: { value: '1.0.0', semver: true },
        },
        result: {
            tag: '1.1.0',
            link: 'https://github.com/owner/repo/releases/tag/1.1.0',
        },
    };
    const discoveryTopic =
        'homeassistant/update/topic_watcher-name_container-name/config';
    const stateTopic = 'topic/watcher-name/container-name';

    function getPublished(topic) {
        return mqttClientMock.publish.mock.calls
            .filter(([publishedTopic]) => publishedTopic === topic)
            .map(([, payload]) => payload);
    }

    function enableReleaseSummary(hassOverrides = {}) {
        hass.configuration.hass = {
            ...hass.configuration.hass,
            enabled: true,
            release_summary: true,
            ...hassOverrides,
        };
    }

    beforeEach(() => {
        clearReleaseSummaryCache();
        axios.get = jest.fn().mockResolvedValue({
            status: 200,
            data: { body: '## Changes\n- fix' },
            headers: {},
        });
        mqttClientMock.publish.mockClear();
    });

    test.each([
        [{}],
        [{ enabled: true }],
        [{ enabled: true, release_summary: false, github_token: 'token' }],
        [{ enabled: false, release_summary: true }],
    ])(
        'addContainerSensor must not call GitHub nor publish a release summary when hass options are %j',
        async (hassOverrides) => {
            hass.configuration.hass = {
                ...hass.configuration.hass,
                ...hassOverrides,
            };
            await hass.addContainerSensor(releaseContainer);
            expect(axios.get).not.toHaveBeenCalled();
            const [discovery] = getPublished(discoveryTopic);
            expect(discovery).not.toContain('release_summary');
            expect(Object.keys(JSON.parse(discovery)).slice(-3)).toEqual([
                'in_progress_template',
                'release_url',
                'json_attributes_topic',
            ]);
        },
    );

    test('addContainerSensor must publish synchronously when the release summary is disabled', () => {
        hass.addContainerSensor(releaseContainer);
        expect(getPublished(discoveryTopic)).toHaveLength(1);
    });

    test('addContainerSensor must publish the release summary next to the release url when enabled', async () => {
        enableReleaseSummary({ github_token: 'ghp_secret' });
        await hass.addContainerSensor(releaseContainer);
        expect(axios.get).toHaveBeenCalledTimes(1);
        expect(axios.get).toHaveBeenCalledWith(
            'https://api.github.com/repos/owner/repo/releases/tags/1.1.0',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer ghp_secret',
                }),
            }),
        );
        const discovery = JSON.parse(getPublished(discoveryTopic)[0]);
        expect(discovery.release_url).toBe(
            'https://github.com/owner/repo/releases/tag/1.1.0',
        );
        expect(discovery.release_summary).toBe('## Changes\n- fix');
        expect(Object.keys(discovery).slice(-3)).toEqual([
            'release_url',
            'release_summary',
            'json_attributes_topic',
        ]);
    });

    test.each([
        [
            'GitHub is unreachable',
            () => axios.get.mockRejectedValue(new Error('ECONNREFUSED')),
            releaseContainer,
        ],
        [
            'the release does not exist',
            () =>
                axios.get.mockResolvedValue({
                    status: 404,
                    data: {},
                    headers: {},
                }),
            releaseContainer,
        ],
        [
            'the update is a digest update',
            () => undefined,
            { ...releaseContainer, updateKind: { kind: 'digest' } },
        ],
    ])(
        'addContainerSensor must omit the release summary when %s',
        async (_label, mockGithub, container) => {
            mockGithub();
            enableReleaseSummary();
            hass.log = { info: jest.fn(), debug: jest.fn(), warn: jest.fn() };
            await hass.addContainerSensor(container);
            const discoveries = getPublished(discoveryTopic);
            expect(discoveries).toHaveLength(1);
            expect(discoveries[0]).not.toContain('release_summary');
            expect(JSON.parse(discoveries[0]).json_attributes_topic).toBe(
                stateTopic,
            );
        },
    );

    test('addContainerSensor must not call GitHub when discovery is disabled', async () => {
        enableReleaseSummary({ discovery: false });
        await hass.addContainerSensor(releaseContainer);
        expect(axios.get).not.toHaveBeenCalled();
        expect(mqttClientMock.publish).not.toHaveBeenCalled();
    });

    test('addContainerSensor must not call GitHub in summary mode', async () => {
        enableReleaseSummary({ discovery_entities: 'summary' });
        jest.spyOn(containerStore, 'getContainers').mockReturnValue([]);
        await hass.addContainerSensor(releaseContainer);
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('removeContainerSensor must be published after the discovery still waiting for GitHub', async () => {
        enableReleaseSummary();
        let resolveRelease;
        axios.get.mockReturnValue(
            new Promise((resolve) => {
                resolveRelease = () =>
                    resolve({
                        status: 200,
                        data: { body: 'notes' },
                        headers: {},
                    });
            }),
        );
        const added = hass.addContainerSensor(releaseContainer);
        const removed = hass.removeContainerSensor(releaseContainer);
        await new Promise((resolve) => setImmediate(resolve));
        expect(mqttClientMock.publish).not.toHaveBeenCalled();

        resolveRelease();
        await Promise.all([added, removed]);
        expect(
            mqttClientMock.publish.mock.calls.map(([topic, payload]) => [
                topic,
                payload === '' ? 'removed' : 'published',
            ]),
        ).toEqual([
            [discoveryTopic, 'published'],
            [stateTopic, 'removed'],
            [discoveryTopic, 'removed'],
        ]);
    });

    test('removeContainerSensor must publish synchronously when the release summary is disabled', () => {
        hass.removeContainerSensor(releaseContainer);
        expect(getPublished(stateTopic)).toEqual(['']);
    });

    describe('handleInstallCommand', () => {
        beforeEach(() => {
            jest.spyOn(containerStore, 'getContainers').mockReturnValue([
                releaseContainer,
            ]);
            jest.spyOn(containerStore, 'getContainer').mockReturnValue(
                releaseContainer,
            );
            registry.getState().trigger = {
                docker: {
                    type: 'docker',
                    trigger: jest.fn().mockResolvedValue(undefined),
                },
            };
        });

        test('must publish unchanged payloads when the release summary is disabled', async () => {
            // Even when a summary is already cached by another trigger
            await getReleaseSummary(releaseContainer);
            axios.get.mockClear();

            await hass.handleInstallCommand(`${stateTopic}/install`);
            expect(axios.get).not.toHaveBeenCalled();
            expect(getPublished(stateTopic)).toEqual([
                JSON.stringify({
                    ...flatten(releaseContainer),
                    in_progress: true,
                }),
                JSON.stringify({
                    ...flatten(releaseContainer),
                    in_progress: false,
                }),
            ]);
        });

        test('must publish in_progress without waiting for GitHub when the summary is not cached', async () => {
            enableReleaseSummary();
            await hass.handleInstallCommand(`${stateTopic}/install`);
            expect(axios.get).not.toHaveBeenCalled();
            expect(getPublished(stateTopic)).toEqual([
                JSON.stringify({
                    ...flatten(releaseContainer),
                    in_progress: true,
                }),
                JSON.stringify({
                    ...flatten(releaseContainer),
                    in_progress: false,
                }),
            ]);
        });

        test('must publish the cached release summary in both state payloads', async () => {
            enableReleaseSummary();
            await hass.addContainerSensor(releaseContainer);
            axios.get.mockClear();

            await hass.handleInstallCommand(`${stateTopic}/install`);
            expect(axios.get).not.toHaveBeenCalled();
            expect(getPublished(stateTopic)).toEqual([
                JSON.stringify({
                    ...flatten(releaseContainer),
                    release_summary: '## Changes\n- fix',
                    in_progress: true,
                }),
                JSON.stringify({
                    ...flatten(releaseContainer),
                    release_summary: '## Changes\n- fix',
                    in_progress: false,
                }),
            ]);
        });

        test('must drop the release summary once the container is up to date', async () => {
            enableReleaseSummary();
            await hass.addContainerSensor(releaseContainer);
            const updatedContainer = {
                ...releaseContainer,
                updateAvailable: false,
                updateKind: { kind: 'unknown' },
            };
            containerStore.getContainer.mockReturnValue(updatedContainer);

            await hass.handleInstallCommand(`${stateTopic}/install`);
            const states = getPublished(stateTopic);
            expect(states[0]).toContain('"release_summary"');
            expect(states[1]).toBe(
                JSON.stringify({
                    ...flatten(updatedContainer),
                    in_progress: false,
                }),
            );
        });
    });
});
