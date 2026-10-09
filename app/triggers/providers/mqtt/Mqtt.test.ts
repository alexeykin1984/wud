//@ts-nocheck
import mqttClient from 'mqtt';
import axios from 'axios';
import log from '../../../log';
import { flatten } from '../../../model/container';

jest.mock('mqtt');
jest.mock('axios');
import Mqtt from './Mqtt';
import { clearReleaseSummaryCache } from './GithubRelease';
import { testTriggerProvider } from '../TriggerTestHelper';

const mqtt = new Mqtt();
mqtt.log = log;

const configurationValid = {
    url: 'mqtt://host:1883',
    topic: 'wud/container',
    clientid: 'wud',
    hass: {
        discovery: false,
        discovery_entities: 'all',
        enabled: false,
        prefix: 'homeassistant',
        deviceid: 'wud',
        devicename: 'wud',
        release_summary: false,
    },
    tls: {
        clientkey: undefined,
        clientcert: undefined,
        cachain: undefined,
        rejectunauthorized: true,
    },
    threshold: 'all',
    mode: 'simple',
    once: true,
    auto: true,
    simpletitle:
        'New ${container.updateKind.kind} found for container ${container.name}',

    simplebody:
        'Container ${container.name} running with ${container.updateKind.kind} ${container.updateKind.localValue} can be updated to ${container.updateKind.kind} ${container.updateKind.remoteValue}${container.result && container.result.link ? "\\n" + container.result.link : ""}',

    batchtitle: '${containers.length} updates available',
};

testTriggerProvider(Mqtt, configurationValid, { testTemplateRenders: false });

const containerData = [
    {
        containerName: 'homeassistant',
        data: {
            name: 'homeassistant',
            topic: 'wud/container/local/homeassistant',
        },
    },
    {
        containerName: 'home.assistant',
        data: {
            name: 'home.assistant',
            topic: 'wud/container/local/home-assistant',
        },
    },
];

beforeEach(async () => {
    jest.resetAllMocks();
    const mockClient = {
        connected: true,
        on: jest.fn(),
        publish: jest.fn((topic, message, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            if (cb) {
                cb();
            }
        }),
        subscribe: jest.fn(),
        unsubscribe: jest.fn(),
        end: jest.fn(),
        connect: jest.fn(),
    };
    mqtt.client = mockClient;
    mqttClient.connect = jest.fn(() => mockClient);
});

// generic tests removed in favor of testTriggerProvider

test('maskConfiguration should mask sensitive data', async () => {
    mqtt.configuration = {
        password: 'password',
        url: 'mqtt://host:1883',
        topic: 'wud/container',
        hass: {
            discovery: false,
            enabled: false,
            prefix: 'homeassistant',
        },
    };
    expect(mqtt.maskConfiguration()).toEqual({
        hass: {
            discovery: false,
            enabled: false,
            prefix: 'homeassistant',
        },
        password: 'p******d',
        topic: 'wud/container',
        url: 'mqtt://host:1883',
    });
});

test('initTrigger should init Mqtt client', async () => {
    mqtt.configuration = {
        ...configurationValid,
        user: 'user',
        password: 'password',
        clientid: 'wud',
        hass: {
            enabled: true,
            discovery: true,
            prefix: 'homeassistant',
        },
    };
    const spy = jest.spyOn(mqttClient, 'connect');
    await mqtt.initTrigger();
    expect(spy).toHaveBeenCalledWith('mqtt://host:1883', {
        clientId: 'wud',
        username: 'user',
        password: 'password',
        rejectUnauthorized: true,
        manualConnect: true,
        reconnectPeriod: 10000,
        will: {
            topic: 'wud/container/status',
            payload: 'offline',
            retain: true,
        },
    });
});

test.each(containerData)(
    'trigger should format json message payload as expected',
    async ({ containerName, data }) => {
        mqtt.configuration = {
            topic: 'wud/container',
        };
        const container = {
            id: '31a61a8305ef1fc9a71fa4f20a68d7ec88b28e32303bbc4a5f192e851165b816',
            name: containerName,
            watcher: 'local',
            includeTags: '^\\d+\\.\\d+.\\d+$',
            image: {
                id: 'sha256:d4a6fafb7d4da37495e5c9be3242590be24a87d7edcc4f79761098889c54fca6',
                registry: {
                    url: '123456789.dkr.ecr.eu-west-1.amazonaws.com',
                },
                name: 'test',
                tag: {
                    value: '2021.6.4',
                    semver: true,
                },
                digest: {
                    watch: false,
                    repo: 'sha256:ca0edc3fb0b4647963629bdfccbb3ccfa352184b45a9b4145832000c2878dd72',
                },
                architecture: 'amd64',
                os: 'linux',
                created: '2021-06-12T05:33:38.440Z',
            },
            result: {
                tag: '2021.6.5',
            },
        };
        await mqtt.trigger(container);
        expect(mqtt.client.publish).toHaveBeenCalledWith(
            data.topic,
            JSON.stringify(flatten(container)),
            { retain: true },
            expect.any(Function),
        );
    },
);

test('trigger should throw error when client is not connected', async () => {
    mqtt.client.connected = false;
    const container = {
        name: 'test',
        watcher: 'local',
    };
    await expect(mqtt.trigger(container)).rejects.toThrow(
        'MQTT client is not connected',
    );
});

test('trigger should throw error when client is undefined', async () => {
    mqtt.client = undefined;
    const container = {
        name: 'test',
        watcher: 'local',
    };
    await expect(mqtt.trigger(container)).rejects.toThrow(
        'MQTT client is not connected',
    );
});

test('trigger should reject when publish yields an error', async () => {
    mqtt.configuration = {
        topic: 'wud/container',
    };
    mqtt.client = {
        connected: true,
        publish: jest.fn((topic, message, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            if (cb) {
                cb(new Error('Publish failed'));
            }
        }),
    };
    const container = {
        name: 'test',
        watcher: 'local',
    };
    await expect(mqtt.trigger(container)).rejects.toThrow('Publish failed');
});

test('error event should log error message and code', async () => {
    mqtt.configuration = {
        ...configurationValid,
    };
    const errorSpy = jest.spyOn(mqtt.log, 'error').mockImplementation(() => {});
    await mqtt.initTrigger();
    const errorHandler = mqtt.client.on.mock.calls.find(
        ([event]) => event === 'error',
    )[1];

    errorHandler({
        name: 'Error',
        message: 'getaddrinfo ENOTFOUND mosquitto',
        code: 'ENOTFOUND',
    });
    expect(errorSpy).toHaveBeenCalledWith(
        'MQTT client error (getaddrinfo ENOTFOUND mosquitto)',
    );

    errorHandler({
        name: 'Error',
        message: 'certificate verify failed',
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
    });
    expect(errorSpy).toHaveBeenCalledWith(
        'MQTT client error (certificate verify failed (SELF_SIGNED_CERT_IN_CHAIN))',
    );

    errorHandler({
        code: 'ECONNREFUSED',
    });
    expect(errorSpy).toHaveBeenCalledWith('MQTT client error (ECONNREFUSED)');

    errorHandler(new Error('Generic failure'));
    expect(errorSpy).toHaveBeenCalledWith(
        'MQTT client error (Generic failure)',
    );
});

test('initTrigger in oneshot mode should not configure will or update connection sensor', async () => {
    const originalEnv = process.env.WUD_RUN_MODE;
    process.env.WUD_RUN_MODE = 'oneshot';
    try {
        mqtt.configuration = {
            ...configurationValid,
            user: 'user',
            password: 'password',
            clientid: 'wud',
            hass: {
                enabled: true,
                discovery: true,
                prefix: 'homeassistant',
            },
        };
        const spy = jest.spyOn(mqttClient, 'connect');
        await mqtt.initTrigger();
        expect(spy).toHaveBeenCalledWith('mqtt://host:1883', {
            clientId: 'wud',
            username: 'user',
            password: 'password',
            rejectUnauthorized: true,
            manualConnect: true,
            reconnectPeriod: 10000,
        });

        const updateConnectionStatusSpy = jest.spyOn(
            mqtt.hass,
            'updateConnectionStatusSensor',
        );

        // Simulate connect event
        const connectHandler = mqtt.client.on.mock.calls.find(
            ([event]) => event === 'connect',
        )[1];
        connectHandler();
        expect(updateConnectionStatusSpy).not.toHaveBeenCalled();

        // Deregister component
        await mqtt.deregisterComponent();
        expect(updateConnectionStatusSpy).not.toHaveBeenCalled();
    } finally {
        if (originalEnv === undefined) {
            delete process.env.WUD_RUN_MODE;
        } else {
            process.env.WUD_RUN_MODE = originalEnv;
        }
    }
});

test('connect event and deregisterComponent in server mode should update connection sensor', async () => {
    const originalEnv = process.env.WUD_RUN_MODE;
    delete process.env.WUD_RUN_MODE;
    try {
        mqtt.configuration = {
            ...configurationValid,
            user: 'user',
            password: 'password',
            clientid: 'wud',
            hass: {
                enabled: true,
                discovery: true,
                prefix: 'homeassistant',
            },
        };
        await mqtt.initTrigger();
        const updateConnectionStatusSpy = jest.spyOn(
            mqtt.hass,
            'updateConnectionStatusSensor',
        );

        // Simulate connect event
        const connectHandler = mqtt.client.on.mock.calls.find(
            ([event]) => event === 'connect',
        )[1];
        connectHandler();
        expect(updateConnectionStatusSpy).toHaveBeenCalledWith(true);

        // Deregister component
        await mqtt.deregisterComponent();
        expect(updateConnectionStatusSpy).toHaveBeenCalledWith(false);
    } finally {
        if (originalEnv === undefined) {
            delete process.env.WUD_RUN_MODE;
        } else {
            process.env.WUD_RUN_MODE = originalEnv;
        }
    }
});

test('triggerRollback should publish the rollback report on the rollback topic', async () => {
    mqtt.configuration = configurationValid;
    mqtt.client = { publish: jest.fn() };

    const report = {
        scope: 'container',
        container: { name: 'web' },
        status: 'succeeded',
    };

    await mqtt.triggerRollback(report);

    expect(mqtt.client.publish).toHaveBeenCalledWith(
        'wud/container/rollback',
        JSON.stringify(report),
    );
});

test('validateConfiguration should accept discovery_entities = summary', () => {
    const validated = mqtt.validateConfiguration({
        ...configurationValid,
        hass: {
            ...configurationValid.hass,
            discovery_entities: 'summary',
        },
    });
    expect(validated.hass.discovery_entities).toEqual('summary');
});

test('validateConfiguration should reject invalid discovery_entities', () => {
    expect(() => {
        mqtt.validateConfiguration({
            ...configurationValid,
            hass: {
                ...configurationValid.hass,
                discovery_entities: 'invalid',
            },
        });
    }).toThrow();
});

describe('hass release summary', () => {
    const releaseContainer = {
        id: 'container-id',
        name: 'homeassistant',
        watcher: 'local',
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
        result: { tag: '1.1.0' },
    };

    beforeEach(() => {
        clearReleaseSummaryCache();
        axios.get = jest.fn().mockResolvedValue({
            status: 200,
            data: { body: '## Changes\n- fix' },
            headers: {},
        });
    });

    test('validateConfiguration should disable the release summary by default', () => {
        const validated = mqtt.validateConfiguration({
            url: 'mqtt://host:1883',
        });
        expect(validated.hass).toEqual({
            enabled: false,
            prefix: 'homeassistant',
            discovery: false,
            discovery_entities: 'all',
            deviceid: 'wud',
            devicename: 'wud',
            release_summary: false,
        });

        const validatedWithHass = mqtt.validateConfiguration({
            url: 'mqtt://host:1883',
            hass: { enabled: true },
        });
        expect(validatedWithHass.hass.release_summary).toBe(false);
        expect(validatedWithHass.hass.github_token).toBeUndefined();
    });

    test('validateConfiguration should accept release_summary and github_token', () => {
        const validated = mqtt.validateConfiguration({
            url: 'mqtt://host:1883',
            hass: {
                enabled: 'true',
                release_summary: 'true',
                github_token: 'ghp_secret',
            },
        });
        expect(validated.hass.release_summary).toBe(true);
        expect(validated.hass.github_token).toBe('ghp_secret');
    });

    test('validateConfiguration should accept the keys as split from env vars', () => {
        // WUD_TRIGGER_MQTT_X_HASS_RELEASE_SUMMARY / ..._HASS_GITHUB_TOKEN
        const configuration = {
            url: 'mqtt://host:1883',
            hass: {
                enabled: 'true',
                release: { summary: 'true' },
                github: { token: 'ghp_secret' },
            },
        };
        const validated = mqtt.validateConfiguration(configuration);
        expect(validated.hass).toEqual({
            enabled: true,
            prefix: 'homeassistant',
            discovery: true,
            discovery_entities: 'all',
            deviceid: 'wud',
            devicename: 'wud',
            release_summary: true,
            github_token: 'ghp_secret',
        });
        // The given configuration is not mutated
        expect(configuration.hass.release).toEqual({ summary: 'true' });
    });

    test('validateConfiguration should accept only one of the keys as split from env vars', () => {
        expect(
            mqtt.validateConfiguration({
                url: 'mqtt://host:1883',
                hass: { release: { summary: 'true' } },
            }).hass.release_summary,
        ).toBe(true);
        expect(
            mqtt.validateConfiguration({
                url: 'mqtt://host:1883',
                hass: { github: { token: 'ghp_secret' } },
            }).hass,
        ).toMatchObject({ release_summary: false, github_token: 'ghp_secret' });
    });

    test('validateConfiguration should prefer the explicit keys over the split ones', () => {
        const validated = mqtt.validateConfiguration({
            url: 'mqtt://host:1883',
            hass: {
                release_summary: false,
                release: { summary: 'true' },
                github_token: 'explicit',
                github: { token: 'split' },
            },
        });
        expect(validated.hass.release_summary).toBe(false);
        expect(validated.hass.github_token).toBe('explicit');
    });

    test.each([
        [{ release_summary: 'not-a-boolean' }],
        [{ release: { summary: 'not-a-boolean' } }],
        [{ release: { summary: 'true', unknown: 'x' } }],
        [{ release: 'true' }],
        [{ github: { token: 'ghp_secret', unknown: 'x' } }],
        [{ github: 'ghp_secret', release: { summary: 'true' } }],
        [{ release: 'true', github: { token: 'ghp_secret' } }],
        [{ github_token: 42 }],
        [{ github: {}, release: { other: 'x' } }],
    ])('validateConfiguration should reject invalid hass %j', (hass) => {
        expect(() =>
            mqtt.validateConfiguration({ url: 'mqtt://host:1883', hass }),
        ).toThrow();
    });

    test('validateConfiguration should still reject a configuration which is not an object', () => {
        expect(() => mqtt.validateConfiguration('invalid')).toThrow();
        expect(() =>
            mqtt.validateConfiguration({
                url: 'mqtt://host:1883',
                hass: 'invalid',
            }),
        ).toThrow();
    });

    test('maskConfiguration should mask the github token', () => {
        mqtt.configuration = {
            password: 'password',
            url: 'mqtt://host:1883',
            topic: 'wud/container',
            hass: {
                enabled: true,
                release_summary: true,
                github_token: 'ghp_secret',
            },
        };
        expect(mqtt.maskConfiguration()).toEqual({
            hass: {
                enabled: true,
                release_summary: true,
                github_token: 'g********t',
            },
            password: 'p******d',
            topic: 'wud/container',
            url: 'mqtt://host:1883',
        });
        // The configuration itself keeps the token
        expect(mqtt.configuration.hass.github_token).toBe('ghp_secret');
    });

    test('maskConfiguration should not add a github token when there is none', () => {
        mqtt.configuration = {
            url: 'mqtt://host:1883',
            hass: { enabled: true, release_summary: true },
        };
        expect(mqtt.maskConfiguration().hass).toEqual({
            enabled: true,
            release_summary: true,
        });
        mqtt.configuration = { url: 'mqtt://host:1883' };
        expect(mqtt.maskConfiguration().hass).toBeUndefined();
    });

    test.each([
        [undefined],
        [{ enabled: false, release_summary: true, github_token: 'token' }],
        [{ enabled: true, release_summary: false, github_token: 'token' }],
        [{ enabled: true }],
    ])(
        'trigger should publish an unchanged payload and never call GitHub when hass is %j',
        async (hass) => {
            mqtt.configuration = { topic: 'wud/container', hass };
            await mqtt.trigger(releaseContainer);
            expect(axios.get).not.toHaveBeenCalled();
            expect(mqtt.client.publish).toHaveBeenCalledTimes(1);
            expect(mqtt.client.publish).toHaveBeenCalledWith(
                'wud/container/local/homeassistant',
                JSON.stringify(flatten(releaseContainer)),
                { retain: true },
                expect.any(Function),
            );
        },
    );

    test('trigger should publish synchronously when the release summary is disabled', () => {
        mqtt.configuration = {
            topic: 'wud/container',
            hass: { enabled: true },
        };
        mqtt.trigger(releaseContainer);
        expect(mqtt.client.publish).toHaveBeenCalledTimes(1);
    });

    test('trigger should add the release summary to the payload when enabled', async () => {
        mqtt.configuration = {
            topic: 'wud/container',
            hass: {
                enabled: true,
                release_summary: true,
                github_token: 'ghp_secret',
            },
        };
        await mqtt.trigger(releaseContainer);
        expect(axios.get).toHaveBeenCalledWith(
            'https://api.github.com/repos/owner/repo/releases/tags/1.1.0',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer ghp_secret',
                }),
            }),
        );
        expect(mqtt.client.publish).toHaveBeenCalledWith(
            'wud/container/local/homeassistant',
            JSON.stringify({
                ...flatten(releaseContainer),
                release_summary: '## Changes\n- fix',
            }),
            { retain: true },
            expect.any(Function),
        );
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
        'trigger should publish the payload without release summary when %s',
        async (_label, mockGithub, container) => {
            mockGithub();
            mqtt.configuration = {
                topic: 'wud/container',
                hass: { enabled: true, release_summary: true },
            };
            await mqtt.trigger(container);
            expect(mqtt.client.publish).toHaveBeenCalledWith(
                'wud/container/local/homeassistant',
                JSON.stringify(flatten(container)),
                { retain: true },
                expect.any(Function),
            );
        },
    );

    test('trigger should still reject publish errors when the release summary is enabled', async () => {
        mqtt.configuration = {
            topic: 'wud/container',
            hass: { enabled: true, release_summary: true },
        };
        mqtt.client.publish = jest.fn((topic, message, options, callback) =>
            callback(new Error('publish failed')),
        );
        await expect(mqtt.trigger(releaseContainer)).rejects.toThrow(
            'publish failed',
        );
    });
});
