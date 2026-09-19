/**
 * TranslationPanel - the main "Translate" tab.
 *  - source / target language dropdowns
 *  - optional chapter title (recorded in history + EPUB export)
 *  - original text input
 *  - side-by-side alternating paragraph display of original vs translation
 *  - copy, EPUB export and clear actions
 *
 * 主翻译页：段落级对照展示原文与译文，支持复制与 EPUB 导出。
 */
import React, { useCallback, useMemo, useState } from 'react';
import { useApp, LANGUAGES } from '../contexts/app-context';
import { useI18n } from '../contexts/i18n-context';
import { apiGlossarySetActive } from '../services/api';
import type { TranslateEngine } from '../../shared/types';

export default function TranslationPanel() {
  const {
    settings,
    glossaries,
    activeGlossary,
    refreshSettings,
    translation,
    translateText,
    clearTranslation,
    chapterTitle,
    setChapterTitle,
    progress,
    cancelTranslation,
  } = useApp();
  const { t } = useI18n();
  const [sourceLang, setSourceLang] = useState(settings?.sourceLang ?? 'zh');
  const [targetLang, setTargetLang] = useState(settings?.targetLang ?? 'en');
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleTranslate = () => {
    const text = draft.trim();
    if (!text || translation.translating) return;
    void translateText(text, sourceLang, targetLang);
  };

  const handleCopy = async () => {
    if (!translation.translatedText) return;
    try {
      await navigator.clipboard.writeText(translation.translatedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable; ignore
    }
  };

  const handleExportEpub = useCallback(async () => {
    if (!translation.translatedText) return;
    setExporting(true);
    try {
      await window.electronAPI.epubExport({
        chapters: [
          {
            title: chapterTitle.trim() || t('translate.chapterTitle'),
            original: translation.originalText,
            translated: translation.translatedText,
          },
        ],
        defaultTitle: chapterTitle.trim() || 'translation',
      });
    } finally {
      setExporting(false);
    }
  }, [translation.originalText, translation.translatedText, chapterTitle, t]);

  const origParas = useMemo(
    () => translation.originalText.split(/\n+/).map((p) => p.trim()).filter(Boolean),
    [translation.originalText]
  );
  const transParas = useMemo(
    () => translation.translatedText.split(/\n+/).map((p) => p.trim()).filter(Boolean),
    [translation.translatedText]
  );
  const rowCount = Math.max(origParas.length, transParas.length);

  return (
    <div className="panel">
      <div className="toolbar">
        <label className="pair">
          <span className="pair-label">{t('pair.from')}</span>
          <select
            value={sourceLang}
            onChange={(e) => {
              setSourceLang(e.target.value);
              void window.electronAPI.saveSettings({ sourceLang: e.target.value });
            }}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {t(l.labelKey)}
              </option>
            ))}
          </select>
          <span className="arrow">→</span>
          <span className="pair-label">{t('pair.to')}</span>
          <select
            value={targetLang}
            onChange={(e) => {
              setTargetLang(e.target.value);
              void window.electronAPI.saveSettings({ targetLang: e.target.value });
            }}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {t(l.labelKey)}
              </option>
            ))}
          </select>
        </label>

        {/* v3.0.0: Glossary is a core feature — switch the active glossary
            right from the translate toolbar, no need to leave this tab. */}
        <label className="pair glossary-switch" title={t('glossary.switchTitle')}>
          <span className="pair-label">📖 {t('glossary.active')}</span>
          <select
            className="glossary-select"
            value={settings?.activeGlossaryId ?? ''}
            onChange={(e) => {
              void apiGlossarySetActive(e.target.value || null).then(() => refreshSettings());
            }}
          >
            <option value="">{t('glossary.none')}</option>
            {glossaries.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        {activeGlossary && (
          <span className="chip" title={t('glossary.activeChipTitle')}>
            ✓ {activeGlossary.name}
          </span>
        )}
        {translation.engine === 'offline' && (
          <span className="chip offline-chip" title={t('settings.offlineActive')}>
            📴 {t('settings.offlineActive')}
          </span>
        )}

        {/* Which engine to use. Previously this was decided silently, and the
            "enable offline" toggle was ignored whenever an API key existed. */}
        <label className="pair" title={t('engine.hint')}>
          <span className="pair-label">⚙ {t('engine.label')}</span>
          <select
            value={settings?.translateEngine ?? 'auto'}
            onChange={(e) => {
              void window.electronAPI
                .saveSettings({ translateEngine: e.target.value as TranslateEngine })
                .then(() => refreshSettings());
            }}
          >
            <option value="auto">{t('engine.auto')}</option>
            <option value="online">{t('engine.online')}</option>
            <option value="offline">{t('engine.offline')}</option>
          </select>
        </label>

        <button className="btn primary" onClick={handleTranslate} disabled={translation.translating}>
          {translation.translating ? t('translate.translating') : t('translate.button')}
        </button>
        {translation.translating && (
          <button className="btn ghost" onClick={() => void cancelTranslation()}>
            {t('translate.cancel')}
          </button>
        )}
        {!translation.translating && (translation.originalText || translation.translatedText) && (
          <button className="btn ghost" onClick={clearTranslation}>
            {t('translate.clear')}
          </button>
        )}
      </div>

      {translation.error && <div className="error-banner">⚠ {translation.error}</div>}

      <div className="input-area">
        <input
          className="chapter-input"
          placeholder={t('translate.chapterTitle')}
          value={chapterTitle}
          onChange={(e) => setChapterTitle(e.target.value)}
        />
        <textarea
          className="source-input"
          placeholder={t('translate.inputPlaceholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </div>

      {translation.translating && (
        <div className="spinner-row">
          {progress
            ? t('translate.progress', { done: progress.done, total: progress.total })
            : t('translate.translating')}
        </div>
      )}

      {translation.translatedText && (
        <div className="result-area">
          <div className="result-header">
            <div className="result-title">{t('result.title')}</div>
            <button className="btn small" onClick={() => void handleExportEpub()} disabled={exporting}>
              {exporting ? t('translate.epubExporting') : t('translate.epubExport')}
            </button>
            <button className="btn small" onClick={handleCopy}>
              {copied ? t('result.copied') : t('result.copy')}
            </button>
          </div>
          <div className="side-by-side">
            {Array.from({ length: rowCount }, (_, i) => (
              <div className="para-row" key={i}>
                <div className="para para-orig">{origParas[i] ?? ''}</div>
                <div className="para para-trans">{transParas[i] ?? ''}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
