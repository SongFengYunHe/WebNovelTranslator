/**
 * 通过 epub-gen 导出 EPUB（A5 部分）。每个章节成为一个 EPUB 章节，原文与译文
 * 并排展示（先是原文，然后是分隔线，再是译文）。
 */
import { dialog, type BrowserWindow } from 'electron';
import path from 'path';
import EpubGen from 'epub-gen';
import type { EpubRequest } from '../../shared/types';
import log from '../logger';

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
    title: '导出 EPUB',
    defaultPath: path.join(require('os').homedir(), 'Downloads', defaultName),
    filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
  };
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, saveOpts)
    : await dialog.showSaveDialog(saveOpts);
  if (canceled || !filePath) {
    return { ok: false, error: '已取消导出。' };
  }

  const content = request.chapters.map((ch, i) => ({
    title: ch.title || `第 ${i + 1} 章`,
    data: `
      <h3>${escapeHtml(ch.title || `第 ${i + 1} 章`)}</h3>
      <div style="border-bottom:1px solid #ccc;padding-bottom:8px;">
        <strong>原文</strong>
      </div>
      ${paragraphsToHtml(ch.original)}
      <hr/>
      <div style="padding-top:4px;">
        <strong>译文</strong>
      </div>
      ${paragraphsToHtml(ch.translated)}
    `,
  }));

  const options = {
    title: request.defaultTitle || 'Novel',
    author: 'Floating Web Novel Translator',
    publisher: 'Floating Web Novel Translator',
    // 导出 EPUB 元数据标记为中文，方便阅读器正确选择字体与排版。
    lang: 'zh',
    content,
  };

  try {
    const epub = new EpubGen(options, filePath);
    await epub.promise;
    log.info(`[epub] written to ${filePath} (${content.length} chapters)`);
    return { ok: true, filePath };
  } catch (err) {
    log.error('[epub] export failed:', err);
    return { ok: false, error: `EPUB 导出失败：${(err as Error).message}` };
  }
}
