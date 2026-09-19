import React, { useEffect } from 'react';
import { useApp, type TabId } from './contexts/app-context';
import { useI18n } from './contexts/i18n-context';
import type { TranslationKey } from './i18n';
import TranslationPanel from './components/translation-panel';
import BrowserView from './components/browser-view';
import GlossaryEditor from './components/glossary-editor';
import HistoryPage from './components/history-page';
import SettingsPage from './components/settings-page';

// v3.0.0：术语表是核心功能——被提升到紧跟在「翻译」之后、「设置」之前，
// 使其始终距翻译仅一次点击。
const TABS: { id: TabId; labelKey: TranslationKey }[] = [
  { id: 'translate', labelKey: 'app.tabs.translate' },
  { id: 'glossary', labelKey: 'app.tabs.glossary' },
  { id: 'browser', labelKey: 'app.tabs.browser' },
  { id: 'history', labelKey: 'app.tabs.history' },
  { id: 'settings', labelKey: 'app.tabs.settings' },
];

export default function App() {
  const { tab, setTab, toast, settings, offlineStatus, health } = useApp();
  const { t } = useI18n();

  // 让窗口标题跟随当前界面语言（HTML <title> 会覆盖主进程设置的标题）。
  useEffect(() => {
    document.title = t('app.title');
  }, [t]);

  // E7 部分：尚未配置任何内容时的友好引导横幅。
  // 配置了 API 密钥或开启离线模式后永久隐藏，避免遮挡主内容。
  const showOnboarding =
    settings && !settings.hasApiKey && !offlineStatus.enabled;

  // P1 部分：历史数据库会降级为空操作而不是让应用崩溃。明确说明这一点，
  // 而不是永远显示空的历史列表。
  const dbUnavailable = health !== null && !health.database.ok;

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="app-logo">🌐</span> {t('app.title')}
        </div>
        <nav className="tabs" aria-label="导航">
          {TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              className={`tab${tab === tabDef.id ? ' active' : ''}`}
              onClick={() => setTab(tabDef.id)}
            >
              {t(tabDef.labelKey)}
            </button>
          ))}
        </nav>
        {/* v3.0.1：真正的「最小化」——窗口保留在任务栏上；隐藏则通过 ✕
            按钮或托盘菜单完成。 */}
        <button
          className="icon-btn window-btn"
          title={t('app.minimize')}
          onClick={() => window.electronAPI.panelMinimize()}
        >
          –
        </button>
        {/* v3.0.0：无边框弹窗上清晰可见的关闭按钮。 */}
        <button
          className="icon-btn window-btn close"
          title={t('app.closeWindow')}
          onClick={() => window.electronAPI.panelClose()}
        >
          ✕
        </button>
      </header>

      {dbUnavailable && (
        <div className="error-banner health-banner">
          ⚠ {t('health.dbUnavailable')}
        </div>
      )}

      <main
        className={`app-body${tab === 'settings' ? ' is-settings' : ''}${
          showOnboarding && tab !== 'settings' ? ' with-banner' : ''
        }`}
      >
        {tab === 'translate' && <TranslationPanel />}
        {tab === 'browser' && <BrowserView />}
        {tab === 'glossary' && <GlossaryEditor />}
        {tab === 'history' && <HistoryPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>

      {showOnboarding && (
        <div className="onboarding-banner">
          <span className="onboarding-text">
            <strong>💡 {t('onboarding.title')}</strong> — {t('onboarding.body')}
          </span>
          <button className="btn small" onClick={() => setTab('settings')}>
            {t('onboarding.goSettings')}
          </button>
        </div>
      )}

      {toast && (
        <div className="toast">
          <div className="toast-title">{toast.title}</div>
          <div className="toast-body">{toast.body}</div>
        </div>
      )}
    </div>
  );
}
