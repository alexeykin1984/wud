// @ts-nocheck
import axios from 'axios';
import {
    clearReleaseSummaryCache,
    getCachedHassReleaseSummary,
    getCachedReleaseSummary,
    getReleaseSummary,
    isReleaseSummaryEnabled,
    parseGithubRepository,
    resolveGithubRepository,
    toReleaseSummary,
    whenReleaseSummariesSettled,
} from './GithubRelease';

jest.mock('axios');

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function createContainer(overrides = {}) {
    return {
        id: 'container-id',
        name: 'my-app',
        watcher: 'local',
        updateAvailable: true,
        updateKind: { kind: 'tag', localValue: '1.0.0', remoteValue: '1.1.0' },
        labels: {
            'org.opencontainers.image.source': 'https://github.com/owner/repo',
        },
        image: {
            registry: { name: 'hub', url: 'https://registry-1.docker.io/v2' },
            name: 'owner/repo',
            tag: { value: '1.0.0', semver: true },
        },
        result: { tag: '1.1.0' },
        ...overrides,
    };
}

function release(body, name = undefined) {
    return { status: 200, data: { body, name }, headers: {} };
}

const notFound = { status: 404, data: { message: 'Not Found' }, headers: {} };

let log;

beforeEach(() => {
    jest.resetAllMocks();
    jest.useRealTimers();
    clearReleaseSummaryCache();
    log = { debug: jest.fn(), warn: jest.fn() };
});

afterEach(() => {
    jest.useRealTimers();
});

describe('isReleaseSummaryEnabled', () => {
    test.each([
        [undefined, false],
        [{}, false],
        [{ enabled: true }, false],
        [{ enabled: true, release_summary: false }, false],
        [{ enabled: false, release_summary: true }, false],
        [{ enabled: true, release_summary: true }, true],
    ])('%j must give %s', (hass, expected) => {
        expect(isReleaseSummaryEnabled(hass)).toBe(expected);
    });
});

describe('parseGithubRepository', () => {
    test.each([
        ['https://github.com/owner/repo', 'owner', 'repo'],
        ['https://github.com/owner/repo/', 'owner', 'repo'],
        ['https://github.com/owner/repo.git', 'owner', 'repo'],
        ['https://github.com/owner/repo.git/', 'owner', 'repo'],
        ['http://github.com/owner/repo', 'owner', 'repo'],
        ['git+https://github.com/owner/repo.git', 'owner', 'repo'],
        ['https://www.github.com/owner/repo', 'owner', 'repo'],
        ['  https://GitHub.com/Owner/Repo  ', 'Owner', 'Repo'],
        ['github.com/owner/repo', 'owner', 'repo'],
        ['git@github.com:owner/repo.git', 'owner', 'repo'],
        ['ssh://git@github.com/owner/repo.git', 'owner', 'repo'],
        ['https://github.com/owner/my.repo-name_1', 'owner', 'my.repo-name_1'],
        ['https://github.com/owner/repo/releases/tag/1.2.3', 'owner', 'repo'],
        ['https://github.com/owner/repo#readme', 'owner', 'repo'],
        ['https://github.com/owner/repo?tab=readme', 'owner', 'repo'],
    ])('%s must be parsed', (url, owner, repo) => {
        expect(parseGithubRepository(url)).toEqual({ owner, repo });
    });

    test.each([
        [undefined],
        [null],
        [42],
        [''],
        ['https://github.com'],
        ['https://github.com/owner'],
        ['https://github.com/owner/'],
        ['https://gitlab.com/owner/repo'],
        ['https://notgithub.com/owner/repo'],
        ['https://github.com.evil.com/owner/repo'],
        ['https://evil.com/github.com/owner/repo'],
        ['https://github.com/../repo'],
        ['https://github.com/owner/..'],
        ['https://github.com/ow ner/repo'],
    ])('%s must not be parsed', (url) => {
        expect(parseGithubRepository(url)).toBeUndefined();
    });
});

describe('resolveGithubRepository', () => {
    test('must use the source label first', () => {
        expect(
            resolveGithubRepository(
                createContainer({
                    labels: {
                        'org.opencontainers.image.source':
                            'https://github.com/label-owner/label-repo.git',
                    },
                    link: 'https://github.com/link-owner/link-repo/releases',
                    result: {
                        tag: '1.1.0',
                        link: 'https://github.com/result-owner/result-repo/releases/tag/1.1.0',
                    },
                    image: {
                        registry: { url: 'https://ghcr.io/v2' },
                        name: 'ghcr-owner/ghcr-repo',
                    },
                }),
            ),
        ).toEqual({ owner: 'label-owner', repo: 'label-repo' });
    });

    test('must use the result link when the source label is not a github url', () => {
        expect(
            resolveGithubRepository(
                createContainer({
                    labels: {
                        'org.opencontainers.image.source':
                            'https://gitlab.com/label-owner/label-repo',
                    },
                    link: 'https://github.com/link-owner/link-repo/releases',
                    result: {
                        tag: '1.1.0',
                        link: 'https://github.com/result-owner/result-repo/releases/tag/1.1.0',
                    },
                }),
            ),
        ).toEqual({ owner: 'result-owner', repo: 'result-repo' });
    });

    test('must use the container link when there is no result link', () => {
        expect(
            resolveGithubRepository(
                createContainer({
                    labels: undefined,
                    link: 'https://github.com/link-owner/link-repo/releases/tag/1.0.0',
                }),
            ),
        ).toEqual({ owner: 'link-owner', repo: 'link-repo' });
    });

    test('must use the image name when the image is hosted on ghcr.io', () => {
        expect(
            resolveGithubRepository(
                createContainer({
                    labels: {},
                    image: {
                        registry: { url: 'https://ghcr.io/v2' },
                        name: 'ghcr-owner/ghcr-repo',
                    },
                }),
            ),
        ).toEqual({ owner: 'ghcr-owner', repo: 'ghcr-repo' });
    });

    test.each([['single-segment'], ['owner/repo/sub-image'], [undefined]])(
        'must not use the ghcr.io image name %s when it is not owner/repo',
        (name) => {
            expect(
                resolveGithubRepository(
                    createContainer({
                        labels: {},
                        image: {
                            registry: { url: 'https://ghcr.io/v2' },
                            name,
                        },
                    }),
                ),
            ).toBeUndefined();
        },
    );

    test('must return undefined when the image is not related to github', () => {
        expect(
            resolveGithubRepository(createContainer({ labels: {} })),
        ).toBeUndefined();
        expect(
            resolveGithubRepository({ name: 'x', watcher: 'local' }),
        ).toBeUndefined();
    });
});

describe('toReleaseSummary', () => {
    test('must trim the text', () => {
        expect(toReleaseSummary('  \n## Changes\n- fix\n\n ')).toBe(
            '## Changes\n- fix',
        );
    });

    test.each([[undefined], [null], [42], [''], ['  \n ']])(
        'must return undefined for %j',
        (text) => {
            expect(toReleaseSummary(text)).toBeUndefined();
        },
    );

    test('must keep a 255 characters text untouched', () => {
        const text = 'a'.repeat(255);
        expect(toReleaseSummary(text)).toBe(text);
    });

    test('must truncate a 256 characters text to 254 characters and an ellipsis', () => {
        const summary = toReleaseSummary('a'.repeat(256));
        expect(summary).toBe(`${'a'.repeat(254)}…`);
        expect(summary).toHaveLength(255);
    });

    test('must measure the length after trimming', () => {
        const text = 'a'.repeat(255);
        expect(toReleaseSummary(`  ${text}\n\n`)).toBe(text);
    });

    test('must count code points and never split an emoji', () => {
        const fits = '🚀'.repeat(255);
        expect(toReleaseSummary(fits)).toBe(fits);
        const summary = toReleaseSummary('🚀'.repeat(256));
        expect(summary).toBe(`${'🚀'.repeat(254)}…`);
        expect(Array.from(summary)).toHaveLength(255);
    });
});

describe('getReleaseSummary', () => {
    test('must fetch the release notes of the new tag from the GitHub API', async () => {
        axios.get.mockResolvedValue(release('## Changes\n- fix'));
        await expect(
            getReleaseSummary(createContainer(), { log }),
        ).resolves.toBe('## Changes\n- fix');
        expect(axios.get).toHaveBeenCalledTimes(1);
        expect(axios.get).toHaveBeenCalledWith(
            'https://api.github.com/repos/owner/repo/releases/tags/1.1.0',
            {
                headers: {
                    Accept: 'application/vnd.github+json',
                    'User-Agent': 'wud (https://github.com/getwud/wud)',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                timeout: 10000,
                validateStatus: expect.any(Function),
            },
        );
        // Statuses are handled explicitly: axios must never throw on them
        const { validateStatus } = axios.get.mock.calls[0][1];
        expect(validateStatus(500)).toBe(true);
    });

    test('must work without options', async () => {
        axios.get.mockResolvedValue(release('notes'));
        await expect(getReleaseSummary(createContainer())).resolves.toBe(
            'notes',
        );
    });

    test('must send the token as a bearer when configured', async () => {
        axios.get.mockResolvedValue(release('notes'));
        await getReleaseSummary(createContainer(), { token: 'ghp_secret' });
        expect(axios.get.mock.calls[0][1].headers.Authorization).toBe(
            'Bearer ghp_secret',
        );
    });

    test('must not send an authorization header without token', async () => {
        axios.get.mockResolvedValue(release('notes'));
        await getReleaseSummary(createContainer(), { token: '' });
        expect(axios.get.mock.calls[0][1].headers).not.toHaveProperty(
            'Authorization',
        );
    });

    test('must url encode the tag', async () => {
        axios.get.mockResolvedValue(release('notes'));
        await getReleaseSummary(
            createContainer({ result: { tag: 'release/1.1.0+build' } }),
        );
        expect(axios.get.mock.calls[0][0]).toBe(
            'https://api.github.com/repos/owner/repo/releases/tags/release%2F1.1.0%2Bbuild',
        );
    });

    test('must truncate long release notes', async () => {
        axios.get.mockResolvedValue(release('a'.repeat(1000)));
        await expect(getReleaseSummary(createContainer())).resolves.toBe(
            `${'a'.repeat(254)}…`,
        );
    });

    test('must fall back to the release name when the body is empty', async () => {
        axios.get.mockResolvedValue(release('  ', 'Version 1.1.0'));
        await expect(getReleaseSummary(createContainer())).resolves.toBe(
            'Version 1.1.0',
        );
    });

    test.each([
        [{ body: null, name: null }],
        [{ body: '', name: '' }],
        [{}],
        ['not an object'],
        [null],
    ])(
        'must return undefined when the release has no notes (%j)',
        async (data) => {
            axios.get.mockResolvedValue({ status: 200, data, headers: {} });
            await expect(
                getReleaseSummary(createContainer(), { log }),
            ).resolves.toBeUndefined();
        },
    );

    test('must retry with a v prefix when the release is not found', async () => {
        axios.get
            .mockResolvedValueOnce(notFound)
            .mockResolvedValueOnce(release('notes'));
        await expect(getReleaseSummary(createContainer())).resolves.toBe(
            'notes',
        );
        expect(axios.get.mock.calls.map(([url]) => url)).toEqual([
            'https://api.github.com/repos/owner/repo/releases/tags/1.1.0',
            'https://api.github.com/repos/owner/repo/releases/tags/v1.1.0',
        ]);
    });

    test('must retry without the v prefix when the release is not found', async () => {
        axios.get
            .mockResolvedValueOnce(notFound)
            .mockResolvedValueOnce(release('notes'));
        await expect(
            getReleaseSummary(createContainer({ result: { tag: 'v1.1.0' } })),
        ).resolves.toBe('notes');
        expect(axios.get.mock.calls.map(([url]) => url)).toEqual([
            'https://api.github.com/repos/owner/repo/releases/tags/v1.1.0',
            'https://api.github.com/repos/owner/repo/releases/tags/1.1.0',
        ]);
    });

    test('must retry only once', async () => {
        axios.get.mockResolvedValue(notFound);
        await expect(
            getReleaseSummary(createContainer(), { log }),
        ).resolves.toBeUndefined();
        expect(axios.get).toHaveBeenCalledTimes(2);
        expect(log.debug).toHaveBeenCalledWith(
            'No GitHub release found for owner/repo@1.1.0',
        );
    });

    test('must not retry when the tag is not a version', async () => {
        axios.get.mockResolvedValue(notFound);
        await expect(
            getReleaseSummary(createContainer({ result: { tag: 'stable' } })),
        ).resolves.toBeUndefined();
        expect(axios.get).toHaveBeenCalledTimes(1);
    });

    test.each([
        [
            'a digest update',
            {
                updateKind: { kind: 'digest' },
                result: { tag: '1.0.0', digest: 'sha256:123' },
            },
        ],
        ['an unknown update kind', { updateKind: { kind: 'unknown' } }],
        ['no update kind', { updateKind: undefined }],
        ['no update available', { updateAvailable: false }],
        ['no result', { result: undefined }],
        ['no result tag', { result: { digest: 'sha256:123' } }],
        ['an empty result tag', { result: { tag: '' } }],
        ['no github repository', { labels: {} }],
    ])(
        'must return undefined without calling GitHub for %s',
        async (_label, overrides) => {
            await expect(
                getReleaseSummary(createContainer(overrides), { log }),
            ).resolves.toBeUndefined();
            expect(axios.get).not.toHaveBeenCalled();
        },
    );

    test('must return undefined for an undefined container', async () => {
        await expect(
            getReleaseSummary(undefined, { log }),
        ).resolves.toBeUndefined();
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('must never throw even when everything fails', async () => {
        const container = createContainer();
        Object.defineProperty(container, 'labels', {
            get: () => {
                throw new Error('boom');
            },
        });
        await expect(
            getReleaseSummary(container, { log }),
        ).resolves.toBeUndefined();
        expect(log.debug).toHaveBeenCalledWith(
            'Unable to get release summary (boom)',
        );
        expect(getCachedReleaseSummary(container)).toBeUndefined();

        log.debug.mockImplementation(() => {
            throw new Error('log failure');
        });
        await expect(
            getReleaseSummary(container, { log }),
        ).resolves.toBeUndefined();
    });

    describe('cache', () => {
        beforeEach(() => {
            jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
        });

        test('must cache found releases', async () => {
            axios.get.mockResolvedValue(release('notes'));
            await expect(getReleaseSummary(createContainer())).resolves.toBe(
                'notes',
            );
            jest.advanceTimersByTime(23 * HOUR);
            await expect(getReleaseSummary(createContainer())).resolves.toBe(
                'notes',
            );
            expect(axios.get).toHaveBeenCalledTimes(1);

            jest.advanceTimersByTime(HOUR);
            axios.get.mockResolvedValue(release('edited notes'));
            await expect(getReleaseSummary(createContainer())).resolves.toBe(
                'edited notes',
            );
            expect(axios.get).toHaveBeenCalledTimes(2);
        });

        test('must share the cache whatever the repository case', async () => {
            axios.get.mockResolvedValue(release('notes'));
            await getReleaseSummary(createContainer());
            await expect(
                getReleaseSummary(
                    createContainer({
                        labels: {
                            'org.opencontainers.image.source':
                                'https://github.com/Owner/Repo.git',
                        },
                    }),
                ),
            ).resolves.toBe('notes');
            expect(axios.get).toHaveBeenCalledTimes(1);
        });

        test('must not share the cache between tags', async () => {
            axios.get
                .mockResolvedValueOnce(release('notes 1.1.0'))
                .mockResolvedValueOnce(release('notes 1.2.0'));
            await expect(getReleaseSummary(createContainer())).resolves.toBe(
                'notes 1.1.0',
            );
            await expect(
                getReleaseSummary(
                    createContainer({ result: { tag: '1.2.0' } }),
                ),
            ).resolves.toBe('notes 1.2.0');
            expect(axios.get).toHaveBeenCalledTimes(2);
        });

        test('must cache releases not found for 6 hours', async () => {
            axios.get.mockResolvedValue(notFound);
            await getReleaseSummary(createContainer());
            expect(axios.get).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(6 * HOUR - 1);
            await expect(
                getReleaseSummary(createContainer()),
            ).resolves.toBeUndefined();
            expect(axios.get).toHaveBeenCalledTimes(2);

            jest.advanceTimersByTime(1);
            axios.get.mockResolvedValue(release('notes'));
            await expect(getReleaseSummary(createContainer())).resolves.toBe(
                'notes',
            );
            expect(axios.get).toHaveBeenCalledTimes(3);
        });

        test('must cache releases without notes for 6 hours', async () => {
            axios.get.mockResolvedValue(release(''));
            await getReleaseSummary(createContainer());
            jest.advanceTimersByTime(6 * HOUR - 1);
            await getReleaseSummary(createContainer());
            expect(axios.get).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(1);
            await getReleaseSummary(createContainer());
            expect(axios.get).toHaveBeenCalledTimes(2);
        });

        test('must bound the cache size', async () => {
            axios.get.mockResolvedValue(release('notes'));
            for (let i = 0; i <= 500; i += 1) {
                await getReleaseSummary(
                    createContainer({ result: { tag: `1.0.${i}` } }),
                );
            }
            expect(axios.get).toHaveBeenCalledTimes(501);
            // The most recent entries are kept...
            expect(
                getCachedReleaseSummary(
                    createContainer({ result: { tag: '1.0.500' } }),
                ),
            ).toBe('notes');
            expect(
                getCachedReleaseSummary(
                    createContainer({ result: { tag: '1.0.1' } }),
                ),
            ).toBe('notes');
            // ...and the oldest one is evicted
            expect(
                getCachedReleaseSummary(
                    createContainer({ result: { tag: '1.0.0' } }),
                ),
            ).toBeUndefined();
        });

        test.each([
            [
                'a network error',
                () => axios.get.mockRejectedValue(new Error('ECONNREFUSED')),
                'ECONNREFUSED',
            ],
            [
                'a timeout',
                () =>
                    axios.get.mockRejectedValue(
                        new Error('timeout of 10000ms exceeded'),
                    ),
                'timeout of 10000ms exceeded',
            ],
            [
                'a non error rejection',
                () => axios.get.mockRejectedValue('weird failure'),
                'weird failure',
            ],
            [
                'a primary rate limit',
                () =>
                    axios.get.mockResolvedValue({
                        status: 403,
                        data: {},
                        headers: { 'x-ratelimit-remaining': '0' },
                    }),
                'GitHub API rate limit reached (HTTP 403); configure a GitHub token to raise it',
            ],
            [
                'a secondary rate limit',
                () =>
                    axios.get.mockResolvedValue({
                        status: 403,
                        data: {},
                        headers: { 'retry-after': 60 },
                    }),
                'GitHub API rate limit reached (HTTP 403); configure a GitHub token to raise it',
            ],
            [
                'a too many requests response',
                () =>
                    axios.get.mockResolvedValue({
                        status: 429,
                        data: {},
                        headers: {},
                    }),
                'GitHub API rate limit reached (HTTP 429); configure a GitHub token to raise it',
            ],
            [
                'a rejected token',
                () =>
                    axios.get.mockResolvedValue({
                        status: 401,
                        data: {},
                        headers: {},
                    }),
                'GitHub API rejected the configured token (HTTP 401)',
            ],
            [
                'a server error',
                () =>
                    axios.get.mockResolvedValue({
                        status: 503,
                        data: {},
                        headers: {},
                    }),
                'GitHub API is unavailable (HTTP 503)',
            ],
        ])(
            'must pause all lookups for 5 minutes after %s',
            async (_label, mockFailure, reason) => {
                mockFailure();
                await expect(
                    getReleaseSummary(createContainer(), {
                        log,
                        token: 'ghp_secret',
                    }),
                ).resolves.toBeUndefined();
                expect(axios.get).toHaveBeenCalledTimes(1);
                expect(log.warn).toHaveBeenCalledWith(
                    `Unable to get GitHub release for owner/repo@1.1.0 (${reason}); release summaries are paused for 5 minutes`,
                );
                expect(JSON.stringify(log.warn.mock.calls)).not.toContain(
                    'ghp_secret',
                );

                // No call at all while paused, even for another repository
                axios.get.mockResolvedValue(release('notes'));
                jest.advanceTimersByTime(5 * MINUTE - 1);
                await expect(
                    getReleaseSummary(createContainer(), { log }),
                ).resolves.toBeUndefined();
                await expect(
                    getReleaseSummary(
                        createContainer({
                            labels: {
                                'org.opencontainers.image.source':
                                    'https://github.com/other/project',
                            },
                        }),
                        { log },
                    ),
                ).resolves.toBeUndefined();
                expect(axios.get).toHaveBeenCalledTimes(1);

                // The failure is not cached longer than the pause
                jest.advanceTimersByTime(1);
                await expect(
                    getReleaseSummary(createContainer(), { log }),
                ).resolves.toBe('notes');
                expect(axios.get).toHaveBeenCalledTimes(2);
            },
        );

        test('must still serve cached summaries while paused', async () => {
            axios.get.mockResolvedValueOnce(release('notes'));
            await getReleaseSummary(createContainer());
            axios.get.mockRejectedValueOnce(new Error('ECONNRESET'));
            await getReleaseSummary(
                createContainer({ result: { tag: '1.2.0' } }),
            );
            await expect(getReleaseSummary(createContainer())).resolves.toBe(
                'notes',
            );
            expect(axios.get).toHaveBeenCalledTimes(2);
        });

        test.each([[403], [451], [400], [301]])(
            'must cache an unexpected HTTP %s for 5 minutes for this release only',
            async (status) => {
                axios.get.mockResolvedValue({ status, data: {}, headers: {} });
                await expect(
                    getReleaseSummary(createContainer(), { log }),
                ).resolves.toBeUndefined();
                expect(axios.get).toHaveBeenCalledTimes(1);
                expect(log.warn).toHaveBeenCalledWith(
                    `Unable to get GitHub release for owner/repo@1.1.0 (HTTP ${status})`,
                );

                jest.advanceTimersByTime(5 * MINUTE - 1);
                await getReleaseSummary(createContainer(), { log });
                expect(axios.get).toHaveBeenCalledTimes(1);

                // Other releases are still looked up
                axios.get.mockResolvedValue(release('notes'));
                await expect(
                    getReleaseSummary(
                        createContainer({ result: { tag: '1.2.0' } }),
                        { log },
                    ),
                ).resolves.toBe('notes');
                expect(axios.get).toHaveBeenCalledTimes(2);

                jest.advanceTimersByTime(1);
                await expect(
                    getReleaseSummary(createContainer(), { log }),
                ).resolves.toBe('notes');
                expect(axios.get).toHaveBeenCalledTimes(3);
            },
        );

        test('must tolerate responses without headers', async () => {
            axios.get.mockResolvedValue({ status: 403, data: {} });
            await expect(
                getReleaseSummary(createContainer(), { log }),
            ).resolves.toBeUndefined();
            expect(log.warn).toHaveBeenCalledWith(
                'Unable to get GitHub release for owner/repo@1.1.0 (HTTP 403)',
            );
        });
    });

    describe('ordering', () => {
        test('must resolve lookups one at a time in call order', async () => {
            const events = [];
            let resolveSlow;
            axios.get.mockImplementation((url) => {
                events.push(`request ${url.split('/').pop()}`);
                if (url.endsWith('/1.1.0')) {
                    return new Promise((resolve) => {
                        resolveSlow = () => resolve(release('slow'));
                    });
                }
                return Promise.resolve(release('fast'));
            });

            const slow = getReleaseSummary(createContainer()).then((summary) =>
                events.push(`resolved ${summary}`),
            );
            const fast = getReleaseSummary(
                createContainer({ result: { tag: '1.2.0' } }),
            ).then((summary) => events.push(`resolved ${summary}`));
            const settled = whenReleaseSummariesSettled().then(() =>
                events.push('settled'),
            );
            const afterSettled = getReleaseSummary(
                createContainer({ result: { tag: '1.3.0' } }),
            ).then((summary) => events.push(`resolved again ${summary}`));

            await new Promise((resolve) => setImmediate(resolve));
            // The second lookup has not even started
            expect(events).toEqual(['request 1.1.0']);

            resolveSlow();
            await Promise.all([slow, fast, settled, afterSettled]);
            expect(events).toEqual([
                'request 1.1.0',
                'resolved slow',
                'request 1.2.0',
                'resolved fast',
                'settled',
                'request 1.3.0',
                'resolved again fast',
            ]);
        });

        test('whenReleaseSummariesSettled must resolve when nothing is pending', async () => {
            await expect(
                whenReleaseSummariesSettled(),
            ).resolves.toBeUndefined();
        });
    });
});

describe('getCachedReleaseSummary', () => {
    test('must never call GitHub', async () => {
        expect(getCachedReleaseSummary(createContainer())).toBeUndefined();
        expect(axios.get).not.toHaveBeenCalled();
    });

    test('must return the summary once fetched', async () => {
        axios.get.mockResolvedValue(release('notes'));
        await getReleaseSummary(createContainer());
        expect(getCachedReleaseSummary(createContainer())).toBe('notes');
        expect(
            getCachedReleaseSummary(
                createContainer({ updateAvailable: false }),
            ),
        ).toBeUndefined();
        expect(getCachedReleaseSummary(undefined)).toBeUndefined();
    });

    test('must not throw', () => {
        const container = createContainer();
        Object.defineProperty(container, 'labels', {
            get: () => {
                throw new Error('boom');
            },
        });
        expect(getCachedReleaseSummary(container)).toBeUndefined();
    });
});

describe('getCachedHassReleaseSummary', () => {
    test('must return the cached summary only when the option is enabled', async () => {
        axios.get.mockResolvedValue(release('notes'));
        await getReleaseSummary(createContainer());
        expect(
            getCachedHassReleaseSummary(
                { enabled: true, release_summary: true },
                createContainer(),
            ),
        ).toBe('notes');
        expect(
            getCachedHassReleaseSummary(
                { enabled: true, release_summary: false },
                createContainer(),
            ),
        ).toBeUndefined();
        expect(
            getCachedHassReleaseSummary(undefined, createContainer()),
        ).toBeUndefined();
    });
});
