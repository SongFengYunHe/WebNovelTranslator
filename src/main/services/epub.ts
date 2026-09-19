/**
 * 通过 epub-gen 导出 EPUB（A5 部分）。每个章节成为一个 EPUB 章节，原文与译文
 * 并排展示（先是原文，然后是分隔线，再是译文）。
 */
import { dialog, type BrowserWindow } from 'electron';
import path from 'path';
import EpubGen from 'epub-gen';
import type { EpubRequest } from '../../shared/types';
import log from '../logger';
import { mt } from '../i18n';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function paragraphsToHtml(text: string): string {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('\n');
}

export interface EpubExportResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

/**
 * 询问保存位置并写入 EPUB。返回写入的路径。
 */
export async function exportEpub(
  getWindow: () => BrowserWindow | null,
  request: EpubRequest
): Promise<EpubExportResult> {
  const win = getWindow();
  const defaultName = `${(request.defaultTitle || 'novel').replace(/[\\/:*?"<>|]/g, '_')}.epub`;

  const saveOpts = {
    title: mt('main.epub.exportTitle'),
    defaultPath: path.join(require('os').homedir(), 'Downloads', defaultName),
    filters: [{ name: mt('main.epub.filter'), extensions: ['epub'] }],
  };
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, saveOpts)
    : await dialog.showSaveDialog(saveOpts);
  if (canceled || !filePath) {
    return { ok: false, error: mt('main.epub.cancelled') };
  }

  const content = request.chapters.map((ch, i) => ({
    title: ch.title || mt('main.epub.chapterLabel', { index: i + 1 }),
    data: `
      <h3>${escapeHtml(ch.title || mt('main.epub.chapterLabel', { index: i + 1 }))}</h3>
      <div style="border-bottom:1px solid #ccc;padding-bottom:8px;">
        <strong>${mt('main.epub.original')}</strong>
      </div>
      ${paragraphsToHtml(ch.original)}
      <hr/>
      <div style="padding-top:4px;">
        <strong>${mt('main.epub.translation')}</strong>
      </div>
      ${paragraphsToHtml(ch.translated)}
    `,
  }));

  const options = {
    title: request.defaultTitle || 'Novel',
    author: mt('main.appName'),
    publisher: mt('main.appName'),
    // 语言元数据跟随界面语言；中文时方便阅读器正确选择字体与排版。
    lang: mt('main.epub.lang'),
    content,
  };

  try {
    const epub = new EpubGen(options, filePath);
    await epub.promise;
    log.info(`[epub] written to ${filePath} (${content.length} chapters)`);
    return { ok: true, filePath };
  } catch (err) {
    log.error('[epub] export failed:', err);
    return { ok: false, error: mt('main.epub.failed', { msg: (err as Error).message }) };
  }
}
