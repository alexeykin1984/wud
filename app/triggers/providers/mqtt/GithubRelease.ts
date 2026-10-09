import axios from 'axios';
import { Container } from '../../../model/container';

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_API_TIMEOUT_MS = 10 * 1000;
const GITHUB_USER_AGENT = 'wud (https://github.com/getwud/wud)';
const SOURCE_LABEL = 'org.opencontainers.image.source';

/**
 * Home Assistant limits the release summary of an update entity to 255 characters.
 */
export const RELEASE_SUMMARY_MAX_LENGTH = 255;

const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 6 * 60 * 60 * 1000;
const TRANSIENT_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

const GITHUB_URL_PATTERN =
    /^(?:git\+)?(?:https?:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i;
const GHCR_IMAGE_NAME_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export interface GithubRepository {
    owner: string;
    repo: string;
}

export interface ReleaseSummaryLogger {
    debug: (message: string) => void;
    warn: (message: string) => void;
}

export interface ReleaseSummaryOptions {
    token?: string;
    log?: ReleaseSummaryLogger;
}

/**
 * The subset of the MQTT `hass` configuration driving the release summary.
 */
export interface ReleaseSummaryHassConfiguration {
    enabled?: boolean;
    release_summary?: boolean;
    github_token?: string;
}

interface ReleaseTarget extends GithubRepository {
    tag: string;
    key: string;
}

interface CacheEntry {
    summary?: string;
    expiresAt: number;
}

type FetchResult =
    | { kind: 'found'; summary?: string }
    | { kind: 'not-found' }
    | { kind: 'paused'; reason: string }
    | { kind: 'failed'; reason: string };

const cache = new Map<string, CacheEntry>();
let pausedUntil = 0;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Is the release summary feature enabled for this MQTT trigger?
 */
export function isReleaseSummaryEnabled(
    hass?: ReleaseSummaryHassConfiguration,
): boolean {
    return hass?.enabled === true && hass?.release_summary === true;
}

/**
 * Parse a GitHub repository url (https, git+https, ssh...) into owner/repo.
 */
export function parseGithubRepository(
    url: string | undefined,
): GithubRepository | undefined {
    if (typeof url !== 'string') {
        return undefined;
    }
    const match = GITHUB_URL_PATTERN.exec(url.trim());
    if (!match) {
        return undefined;
    }
    const [, owner, repo] = match;
    if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) {
        return undefined;
    }
    return { owner, repo };
}

/**
 * Resolve the GitHub repository publishing the releases of a container image.
 *
 * Resolution order:
 * 1. the `org.opencontainers.image.source` label,
 * 2. the container release link (`wud.link.template`),
 * 3. the image name when the image is hosted on ghcr.io.
 */
export function resolveGithubRepository(
    container: Container,
): GithubRepository | undefined {
    const fromLabel = parseGithubRepository(container.labels?.[SOURCE_LABEL]);
    if (fromLabel) {
        return fromLabel;
    }
    const fromLink =
        parseGithubRepository(container.result?.link) ||
        parseGithubRepository(container.link);
    if (fromLink) {
        return fromLink;
    }
    const registryUrl = container.image?.registry?.url;
    const imageName = container.image?.name;
    if (
        typeof registryUrl === 'string' &&
        registryUrl.toLowerCase().includes('ghcr.io') &&
        typeof imageName === 'string'
    ) {
        const match = GHCR_IMAGE_NAME_PATTERN.exec(imageName);
        if (match) {
            return { owner: match[1], repo: match[2] };
        }
    }
    return undefined;
}

/**
 * Trim the release notes and truncate them to what Home Assistant accepts.
 */
export function toReleaseSummary(text: unknown): string | undefined {
    if (typeof text !== 'string') {
        return undefined;
    }
    const trimmed = text.trim();
    if (trimmed === '') {
        return undefined;
    }
    // Count code points (not UTF-16 units) so that emojis are never cut in half
    const characters = Array.from(trimmed);
    if (characters.length <= RELEASE_SUMMARY_MAX_LENGTH) {
        return trimmed;
    }
    return `${characters.slice(0, RELEASE_SUMMARY_MAX_LENGTH - 1).join('')}…`;
}

/**
 * Get the alternate tag to try when a release is not found (1.2.3 <-> v1.2.3).
 */
function toggleVersionPrefix(tag: string): string | undefined {
    if (/^v\d/i.test(tag)) {
        return tag.substring(1);
    }
    if (/^\d/.test(tag)) {
        return `v${tag}`;
    }
    return undefined;
}

/**
 * Get the release to look for (only when a new tag is available).
 */
function getReleaseTarget(container: Container): ReleaseTarget | undefined {
    const tag = container?.result?.tag;
    if (
        !container?.updateAvailable ||
        container.updateKind?.kind !== 'tag' ||
        typeof tag !== 'string' ||
        tag === ''
    ) {
        return undefined;
    }
    const repository = resolveGithubRepository(container);
    if (!repository) {
        return undefined;
    }
    return {
        ...repository,
        tag,
        key: `${repository.owner}/${repository.repo}@`.toLowerCase() + tag,
    };
}

function readCache(key: string, now: number): CacheEntry | undefined {
    const entry = cache.get(key);
    if (!entry) {
        return undefined;
    }
    if (entry.expiresAt <= now) {
        cache.delete(key);
        return undefined;
    }
    return entry;
}

function writeCache(key: string, entry: CacheEntry) {
    // Re-insert so that the Map keeps the most recently written entries last
    cache.delete(key);
    cache.set(key, entry);
    if (cache.size > CACHE_MAX_ENTRIES) {
        const [oldestKey] = cache.keys();
        cache.delete(oldestKey);
    }
}

function getHeader(headers: unknown, name: string): string | undefined {
    if (typeof headers !== 'object' || headers === null) {
        return undefined;
    }
    const value = (headers as Record<string, unknown>)[name];
    return value === undefined || value === null ? undefined : String(value);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch a release by tag from the GitHub API.
 */
async function fetchRelease(
    target: ReleaseTarget,
    token: string | undefined,
): Promise<FetchResult> {
    const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': GITHUB_USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    const tags = [target.tag];
    const alternateTag = toggleVersionPrefix(target.tag);
    if (alternateTag) {
        tags.push(alternateTag);
    }
    for (const tag of tags) {
        const response = await axios.get<unknown>(
            `${GITHUB_API_URL}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/releases/tags/${encodeURIComponent(tag)}`,
            {
                headers,
                timeout: GITHUB_API_TIMEOUT_MS,
                validateStatus: () => true,
            },
        );
        const { status } = response;
        if (status === 404) {
            continue;
        }
        if (status >= 200 && status < 300) {
            const release =
                typeof response.data === 'object' && response.data !== null
                    ? (response.data as Record<string, unknown>)
                    : {};
            return {
                kind: 'found',
                summary:
                    toReleaseSummary(release.body) ||
                    toReleaseSummary(release.name),
            };
        }
        const rateLimited =
            status === 429 ||
            (status === 403 &&
                (getHeader(response.headers, 'x-ratelimit-remaining') === '0' ||
                    getHeader(response.headers, 'retry-after') !== undefined));
        if (rateLimited) {
            return {
                kind: 'paused',
                reason: `GitHub API rate limit reached (HTTP ${status}); configure a GitHub token to raise it`,
            };
        }
        if (status === 401) {
            return {
                kind: 'paused',
                reason: 'GitHub API rejected the configured token (HTTP 401)',
            };
        }
        if (status >= 500) {
            return {
                kind: 'paused',
                reason: `GitHub API is unavailable (HTTP ${status})`,
            };
        }
        return { kind: 'failed', reason: `HTTP ${status}` };
    }
    return { kind: 'not-found' };
}

async function lookupReleaseSummary(
    container: Container,
    { token, log }: ReleaseSummaryOptions,
): Promise<string | undefined> {
    try {
        const target = getReleaseTarget(container);
        if (!target) {
            return undefined;
        }
        const cached = readCache(target.key, Date.now());
        if (cached) {
            return cached.summary;
        }
        if (Date.now() < pausedUntil) {
            return undefined;
        }

        let result: FetchResult;
        try {
            result = await fetchRelease(target, token);
        } catch (error) {
            // Network error or timeout
            result = { kind: 'paused', reason: getErrorMessage(error) };
        }

        const now = Date.now();
        switch (result.kind) {
            case 'found':
                writeCache(target.key, {
                    summary: result.summary,
                    expiresAt:
                        now +
                        (result.summary ? FOUND_TTL_MS : NOT_FOUND_TTL_MS),
                });
                return result.summary;
            case 'not-found':
                log?.debug(`No GitHub release found for ${target.key}`);
                writeCache(target.key, {
                    expiresAt: now + NOT_FOUND_TTL_MS,
                });
                return undefined;
            case 'paused':
                // Do not hammer GitHub (nor delay MQTT messages) while it fails
                pausedUntil = now + TRANSIENT_TTL_MS;
                log?.warn(
                    `Unable to get GitHub release for ${target.key} (${result.reason}); release summaries are paused for ${TRANSIENT_TTL_MS / 60000} minutes`,
                );
                return undefined;
            default:
                log?.warn(
                    `Unable to get GitHub release for ${target.key} (${result.reason})`,
                );
                writeCache(target.key, {
                    expiresAt: now + TRANSIENT_TTL_MS,
                });
                return undefined;
        }
    } catch (error) {
        try {
            log?.debug(
                `Unable to get release summary (${getErrorMessage(error)})`,
            );
        } catch {
            // Never let a logging failure break the trigger
        }
        return undefined;
    }
}

/**
 * Get the release summary (GitHub release notes limited to 255 characters) of the
 * new version of a container.
 *
 * Never rejects: resolves to undefined when the summary is not available.
 * Lookups are processed one at a time, in call order, so that MQTT messages
 * waiting for a summary are always published in the order they were requested.
 */
export function getReleaseSummary(
    container: Container,
    options: ReleaseSummaryOptions = {},
): Promise<string | undefined> {
    const lookup = queue.then(() => lookupReleaseSummary(container, options));
    queue = lookup;
    return lookup;
}

/**
 * Get the release summary of a container from the cache only (no GitHub call).
 */
export function getCachedReleaseSummary(
    container: Container,
): string | undefined {
    try {
        const target = getReleaseTarget(container);
        return target ? readCache(target.key, Date.now())?.summary : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Wait for the lookups already requested, so that a message which does not need
 * a summary (e.g. a container removal) is not published before the messages
 * still waiting for one.
 */
export function whenReleaseSummariesSettled(): Promise<void> {
    const settled = queue.then(() => undefined);
    queue = settled;
    return settled;
}

/**
 * Get the release summary of a container from the cache only, when the feature
 * is enabled (synchronous, no GitHub call).
 */
export function getCachedHassReleaseSummary(
    hass: ReleaseSummaryHassConfiguration | undefined,
    container: Container,
): string | undefined {
    return isReleaseSummaryEnabled(hass)
        ? getCachedReleaseSummary(container)
        : undefined;
}

/**
 * Reset the cache and the failure pause (for testing purposes).
 */
export function clearReleaseSummaryCache() {
    cache.clear();
    pausedUntil = 0;
    queue = Promise.resolve();
}
