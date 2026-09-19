/**
 * 使用操作系统保护的 API 密钥存储。
 *
 * v3.0.1 及更早版本把密钥保存在 `electron-store` 中，而其加密密钥硬编码在本仓库
 * 里——因此任何拿到 `settings.json` 的人都能解密它。现在密钥存放在独立文件中，
 * 用 Electron 的 `safeStorage` 加密（Windows 上为 DPAPI，macOS 上为 Keychain，
 * Linux 上为 libsecret），从而把密文绑定到当前操作系统用户账号。
 *
 * 文件：<userData>/secret.json
 *
 * `settings.json` 中所有非密钥的偏好设置保持不变，因此现有存储无需格式迁移——
 * 只需把密钥移出去。
 */
import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import log from './logger';

interface SecretFile {
  /** 格式版本，便于在不丢失密钥的前提下演进布局。 */
  v: 1;
  /** 为 true 时 `data` 是 safeStorage 密文，为 false 时是普通 base64。 */
  encrypted: boolean;
  /** base64 编码的载荷。 */
  data: string;
}

function secretFilePath(): string {
  return path.join(app.getPath('userData'), 'secret.json');
}

/**
 * 内存镜像。文件很小，但 `getSettings()` 在每次翻译时都会执行（包括全局快捷键
 * 路径），因此避免每次都重新读取并解密文件。
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
    // 该文件是在 safeStorage 不可用的主机上写入的——仍然读回来，避免用户被迫
    // 重新输入密钥，但要明确暴露这次降级。
    log.warn('[secret] the stored API key is NOT OS-encrypted (safeStorage was unavailable)');
    return buf.toString('utf-8');
  } catch (err) {
    // 载荷损坏或操作系统密钥轮换都意味着密钥无法恢复。上报该情况，保留文件
    //（便于排查），并让界面提示用户输入新密钥，而不是让应用崩溃。
    log.error('[secret] failed to read the API key:', err);
    return '';
  }
}

/**
 * API 密钥；未存储/无法解密时返回 `''`。
 * 从不抛异常——密钥存储损坏绝不能阻止应用启动。
 */
export function readApiKey(): string {
  if (cache === null) cache = loadFromDisk();
  return cache;
}

/**
 * 在操作系统保护下持久化 API 密钥。
 *
 * 真正的写入失败会抛异常，以便调用方告知用户密钥「未」保存——悄无声息地丢掉
 * 用户刚输入的密钥，比报错更糟。
 */
export function writeApiKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) {
    // `updateSettings()` 已拒绝用空值调用这里。这里再守一道，避免将来的调用方
    // 传入空白字符就悄悄清空已存的密钥——清空应是一个显式、独立的操作。
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
  // 原子替换：写入中途崩溃绝不会留下被截断的密钥文件。
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

/** 删除已存储的 API 密钥。文件不存在不算错误。 */
export function clearApiKey(): void {
  cache = '';
  try {
    fs.rmSync(secretFilePath(), { force: true });
  } catch (err) {
    log.warn('[secret] failed to remove the secret file:', (err as Error).message);
  }
}

/** 重置内存镜像（测试/依赖注入钩子；应用本身不使用）。 */
export function resetApiKeyCache(): void {
  cache = null;
}