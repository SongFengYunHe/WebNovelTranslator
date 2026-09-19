/**
 * Single source of truth for the project's public URLs.
 *
 * The app used to hardcode the upstream repository in five different files,
 * which meant a fork's auto-update feed silently pointed at someone else's
 * releases. Every release/update URL now derives from here.
 *
 * NOTE: `electron-builder.config.js` is a CommonJS build file and cannot import
 * this TypeScript module — it derives the same URL from the `repository` field
 * in package.json instead. Keep both in sync when the repository moves.
 */

/** GitHub owner of the canonical repository. */
export const REPO_OWNER = 'SongFengYunHe';

/** GitHub repository name. */
export const REPO_NAME = 'WebNovelTranslator';

/** Canonical repository URL, without a trailing slash. */
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

/** Human-facing releases page (used by every "open download page" action). */
export const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * electron-builder's `generic` publish endpoint. It serves the `latest.yml`
 * feed that electron-updater reads, so the trailing slash is required.
 */
export const UPDATE_FEED_URL = `${RELEASES_URL}/latest/download/`;