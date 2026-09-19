/**
 * HistoryPage（A2 部分）：
 *  - 保存的翻译（SQLite）的可检索、分页表格
 *  - 点击某行查看完整原文 + 译文
 *  - 「重新翻译」把原文加载回「翻译」标签页
 *  - 将全部历史导出为 CSV / JSON，或将当前详情导出为 EPUB
 *  - 带确认对话框的「全部清除」
 *
 * 翻译历史页：支持检索/分页/详情/重新翻译/导出，并提供按天数清理
 * （清除30天前记录）以控制数据库体积增长。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../contexts/app-context';
import { useI18n } from '../contexts/i18n-context';
import type { HistoryEntry } from '../../shared/types';
import {
  apiHistoryClear,
  apiHistoryClearOlder,
  apiHistoryDelete,
  apiHistoryExport,
  apiHistoryList,
} from '../services/api';

const PAGE_SIZE = 20;

export default function HistoryPage() {
  const { loadTextIntoTranslator, setTab } = useApp();
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<HistoryEntry | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'json' | 'epub' | null>(null);
  const [message, setMessage] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiHistoryList({ search: debounced, page, pageSize: PAGE_SIZE });
      setItems(result.items);
      setTotal(result.total);
    } catch {
      /* ignore —— 失败时历史表格保持为空 */
    } finally {
      setLoading(false);
    }
  }, [debounced, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleDelete = useCallback(
    async (id: number) => {
      if (!window.confirm(t('history.deleteConfirm'))) return;
      await apiHistoryDelete(id);
      if (detail?.id === id) setDetail(null);
      await load();
    },
    [detail, load, t]
  );

  const handleClear = useCallback(async () => {
    if (!window.confirm(t('history.clearConfirm'))) return;
    await apiHistoryClear();
    setDetail(null);
    await load();
    setMessage(t('history.cleared'));
    setTimeout(() => setMessage(''), 2000);
  }, [load, t]);

  // 一键清除 30 天前的记录，防止数据库无限增长。
  const handleClearOlder = useCallback(async () => {
    if (!window.confirm(t('history.clear30Confirm'))) return;
    await apiHistoryClearOlder(30);
    await load();
    setMessage(t('history.cleared30'));
    setTimeout(() => setMessage(''), 2000);
  }, [load, t]);

  const handleExport = useCallback(
    async (kind: 'csv' | 'json') => {
      setExporting(kind);
      const result = await apiHistoryExport({ kind });
      if (result.ok) {
        setMessage(t('history.exported'));
        setTimeout(() => setMessage(''), 2000);
      } else if (result.error) {
        setMessage(result.error);
        setTimeout(() => setMessage(''), 3000);
      }
      setExporting(null);
    },
    [t]
  );

  const handleReTranslate = useCallback(
    (entry: HistoryEntry) => {
      setDetail(null);
      loadTextIntoTranslator(entry.source_text);
      setTab('translate');
    },
    [loadTextIntoTranslator, setTab]
  );

  const handleExportEpub = useCallback(async () => {
    if (!detail) return;
    setExporting('epub');
    const result = await window.electronAPI.epubExport({
      chapters: [
        {
          title: detail.chapter_title || t('translate.chapterTitle'),
          original: detail.source_text,
          translated: detail.translated_text,
        },
      ],
      defaultTitle: detail.chapter_title || 'translation',
    });
    if (result.ok) {
      setMessage(t('history.exported'));
      setTimeout(() => setMessage(''), 2000);
    } else if (result.error) {
      setMessage(result.error);
      setTimeout(() => setMessage(''), 3000);
    }
    setExporting(null);
  }, [detail, t]);

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleString('zh-CN', { hour12: false });

  return (
    <div className="panel history-panel">
      <div className="toolbar">
        <input
          className="search-input"
          placeholder={t('history.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn" onClick={() => void handleExport('csv')} disabled={exporting !== null}>
          {exporting === 'csv' ? '…' : t('history.exportCsv')}
        </button>
        <button className="btn" onClick={() => void handleExport('json')} disabled={exporting !== null}>
          {exporting === 'json' ? '…' : t('history.exportJson')}
        </button>
        <button className="btn" onClick={() => void handleClearOlder()}>
          {t('history.clear30Days')}
        </button>
        <button className="btn danger" onClick={() => void handleClear()}>
          {t('history.clearAll')}
        </button>
        <span className="history-total">{t('history.total', { total })}</span>
      </div>

      {message && <div className="inline-success">✓ {message}</div>}
      {loading && <div className="spinner-row">{t('translate.translating')}</div>}

      {!loading && items.length === 0 ? (
        <p className="muted">{t('history.empty')}</p>
      ) : (
        <table className="history-table">
          <thead>
            <tr>
              <th>{t('history.time')}</th>
              <th>{t('history.chapter')}</th>
              <th>{t('history.langs')}</th>
              <th>{t('history.sourceText')}</th>
              <th>{t('history.translatedText')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id} onClick={() => setDetail(entry)} className="history-row">
                <td className="nowrap">{fmtTime(entry.timestamp)}</td>
                <td className="chapter-cell">{entry.chapter_title || '—'}</td>
                <td className="nowrap">
                  {entry.source_lang} → {entry.target_lang}
                </td>
                <td className="cell-clip">{entry.source_text}</td>
                <td className="cell-clip">{entry.translated_text}</td>
                <td className="row-actions">
                  <button
                    className="mini-btn"
                    title={t('history.reTranslate')}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleReTranslate(entry);
                    }}
                  >
                    ↻
                  </button>
                  <button
                    className="mini-btn danger"
                    title={t('history.delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDelete(entry.id);
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button className="btn small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t('history.prev')}
          </button>
          <span>{t('history.pagination', { page, pages: totalPages })}</span>
          <button
            className="btn small"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('history.next')}
          </button>
        </div>
      )}

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t('history.detailTitle')}</h3>
              <button className="mini-btn" onClick={() => setDetail(null)}>
                ✕
              </button>
            </div>
            <div className="modal-meta">
              <span>{detail.chapter_title || '—'}</span>
              <span>
                {detail.source_lang} → {detail.target_lang} · {fmtTime(detail.timestamp)}
              </span>
            </div>
            <div className="modal-body">
              <div className="detail-col">
                <div className="detail-label">{t('history.sourceText')}</div>
                <pre className="detail-text">{detail.source_text}</pre>
              </div>
              <div className="detail-col">
                <div className="detail-label">{t('history.translatedText')}</div>
                <pre className="detail-text">{detail.translated_text}</pre>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn primary" onClick={() => handleReTranslate(detail)}>
                {t('history.reTranslate')}
              </button>
              <button className="btn" onClick={() => void handleExportEpub()} disabled={exporting !== null}>
                {exporting === 'epub' ? '…' : t('history.exportEpub')}
              </button>
              <button className="btn" onClick={() => setDetail(null)}>
                {t('history.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
