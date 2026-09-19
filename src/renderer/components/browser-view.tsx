/**
 * BrowserView —— 内置页面加载器与文本提取。
 *
 * 使用沙箱化的 <webview> 加载任意章节 URL，并按下述优先级提取干净的章节文本：
 *   1. 用户手动选中的文本（window.getSelection().toString()）——比任何算法都准
 *   2. Mozilla Readability 对整页 HTML 做正文识别（P5 接入）
 *   3. 兜底：常见站点选择器（article、.chapter-content、#content，……）→ body 文本
 * 阅读前会剥离导航/广告/脚本。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Readability } from '@mozilla/readability';
import { useApp } from '../contexts/app-context';
import { useI18n } from '../contexts/i18n-context';

/** 注入到访客页面中取用户选区。 */
const SELECTION_JS = '(window.getSelection && window.getSelection().toString()) || ""';

/** 注入到访客页面中取整页 HTML，正文识别在本进程完成。 */
const PAGE_HTML_JS = 'document.documentElement.outerHTML';

/**
 * 兜底用的选择器方案：注入到访客页面中，在页面自身的上下文里运行。
 * Readability 判定该页无正文（或解析失败）时才会走到这里。
 */
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

/** 轻量清洗：保留段落换行，只压掉多余的空格与空行。 */
function normalizeText(input: string): string {
  return input
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 用 Mozilla Readability 从整页 HTML 中识别正文。
 *
 * 解析在本进程完成（不是注入到访客页面里），因此这段代码运行在我们自己的沙箱中，
 * 只拿到一段 HTML 字符串。
 *
 * 返回 null 表示 Readability 认为该页没有正文——调用方据此回落到选择器方案。
 */
function extractWithReadability(html: string, pageUrl: string): string | null {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    try {
      // Readability 依据 baseURI 解析相对地址；解析出的文档继承的是本应用页面的
      // 地址，这里改回访客页面的地址，避免相对路径被算到错误的源上。
      Object.defineProperty(doc, 'baseURI', { value: pageUrl });
    } catch {
      /* 该属性在个别环境不可覆盖——只影响链接解析，不影响正文文本 */
    }
    const article = new Readability(doc).parse();
    const text = normalizeText(article?.textContent ?? '');
    // 与选择器方案保持一致的门槛：太短的结果更可能是导航/版权声明而非正文。
    return text.length > 80 ? text : null;
  } catch {
    return null;
  }
}

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
      const pageUrl = (wv.getURL ? wv.getURL() : '') || url;

      // 1) 用户手动选中的文本优先。
      let text = normalizeText(String((await wv.executeJavaScript(SELECTION_JS)) ?? ''));
      // 2) 整页交给 Readability 识别正文。
      if (text.length <= 20) {
        const html = String((await wv.executeJavaScript(PAGE_HTML_JS)) ?? '');
        text = extractWithReadability(html, pageUrl) ?? '';
      }
      // 3) 兜底：站点选择器 → body 文本。
      if (!text) text = normalizeText(String((await wv.executeJavaScript(EXTRACT_JS)) ?? ''));

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
