/**
 * 把长章节切分成足够小、可放入单次对话请求的单元。
 *
 * 把整章作为一条消息发送，可能触及模型的上下文上限，并产生一大堵无法上报进度的
 * 文本墙。分块后可并行翻译、上报进度并被取消。
 *
 * 段落结构得以保留：分块在段落边界处断开，调用方用单个换行符重新拼接译文分块——
 * 正是对照视图再次拆分时使用的分隔符。
 *
 * 无依赖，因此可直接单元测试。
 */

/**
 * 每个分块的软性字符预算。刻意保守：即便按每个 CJK 字符约 2 个 token 计，也远在
 * 应用支持的最小模型（8k）的上下文窗口之内，并给提示词和回复留出空间。
 */
export const DEFAULT_CHUNK_MAX_CHARS = 3000;

/** 类句子终止符，覆盖 CJK 与拉丁标点。 */
const SENTENCE_BREAK = /(?<=[.!?。！？；;])\s*/;

/**
 * 把 `text` 切分成最多 `maxChars` 个字符的分块。
 *
 * 段落被贪婪地打包。若某个段落本身就超过预算，则按句子边界切分，而单个超长句子
 * 作为最后手段被硬切，因此返回的任何分块都不会超过 `maxChars`。
 *
 * 空白输入返回 `[]`。
 */
export function chunkText(text: string, maxChars: number = DEFAULT_CHUNK_MAX_CHARS): string[] {
  const budget = Math.max(1, Math.floor(maxChars));
  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return [];

  const chunks: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;

  const flush = () => {
    if (buf.length) {
      chunks.push(buf.join('\n'));
      buf = [];
      bufLen = 0;
    }
  };

  for (const para of paragraphs) {
    if (para.length > budget) {
      flush();
      chunks.push(...splitOversized(para, budget));
      continue;
    }
    // +1 是拼接该段落与缓冲区时所需换行符占用的位置。
    const projected = buf.length === 0 ? para.length : bufLen + 1 + para.length;
    if (projected > budget && buf.length > 0) {
      flush();
      buf.push(para);
      bufLen = para.length;
    } else {
      buf.push(para);
      bufLen = projected;
    }
  }
  flush();
  return chunks;
}

/**
 * 拆解单个超长段落。
 *
 * 先按句子终止符切分，再对仍然超过预算的句子做硬切。仅在单个段落就超出整个分块
 * 预算时使用——这是罕见情况（没有空行的密集对话）。
 */
function splitOversized(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  const sentences = paragraph.split(SENTENCE_BREAK).filter((s) => s.length > 0);

  let buf = '';
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (buf) {
        pieces.push(buf);
        buf = '';
      }
      for (let i = 0; i < sentence.length; i += maxChars) {
        pieces.push(sentence.slice(i, i + maxChars));
      }
      continue;
    }
    if (buf.length + sentence.length > maxChars) {
      pieces.push(buf);
      buf = '';
    }
    buf += sentence;
  }
  if (buf) pieces.push(buf);
  return pieces;
}