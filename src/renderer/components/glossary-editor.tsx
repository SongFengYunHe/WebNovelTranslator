/**
 * GlossaryEditor - full CRUD for glossaries:
 *  - create / rename / delete multiple glossaries
 *  - each glossary has a simple editable table of source -> target pairs
 *  - active glossary selector (injected into the translation prompt)
 */
import React, { useCallback, useEffect, useState } from 'react';
import { useApp } from '../contexts/app-context';
import { useI18n } from '../contexts/i18n-context';
import type { GlossaryEntry } from '../../shared/types';
import {
  apiGlossaryCreate,
  apiGlossaryDelete,
  apiGlossaryRename,
  apiGlossarySetActive,
  apiGlossaryUpdateEntries,
} from '../services/api';

export default function GlossaryEditor() {
  const { settings, glossaries, refreshGlossaries, refreshSettings } = useApp();
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [saved, setSaved] = useState(false);

  const selected = glossaries.find((g) => g.id === selectedId) ?? null;

  // Auto-select the first glossary on first load.
  useEffect(() => {
    if (!selectedId && glossaries.length > 0) setSelectedId(glossaries[0].id);
  }, [glossaries, selectedId]);

  // Load entries when selection changes.
  useEffect(() => {
    const g = glossaries.find((x) => x.id === selectedId);
    if (g) setEntries(g.entries.map((e) => ({ ...e })));
  }, [selectedId, glossaries]);

  const handleCreate = useCallback(async () => {
    const g = await apiGlossaryCreate(newName);
    await refreshGlossaries();
    setSelectedId(g.id);
    setNewName('');
  }, [newName, refreshGlossaries]);

  const handleDelete = useCallback(
    async (id: string) => {
      const g = glossaries.find((x) => x.id === id);
      if (!window.confirm(t('glossary.deleteConfirm', { name: g?.name ?? id }))) return;
      const list = await apiGlossaryDelete(id);
      setEntries([]);
      setSelectedId(list.length ? list[0].id : null);
      await refreshGlossaries();
      await refreshSettings();
    },
    [glossaries, refreshGlossaries, refreshSettings, t]
  );

  const commitRename = useCallback(
    async (id: string) => {
      if (renameValue.trim()) await apiGlossaryRename(id, renameValue);
      setRenameId(null);
      await refreshGlossaries();
    },
    [renameValue, refreshGlossaries]
  );

  const updateEntry = (idx: number, field: 'source' | 'target', value: string) => {
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, [field]: value } : e)));
  };

  const addRow = () => setEntries((prev) => [...prev, { source: '', target: '' }]);

  const removeRow = (idx: number) => setEntries((prev) => prev.filter((_, i) => i !== idx));

  const saveEntries = useCallback(async () => {
    if (!selectedId) return;
    const clean = entries.filter((e) => e.source.trim() || e.target.trim());
    await apiGlossaryUpdateEntries(selectedId, clean);
    await refreshGlossaries();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }, [selectedId, entries, refreshGlossaries]);

  const changeActive = useCallback(
    async (id: string) => {
      await apiGlossarySetActive(id || null);
      await refreshSettings();
    },
    [refreshSettings]
  );

  return (
    <div className="panel glossary-panel">
      <div className="glossary-layout">
        {/* -------- Glossary list -------- */}
        <aside className="glossary-sidebar">
          <h3>{t('glossary.title')}</h3>

          <div className="active-select">
            <label htmlFor="activeGlossary">{t('glossary.active')}</label>
            <select
              id="activeGlossary"
              value={settings?.activeGlossaryId ?? ''}
              onChange={(e) => changeActive(e.target.value)}
            >
              <option value="">{t('glossary.none')}</option>
              {glossaries.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>

          <ul className="glossary-list">
            {glossaries.map((g) => (
              <li
                key={g.id}
                className={`glossary-item${g.id === selectedId ? ' selected' : ''}`}
                onClick={() => setSelectedId(g.id)}
              >
                {renameId === g.id ? (
                  <input
                    className="rename-input"
                    value={renameValue}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(g.id);
                      if (e.key === 'Escape') setRenameId(null);
                    }}
                    onBlur={() => void commitRename(g.id)}
                  />
                ) : (
                  <>
                    <span className="glossary-name">{g.name}</span>
                    <span className="glossary-count">{g.entries.length}</span>
                    <span className="glossary-actions">
                      <button
                        className="mini-btn"
                        title={t('glossary.rename')}
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenameId(g.id);
                          setRenameValue(g.name);
                        }}
                      >
                        ✎
                      </button>
                      <button
                        className="mini-btn danger"
                        title={t('glossary.delete')}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDelete(g.id);
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>

          <div className="new-glossary">
            <input
              placeholder={t('glossary.newNamePlaceholder')}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
            />
            <button className="btn small" onClick={() => void handleCreate()}>
              {t('glossary.add')}
            </button>
          </div>
        </aside>

        {/* -------- Entry table -------- */}
        <section className="glossary-editor">
          <div className="editor-header">
            <h3>{selected ? selected.name : t('glossary.noSelection')}</h3>
            <div className="editor-actions">
              <button className="btn small" onClick={addRow} disabled={!selected}>
                {t('glossary.addRow')}
              </button>
              <button className="btn small primary" onClick={() => void saveEntries()} disabled={!selected}>
                {saved ? t('glossary.saved') : t('glossary.save')}
              </button>
            </div>
          </div>

          {selected ? (
            <table className="entry-table">
              <thead>
                <tr>
                  <th>{t('glossary.sourceTerm')}</th>
                  <th></th>
                  <th>{t('glossary.targetTerm')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        value={entry.source}
                        placeholder="例如：火球术"
                        onChange={(e) => updateEntry(i, 'source', e.target.value)}
                      />
                    </td>
                    <td className="arrow-cell">→</td>
                    <td>
                      <input
                        value={entry.target}
                        placeholder="例如：火球术的译文"
                        onChange={(e) => updateEntry(i, 'target', e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        className="mini-btn danger"
                        title={t('glossary.removeRow')}
                        onClick={() => removeRow(i)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">
              {t('glossary.emptyHint1')} <code>source -&gt; target</code> {t('glossary.emptyHint2')}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
