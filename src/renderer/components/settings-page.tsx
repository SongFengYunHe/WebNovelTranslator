/**
 * SettingsPage:
 *  - provider preset dropdown: Custom / DeepSeek / Kimi (Part D)
 *  - API key (masked; never sent back from main), base URL, model, params
 *  - global hotkey capture (Part A3)
 *  - offline translation toggle + download progress (Part A4)
 *  - "Check for updates" (Part A1)
 *  - UI language switch
 *  - history auto-clean (Part 1g)
 *
 * 设置页：集中管理服务商、密钥、模型参数、全局快捷键、离线翻译与更新检查。
 *
 * v3.0.1 layout: the outermost container covers the whole window (gray
 * background, overflow hidden). All form content lives in a scrollable middle
 * area (`settings-scroll`), and the Save/Test buttons are pinned to the bottom
 * of the window in a fixed footer (`settings-actions`).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '../contexts/app-context';
import { useI18n } from '../contexts/i18n-context';
import type { Locale } from '../i18n';
import type { ProviderId } from '../../shared/types';
import { PROVIDER_PRESETS } from '../../shared/types';
import {
  apiHotkeySet,
  apiOfflineDownload,
  apiSaveSettings,
  apiTestConnection,
  apiUpdateCheck,
  apiUpdateOpenDownload,
} from '../services/api';

export default function SettingsPage() {
  const { settings, refreshSettings, offlineStatus, refreshOfflineStatus } = useApp();
  const { locale, setLocale, t } = useI18n();
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<ProviderId>('custom');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('gpt-4o');
  const [temperature, setTemperature] = useState('0.3');
  const [maxTokens, setMaxTokens] = useState('4096');
  // 历史记录自动清理：保留天数（0 = 关闭）。
  const [autoDeleteDays, setAutoDeleteDays] = useState('90');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string; ms?: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const [hotkey, setHotkey] = useState('Ctrl+Shift+Z');
  const [hotkeyCapture, setHotkeyCapture] = useState(false);
  const [hotkeyMsg, setHotkeyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [updateState, setUpdateState] = useState<
    | { phase: 'idle' }
    | { phase: 'checking' }
    | { phase: 'available'; version: string }
    | { phase: 'done' }
    | { phase: 'error'; msg: string }
  >({ phase: 'idle' });

  useEffect(() => {
    if (settings) {
      setBaseUrl(settings.baseUrl);
      setModel(settings.model);
      setTemperature(String(settings.temperature));
      setMaxTokens(String(settings.maxTokens));
      setProvider(settings.provider ?? 'custom');
      setHotkey(settings.hotkey || 'Ctrl+Shift+Z');
      setAutoDeleteDays(String(settings.historyAutoDeleteDays ?? 0));
    }
  }, [settings]);

  const applyProviderPreset = useCallback((pid: ProviderId) => {
    setProvider(pid);
    const preset = PROVIDER_PRESETS[pid];
    if (pid !== 'custom') {
      setBaseUrl(preset.baseUrl);
      setModel(preset.model);
    }
  }, []);

  const save = useCallback(async () => {
    setSaveError(false);
    try {
      // The API key is written to OS-protected storage in the main process and
      // can fail (e.g. safeStorage unavailable + disk error). Surface that
      // instead of silently pretending the key was saved.
      await apiSaveSettings({
        provider,
        baseUrl: baseUrl.trim() || 'https://api.openai.com/v1',
        model: model.trim() || 'gpt-4o',
        temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.3,
        maxTokens: Math.max(1, Math.round(Number(maxTokens)) || 4096),
        historyAutoDeleteDays: Math.max(0, Math.round(Number(autoDeleteDays)) || 0),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
    } catch {
      setSaveError(true);
      setTimeout(() => setSaveError(false), 5000);
      return;
    }
    setApiKey('');
    await refreshSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, [provider, baseUrl, model, temperature, maxTokens, autoDeleteDays, apiKey, refreshSettings]);

  const test = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const res = await apiTestConnection();
    setTestResult({ ok: res.success, msg: res.message, ms: res.latencyMs });
    setTesting(false);
  }, []);

  // ---- Hotkey capture (Part A3) --------------------------------------------
  const onHotkeyKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      if (e.key === 'Escape') {
        setHotkeyCapture(false);
        return;
      }
      const mods: string[] = [];
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');
      if (!mods.length) return; // require at least one modifier
      let key = e.key;
      if (key.length === 1) key = key.toUpperCase();
      const combo = [...mods, key].join('+');
      setHotkey(combo);
      setHotkeyCapture(false);
    },
    []
  );

  const saveHotkey = useCallback(async () => {
    if (!hotkey) return;
    const result = await apiHotkeySet(hotkey);
    setHotkeyMsg({
      ok: result.ok,
      text: result.ok ? t('settings.hotkeySaved') : t('settings.hotkeyConflict', { reason: result.reason ?? '' }),
    });
    setTimeout(() => setHotkeyMsg(null), 4000);
  }, [hotkey, t]);

  // ---- Offline translation (Part A4) ----------------------------------------
  const toggleOffline = useCallback(
    async (enabled: boolean) => {
      await apiSaveSettings({ offlineEnabled: enabled });
      await refreshSettings();
      if (enabled && !offlineStatus.downloaded) {
        // Start the ~600MB download immediately; progress streams via
        // onOfflineProgress (main-process 'offline:progress' events).
        await apiOfflineDownload();
      }
      await refreshOfflineStatus();
    },
    [offlineStatus.downloaded, refreshSettings, refreshOfflineStatus]
  );

  // ---- Check for updates (Part A1) -------------------------------------------
  const checkUpdates = useCallback(async () => {
    setUpdateState({ phase: 'checking' });
    const result = await apiUpdateCheck();
    if (result.available && result.version) {
      setUpdateState({ phase: 'available', version: result.version });
    } else if (result.error) {
      setUpdateState({ phase: 'error', msg: result.error });
    } else {
      setUpdateState({ phase: 'done' });
    }
  }, []);

  const downloading = offlineStatus.downloading;
  const downloadPct = offlineStatus.progress != null ? Math.round(offlineStatus.progress * 100) : 0;
  const loadedMB = offlineStatus.loadedBytes != null ? Math.round(offlineStatus.loadedBytes / (1024 * 1024)) : 0;
  const totalMB = offlineStatus.totalBytes != null ? Math.round(offlineStatus.totalBytes / (1024 * 1024)) : 0;

  return (
    <div className="panel settings-panel">
      <div className="settings-scroll">
        <h3>{t('settings.title')}</h3>

        <div className="form">
          <label className="field">
            <span>{t('settings.provider')}</span>
            <select value={provider} onChange={(e) => applyProviderPreset(e.target.value as ProviderId)}>
              <option value="custom">{PROVIDER_PRESETS.custom.name}</option>
              <option value="deepseek">{PROVIDER_PRESETS.deepseek.name}</option>
              <option value="kimi">{PROVIDER_PRESETS.kimi.name}</option>
            </select>
            <small>{t('settings.providerHint')}</small>
          </label>

          <label className="field">
            <span>{t('settings.uiLanguage')}</span>
            <select value={locale} onChange={(e) => void setLocale(e.target.value as Locale)}>
              <option value="zh">{t('langs.zh')}</option>
              <option value="en">{t('langs.en')}</option>
            </select>
            <small>{t('settings.uiLanguageHint')}</small>
          </label>

          <label className="field">
            <span>{t('settings.apiKey')}</span>
            <input
              type="password"
              value={apiKey}
              placeholder={settings?.hasApiKey ? t('settings.apiKeySavedPlaceholder') : 'sk-…'}
              autoComplete="off"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <small>{t('settings.apiKeyHint')}</small>
          </label>

          <label className="field">
            <span>{t('settings.baseUrl')}</span>
            <input
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                setProvider('custom');
              }}
            />
            <small>{t('settings.baseUrlHint')}</small>
          </label>

          <label className="field">
            <span>{t('settings.model')}</span>
            <input
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setProvider('custom');
              }}
            />
            <small>{t('settings.modelHint')}</small>
          </label>

          <div className="field-row">
            <label className="field">
              <span>{t('settings.temperature')}</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </label>
            <label className="field">
              <span>{t('settings.maxTokens')}</span>
              <input type="number" min="1" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
            </label>
          </div>
        </div>

        {/* ---- Global hotkey (Part A3) ---- */}
        <section className="settings-section">
          <h4>{t('settings.hotkey')}</h4>
          <div className="hotkey-row">
            <input
              className="hotkey-input"
              value={hotkey}
              readOnly={!hotkeyCapture}
              placeholder={t('settings.hotkey')}
              onKeyDown={hotkeyCapture ? onHotkeyKeyDown : undefined}
              onFocus={() => setHotkeyCapture(true)}
              onBlur={() => setHotkeyCapture(false)}
              title={t('settings.hotkeyHint')}
            />
            <button className="btn small" onClick={() => void saveHotkey()}>
              {t('settings.save')}
            </button>
          </div>
          {hotkeyMsg && (
            <div className={hotkeyMsg.ok ? 'inline-success' : 'inline-error'}>
              {hotkeyMsg.ok ? '✓ ' : '⚠ '}
              {hotkeyMsg.text}
            </div>
          )}
          <small>{t('settings.hotkeyHint')}</small>
        </section>

        {/* ---- Offline translation (Part A4) ---- */}
        <section className="settings-section">
          <h4>{t('settings.offlineTitle')}</h4>
          <label className="check-row">
            <input
              type="checkbox"
              checked={offlineStatus.enabled}
              onChange={(e) => void toggleOffline(e.target.checked)}
            />
            <span>{t('settings.offlineToggle')}</span>
          </label>
          <small className="muted">{t('settings.offlineSizeWarning')}</small>

          {offlineStatus.downloading && (
            <div className="offline-progress">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${downloadPct}%` }} />
              </div>
              <span>
                {totalMB > 0
                  ? t('settings.offlineDownloadingMb', { loaded: loadedMB, total: totalMB })
                  : t('settings.offlineDownloading', { pct: downloadPct })}
              </span>
            </div>
          )}
          {!offlineStatus.downloading && offlineStatus.downloaded && (
            <div className="inline-success">✓ {t('settings.offlineDownloaded')}</div>
          )}
          {offlineStatus.error && (
            <div className="inline-error">⚠ {t('settings.offlineError', { msg: offlineStatus.error })}</div>
          )}
          {offlineStatus.enabled && !offlineStatus.downloaded && !offlineStatus.downloading && (
            <button className="btn small" onClick={() => void apiOfflineDownload()}>
              {t('settings.offlineDownload')}
            </button>
          )}
        </section>

        {/* ---- History auto-clean (Part 1g: 历史体积管理) ---- */}
        <section className="settings-section">
          <h4>{t('settings.historyAutoDelete')}</h4>
          <label className="field">
            <span>{t('settings.historyAutoDeleteDays')}</span>
            <input
              type="number"
              min="0"
              value={autoDeleteDays}
              onChange={(e) => setAutoDeleteDays(e.target.value)}
            />
            <small>{t('settings.historyAutoDeleteHint')}</small>
          </label>
        </section>

        {/* ---- Check for updates (Part A1) ---- */}
        <section className="settings-section">
          <h4>{t('settings.checkUpdates')}</h4>
          <div className="hotkey-row">
            <button
              className="btn"
              onClick={() => void checkUpdates()}
              disabled={updateState.phase === 'checking'}
            >
              {updateState.phase === 'checking' ? t('settings.checkingUpdates') : t('settings.checkUpdates')}
            </button>
            {updateState.phase === 'available' && (
              <button className="btn small accent" onClick={() => void apiUpdateOpenDownload()}>
                {t('settings.updateOpenPage')} (v{updateState.version})
              </button>
            )}
          </div>
          {updateState.phase === 'done' && <div className="inline-success">✓ {t('settings.upToDate')}</div>}
          {updateState.phase === 'error' && (
            <div className="inline-error">⚠ {updateState.msg || t('settings.updateError')}</div>
          )}
          {updateState.phase === 'available' && (
            <div className="inline-success">✓ {t('settings.updateAvailable', { version: updateState.version })}</div>
          )}
        </section>

        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.ok ? '✓ ' : '✗ '}
            {testResult.msg}
            {typeof testResult.ms === 'number' && ` (${testResult.ms} ms)`}
          </div>
        )}

        <div className="settings-info">
          <h4>{t('settings.howToTitle')}</h4>
          <p>{t('settings.howToBody')}</p>
        </div>
      </div>

      {/* v3.0.1: Save / Test live in a fixed footer pinned to the bottom of the
          window (flex-shrink: 0, white background, top border). They never
          scroll away with the content. */}
      <div className="settings-actions">
        {saveError && <div className="inline-error">⚠ {t('settings.saveFailed')}</div>}
        <button className="btn primary" onClick={() => void save()}>
          {saved ? t('settings.saved') : t('settings.save')}
        </button>
        <button className="btn" onClick={() => void test()} disabled={testing}>
          {testing ? t('settings.testing') : t('settings.test')}
        </button>
      </div>
    </div>
  );
}
