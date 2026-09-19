/**
 * OS-protected storage for the API key.
 *
 * v3.0.1 and earlier kept the key inside `electron-store`, which encrypts with a
 * key hardcoded in this repository — so anyone who obtained `settings.json`
 * could decrypt it. The key now lives in its own file, encrypted with Electron's
 * `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux), which
 * binds the ciphertext to the current OS user account.
 *
 * File: <userData>/secret.json
 *
 * `settings.json` keeps every non-secret preference unchanged, so no format
 * migration of the existing store is required — only the key is moved out.
 */
import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import log from './logger';

interface SecretFile {
  /** Format version, so the layout can evolve without losing the key. */
  v: 1;
  /** True when `data` is safeStorage ciphertext, false when plain base64. */
  encrypted: boolean;
  /** base64-encoded payload. */
  data: string;
}

function secretFilePath(): string {
  return path.join(app.getPath('userData'), 'secret.json');
}

/**
 * In-memory mirror. The file is tiny, but `getSettings()` runs on every
 * translation (including the global-hotkey path), so we avoid re-reading and
 * re-decrypting it each time.
 */
let cache: string | null = null;

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (err) {
    log.warn('[secret] safeStorage unavailable:', (err as Error).message);
    return false;
  }
}

function loadFromDisk(): string {
  const file = secretFilePath();
  try {
    if (!fs.existsSync(file)) return '';
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SecretFile>;
    if (!parsed || typeof parsed.data !== 'string') {
      log.warn('[secret] secret file is malformed — treating the API key as unset');
      return '';
    }
    const buf = Buffer.from(parsed.data, 'base64');
    if (parsed.encrypted) return safeStorage.decryptString(buf);
    // Written on a host where safeStorage was unavailable — read it back so the
    // user is not forced to re-enter the key, but make the downgrade visible.
    log.warn('[secret] the stored API key is NOT OS-encrypted (safeStorage was unavailable)');
    return buf.toString('utf-8');
  } catch (err) {
    // A corrupt payload or a rotated OS key means the key is unrecoverable.
    // Report it, keep the file (so it can be inspected), and let the UI prompt
    // for a new key rather than crashing the app.
    log.error('[secret] failed to read the API key:', err);
    return '';
  }
}

/**
 * The API key, or `''` when none is stored / it cannot be decrypted.
 * Never throws — a broken secret store must not stop the app from starting.
 */
export function readApiKey(): string {
  if (cache === null) cache = loadFromDisk();
  return cache;
}

/**
 * Persist the API key under OS protection.
 *
 * Throws on a genuine write failure so the caller can tell the user the key was
 * NOT saved — silently losing a key the user just typed is worse than an error.
 */
export function writeApiKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) {
    // `updateSettings()` already refuses to call this with a blank value. Guard
    // here too so a future caller cannot silently wipe the stored key by
    // passing whitespace — clearing is an explicit, separate operation.
    throw new Error('writeApiKey: refusing to store an empty API key (use clearApiKey)');
  }

  const encrypt = canEncrypt();
  const payload = encrypt
    ? safeStorage.encryptString(trimmed)
    : Buffer.from(trimmed, 'utf-8');
  if (!encrypt) {
    log.warn('[secret] safeStorage unavailable — storing the API key without OS encryption');
  }

  const body: SecretFile = {
    v: 1,
    encrypted: encrypt,
    data: payload.toString('base64'),
  };

  const file = secretFilePath();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic replace: a crash mid-write can never leave a truncated secret file.
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(body, null, 2), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);

  cache = trimmed;
  log.info(`[secret] API key stored (encrypted=${encrypt})`);
}

/** Remove the stored API key. Missing file is not an error. */
export function clearApiKey(): void {
  cache = '';
  try {
    fs.rmSync(secretFilePath(), { force: true });
  } catch (err) {
    log.warn('[secret] failed to remove the secret file:', (err as Error).message);
  }
}

/** Reset the in-memory mirror (test/DI hook; not used by the app itself). */
export function resetApiKeyCache(): void {
  cache = null;
}