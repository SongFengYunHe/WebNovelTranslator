/**
 * BrowserView —— 内置页面加载器与文本提取。
 *
 * 使用沙箱化的 <webview> 加载任意章节 URL，然后注入 JavaScript 提取干净的章节文本：
 *   1. 若用户选中了文本，则用 window.getSelection().toString()
 *   2. 常见的章节选择器（article、.chapter-content、#content，……）
 *   3. 回落到 document.body.innerText
 * 阅读前会剥离导航/广告/脚本。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../contexts/app-context';
import { useI18n } from '../contexts/i18n-context';

/** 注入到访客页面中。在页面自身的上下文中运行。 */
const EXTRACT_JS = `
(function () {
  function norm(s) { return (s || '').replace(/\\u00a0/g, ' ').replace(/[ \\t]+/g, ' ').trim(); }
  function stripAndRead(root) {
    var clone = root.cloneNode(true);
    var kill = 'script, style, noscript, nav, header, footer, aside, form, iframe, canvas, video, audio, .nav, .menu, .ad, .ads, .advert, .advertisement, [class*="ad-"], [id*="ad-"], [class*="share"], [class*="comment"], .related, .breadcrumb, .sidebar, .footer';
    clone.querySelectorAll(kill).forEach(function (el) { el.remove(); });
    return norm(clone.innerText || clone.textContent || '');
  }
  var text = '';
  var sel = window.getSelection && window.getSelection().toString();
  if (sel && sel.trim().length > 20) {
    text = norm(sel);
  } else {
    var selectors = ['article', '.chapter-content', '#content', '.post-body', '.read-content', '.article-content', '.chapter-body', '.novel-content'];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) {
        var t = stripAndRead(el);
        if (t.length > 80) { text = t; break; }
      }
    }
    if (!text) text = stripAndRead(document.body);
  }
  return text;
})()
`;

export default function BrowserView() {
  const { loadTextIntoTranslator } = useApp();
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [extracted, setExtracted] = useState('');
  const webviewRef = useRef<HTMLWebViewElement | null>(null);

  const onDomReady = useCallback(() => {
    setLoading(false);
    const wv = webviewRef.current;
    if (wv) {
      setPageTitle(wv.getTitle ? wv.getTitle() : '');
    }
    setStatus(t('browser.statusLoaded'));
  }, [t]);

  const onDidFailLoad = useCallback(() => {
    setLoading(false);
    setStatus(t('browser.statusFail'));
  }, [t]);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    wv.addEventListener('dom-ready', onDomReady);
    wv.addEventListener('did-fail-load', onDidFailLoad);
    return () => {
      wv.removeEventListener('dom-ready', onDomReady);
      wv.removeEventListener('did-fail-load', onDidFailLoad);
    };
  }, [onDomReady, onDidFailLoad]);

  const loadUrl = () => {
    const target = url.trim();
    if (!target) return;
    const withProto = /^https?:\/\//i.test(target) ? target : `https://${target}`;
    const wv = webviewRef.current;
    if (wv) {
      setLoading(true);
      setStatus(t('browser.loading'));
      setPageTitle('');
      setExtracted('');
      wv.loadURL(withProto);
    }
  };

  const extract = async () => {
    const wv = webviewRef.current;
    if (!wv) {
      setStatus(t('browser.statusNoPage'));
      return;
    }
    try {
      setStatus(t('browser.statusExtracting'));
      const result = await wv.executeJavaScript(EXTRACT_JS);
      const text = String(result ?? '').trim();
      setExtracted(text);
      setStatus(
        text
          ? t('browser.statusExtracted', { count: text.length })
          : t('browser.statusNoText')
      );
    } catch (err) {
      setStatus(t('browser.statusExtractError', { msg: (err as Error)?.message }));
    }
  };

  const sendToTranslate = () => {
    if (!extracted.trim()) return;
    loadTextIntoTranslator(extracted);
  };

  return (
    <div className="panel browser-panel">
      <div className="toolbar">
        <input
          className="url-input"
          placeholder={t('browser.urlPlaceholder')}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && loadUrl()}
        />
        <button className="btn primary" onClick={loadUrl} disabled={loading}>
          {loading ? t('browser.loading') : t('browser.open')}
        </button>
        <button className="btn" onClick={extract}>
          {t('browser.extract')}
        </button>
        <button
          className="btn accent"
          onClick={sendToTranslate}
          disabled={!extracted.trim()}
          title={t('browser.sendToTranslatorTitle')}
        >
          {t('browser.sendToTranslator')}
        </button>
      </div>

      <div className="status-bar">
        {pageTitle && <span className="page-title">📄 {pageTitle}</span>}
        <span className="status-text">{status || t('browser.statusIdle')}</span>
      </div>

      <div className="webview-wrap">
        <webview
          ref={webviewRef}
          className="webview"
          partition="persist:novel"
          src="about:blank"
          allowpopups={false}
          webpreferences="contextIsolation=yes, sandbox=yes, nodeIntegration=no"
        />
      </div>

      {extracted && (
        <div className="extracted-wrap">
          <div className="extracted-header">
            <span>{t('browser.extractedHeader', { count: extracted.length })}</span>
            <button className="btn small" onClick={() => setExtracted('')}>
              {t('browser.clear')}
            </button>
          </div>
          <pre className="extracted-text">{extracted}</pre>
        </div>
      )}
    </div>
  );
}
