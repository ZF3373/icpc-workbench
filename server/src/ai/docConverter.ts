/**
 * 文档转换器：把 Word/Excel/PPT/HTML/CSV/JSON/XML/EPub 文件转为 Markdown，
 * 供 AI 助手作为上下文注入对话。全部纯 JS 实现，无 Python/系统级依赖。
 *
 * 设计思路对标 microsoft/markitdown：各格式独立转换器，统一输出 Markdown，
 * 侧重保留文档结构（标题/列表/表格）而非高保真排版，面向 LLM 消费优化 token 效率。
 * PDF 走现有 unpdf 路径（见 pdf.ts），不在此模块内。
 */
import mammoth from 'mammoth';
import TurndownService from 'turndown';
// @ts-expect-error turndown-plugin-gfm 无类型声明
import * as turndownGfm from 'turndown-plugin-gfm';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

export interface ConvertResult {
  /** 转换后的 Markdown 文本 */
  text: string;
  /** 非致命问题（如部分页面无法解析），不阻止返回已提取内容 */
  warning?: string;
}

/** 提取后正文最大字符数，超出截断（与 PDF 路径一致） */
const MAX_TEXT_CHARS = 50000;

/** 文件扩展名 → 转换器映射表（不含 PDF，PDF 由 pdf.ts 单独处理） */
const EXT_CONVERTERS: Record<string, (data: Uint8Array, filename: string) => Promise<ConvertResult>> = {
  '.docx': convertDocx,
  '.xlsx': convertXlsx,
  '.xls': convertXlsx,
  '.pptx': convertPptx,
  '.html': convertHtml,
  '.htm': convertHtml,
  '.csv': convertCsv,
  '.json': convertJson,
  '.xml': convertXml,
  '.epub': convertEpub,
};

/** 支持的文档扩展名（用于前端 accept 和后端判断） */
export const DOCUMENT_EXTENSIONS = Object.keys(EXT_CONVERTERS);

/** content-type → 扩展名兜底映射（某些上传不带扩展名时） */
const CONTENT_TYPE_EXT: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'text/html': '.html',
  'application/json': '.json',
  'text/csv': '.csv',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'application/epub+zip': '.epub',
};

/** 从文件名或 content-type 推断扩展名（小写，带点） */
function detectExt(filename: string, contentType?: string): string | null {
  const lower = filename.toLowerCase();
  for (const ext of Object.keys(EXT_CONVERTERS)) {
    if (lower.endsWith(ext)) return ext;
  }
  if (contentType) {
    const ct = contentType.toLowerCase().split(';')[0].trim();
    if (CONTENT_TYPE_EXT[ct]) return CONTENT_TYPE_EXT[ct];
  }
  return null;
}

/** 判断是否为本模块支持的文档格式（不含 PDF / 图片 / 纯文本） */
export function isDocumentFile(filename: string, contentType?: string): boolean {
  return detectExt(filename, contentType) !== null;
}

/**
 * 按文件类型分发到对应转换器。不支持格式抛错，调用方兜底提示。
 * 文本为空时返回空 text + warning（如扫描型文档无文字层）。
 */
export async function convertDocument(
  data: Uint8Array,
  filename: string,
  contentType?: string,
): Promise<ConvertResult> {
  const ext = detectExt(filename, contentType);
  if (!ext) {
    throw new Error(`不支持的文件格式：${filename}（支持 docx/xlsx/pptx/html/csv/json/xml/epub）`);
  }
  const converter = EXT_CONVERTERS[ext];
  const result = await converter(data, filename);
  // 全局截断保护
  if (result.text.length > MAX_TEXT_CHARS) {
    result.text =
      result.text.slice(0, MAX_TEXT_CHARS) +
      `\n\n[…内容已截断，原文共 ${result.text.length} 字符]`;
  }
  return result;
}

// ==================== 各格式转换器 ====================

/** 共享的 turndown 实例（启用 GFM 表格支持） */
function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.use(turndownGfm.gfm);
  return td;
}

/** 从 Uint8Array 提取独立的 ArrayBuffer 副本（剥离 SharedArrayBuffer 类型和 byteOffset 偏移） */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/** Word (.docx)：mammoth 转 HTML → turndown 转 Markdown */
async function convertDocx(data: Uint8Array): Promise<ConvertResult> {
  const { value: html, messages } = await mammoth.convertToHtml(
    { buffer: Buffer.from(data) },
    { styleMap: ['p[style-name="Title"] => h1:fresh', 'p[style-name="Heading 1"] => h1:fresh'] },
  );
  if (!html.trim()) {
    return { text: '', warning: 'Word 文档未提取到文本（可能是空文档或仅含图片）' };
  }
  const md = createTurndown().turndown(html);
  const warning = messages.length > 0 ? `转换时 ${messages.length} 条提示（部分样式可能丢失）` : undefined;
  return { text: md, warning };
}

/** Excel (.xlsx/.xls)：exceljs 逐工作表读单元格 → GFM 表格 */
async function convertXlsx(data: Uint8Array): Promise<ConvertResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(toArrayBuffer(data));
  const parts: string[] = [];
  let totalRows = 0;
  for (const ws of wb.worksheets) {
    if (parts.length > 0) parts.push('');
    parts.push(`## ${ws.name || '工作表'}`);
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (row) => {
      // row.values[0] 恒为 undefined（ExcelJS 1-based），slice(1) 去掉
      const vals = (row.values as unknown[]).slice(1).map((c) => cellToString(c));
      rows.push(vals);
    });
    if (rows.length === 0) {
      parts.push('（空工作表）');
      continue;
    }
    totalRows += rows.length;
    // GFM 表格：表头 + 分隔行 + 数据行
    const colCount = Math.max(...rows.map((r) => r.length));
    const header = rows[0].length > 0 ? rows[0] : Array(colCount).fill('');
    parts.push(`| ${header.map((c) => c || '').join(' | ')} |`);
    parts.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const r of rows.slice(1)) {
      // 补齐列数，避免管道断裂
      const padded = [...r, ...Array(Math.max(0, colCount - r.length)).fill('')];
      parts.push(`| ${padded.map((c) => c || '').join(' | ')} |`);
    }
  }
  if (totalRows === 0) {
    return { text: '', warning: 'Excel 文件未提取到数据（可能是空工作簿）' };
  }
  return { text: parts.join('\n') };
}

/** ExcelJS 单元格值 → 字符串（处理公式结果/日期/布尔/null） */
function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'object') {
    // 公式单元格 { formula, result }
    const obj = cell as { result?: unknown; text?: string; richText?: Array<{ text: string }> };
    if (obj.richText) return obj.richText.map((rt) => rt.text).join('');
    if (obj.result !== undefined) return String(obj.result);
    if (obj.text) return obj.text;
    return '';
  }
  return String(cell);
}

/** PowerPoint (.pptx)：jszip 解包 → 提取每页 slideN.xml 的 <a:t> 文本 */
async function convertPptx(data: Uint8Array): Promise<ConvertResult> {
  const zip = await JSZip.loadAsync(data);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)?.[1] ?? '0', 10);
      return na - nb;
    });
  if (slideNames.length === 0) {
    return { text: '', warning: 'PPT 未提取到幻灯片（可能文件损坏）' };
  }
  const parts: string[] = [];
  let totalText = 0;
  for (const name of slideNames) {
    const xml = await zip.files[name].async('string');
    // <a:t> 是 OOXML 文本运行节点，包含实际文字内容
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) =>
      decodeXmlEntities(m[1]),
    );
    const slideText = texts.join('');
    if (slideText.trim()) {
      const num = name.match(/slide(\d+)\.xml/)?.[1] ?? '';
      parts.push(`## 幻灯片 ${num}\n\n${slideText.trim()}`);
      totalText += slideText.length;
    }
  }
  if (totalText === 0) {
    return { text: '', warning: 'PPT 未提取到文本（可能仅含图片/动画）' };
  }
  return { text: parts.join('\n\n') };
}

/** HTML (.html/.htm)：turndown 直接转 Markdown */
async function convertHtml(data: Uint8Array): Promise<ConvertResult> {
  const html = Buffer.from(data).toString('utf-8');
  if (!html.trim()) {
    return { text: '', warning: 'HTML 文件为空' };
  }
  const md = createTurndown().turndown(html);
  return { text: md };
}

/** CSV (.csv)：解析带引号的 CSV → GFM 表格 */
async function convertCsv(data: Uint8Array): Promise<ConvertResult> {
  const text = Buffer.from(data).toString('utf-8');
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { text: '', warning: 'CSV 文件为空或无法解析' };
  }
  return { text: rowsToMarkdownTable(rows) };
}

/**
 * 简易 CSV 解析：处理双引号包裹（含逗号/换行/转义引号）。
 * 不依赖第三方库——CSV 语法足够简单，正则状态机即可可靠解析。
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // 跳过转义的第二个引号
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        currentRow.push(field);
        field = '';
      } else if (ch === '\n' || ch === '\r') {
        // \r\n 或 \n 都视为行结束；连续 \r\n 只产生一行
        if (ch === '\r' && text[i + 1] === '\n') i++;
        currentRow.push(field);
        if (currentRow.some((c) => c !== '')) rows.push(currentRow);
        currentRow = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }
  // 最后一行（无尾换行）
  if (field !== '' || currentRow.length > 0) {
    currentRow.push(field);
    if (currentRow.some((c) => c !== '')) rows.push(currentRow);
  }
  return rows;
}

/** JSON (.json)：格式化输出（已经是文本，保持可读性） */
async function convertJson(data: Uint8Array): Promise<ConvertResult> {
  const text = Buffer.from(data).toString('utf-8').trim();
  if (!text) {
    return { text: '', warning: 'JSON 文件为空' };
  }
  try {
    const parsed = JSON.parse(text);
    return { text: `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`` };
  } catch {
    // JSON 解析失败时退化为原始文本（可能是 NDJSON 或部分损坏）
    return { text: `\`\`\`json\n${text}\n\`\`\``, warning: 'JSON 格式异常，以原始文本输出' };
  }
}

/** XML (.xml)：提取标签文本，保留层级缩进结构 */
async function convertXml(data: Uint8Array): Promise<ConvertResult> {
  const text = Buffer.from(data).toString('utf-8').trim();
  if (!text) {
    return { text: '', warning: 'XML 文件为空' };
  }
  // 去 XML 声明 + 注释，提取标签名和文本内容
  const cleaned = text
    .replace(/<\?xml[^?]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // 递归提取：把 <tag>text</tag> 转为 "- text"，嵌套标签缩进
  const lines: string[] = [];
  extractXmlText(cleaned, 0, lines);
  if (lines.length === 0) {
    // 退化为原始文本
    return { text: `\`\`\`xml\n${text}\n\`\`\`` };
  }
  return { text: lines.join('\n') };
}

/** 递归提取 XML 节点文本，按层级缩进（深度优先） */
function extractXmlText(xml: string, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  // 匹配 <tag>...内容...</tag> 或自闭合 <tag/>
  const re = /<(\w[\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>|<(\w[\w.-]*)(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  let hasMatch = false;
  while ((m = re.exec(xml)) !== null) {
    hasMatch = true;
    const tag = m[1] ?? m[3];
    const inner = m[2] ?? '';
    if (inner.trim()) {
      // 检查内部是否还有子标签
      const hasChildTags = /<\w/.test(inner);
      if (hasChildTags) {
        out.push(`${indent}- **${tag}**:`);
        extractXmlText(inner, depth + 1, out);
      } else {
        out.push(`${indent}- **${tag}**: ${decodeXmlEntities(inner.trim())}`);
      }
    } else {
      out.push(`${indent}- **${tag}**`);
    }
  }
  if (!hasMatch) {
    // 叶子文本（无标签包裹的裸文本）
    const text = decodeXmlEntities(xml.trim());
    if (text) out.push(`${indent}- ${text}`);
  }
}

/** EPub (.epub)：epub2 提取章节 HTML → turndown 转 Markdown */
async function convertEpub(data: Uint8Array): Promise<ConvertResult> {
  // epub2 是 CJS 包，动态 import 兼容；无类型声明，按 any 处理
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { EPub } = await import('epub2') as any;
  const epub = await EPub.createAsync(toArrayBuffer(data));
  const td = createTurndown();
  const parts: string[] = [];
  // 元数据标题
  const title = epub.metadata?.title;
  if (title) parts.push(`# ${title}\n`);
  let totalText = 0;
  for (const ch of epub.flow) {
    try {
      const html = await new Promise<string>((resolve, reject) => {
        epub.getChapter(ch.id, (err: Error | null, text: string) =>
          err ? reject(err) : resolve(text),
        );
      });
      if (html && html.trim()) {
        const md = td.turndown(html);
        if (md.trim()) {
          parts.push(md);
          totalText += md.length;
        }
      }
    } catch {
      // 单章失败不阻止其余章节
    }
  }
  if (totalText === 0) {
    return { text: '', warning: 'EPub 未提取到文本内容' };
  }
  return { text: parts.join('\n\n') };
}

// ==================== 工具函数 ====================

/** 把二维数组渲染为 GFM Markdown 表格 */
function rowsToMarkdownTable(rows: string[][]): string {
  const colCount = Math.max(...rows.map((r) => r.length));
  const header = rows[0] ?? [];
  const lines: string[] = [];
  lines.push(`| ${header.map((c) => c || '').join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const r of rows.slice(1)) {
    const padded = [...r, ...Array(Math.max(0, colCount - r.length)).fill('')];
    lines.push(`| ${padded.map((c) => c || '').join(' | ')} |`);
  }
  return lines.join('\n');
}

/** XML 实体解码（OOXML / HTML 通用） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}
