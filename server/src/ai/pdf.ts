import { getDocumentProxy, extractText } from 'unpdf';

/** 提取后正文最大字符数，超出截断。现代模型上下文窗口已达 128K-1M token，放宽至 50K 字符（约 12K token） */
const MAX_TEXT_CHARS = 50000;

export interface PdfExtractResult {
  /** 全文文本（多页合并，已清理） */
  text: string;
  /** 总页数 */
  pages: number;
}

/**
 * 从 PDF 字节中提取文本。使用 unpdf（Mozilla pdf.js 服务端封装），支持文本型 PDF。
 * 扫描型 PDF（纯图片）无法提取文字，返回空文本 + error 说明。
 * 失败抛错（加密/损坏），调用方负责兜底处理。
 */
export async function extractPdfText(data: Uint8Array): Promise<PdfExtractResult> {
  // unpdf 要求 Uint8Array（不接受 Buffer），防御性转换为独立 Uint8Array
  const bytes = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
    ? data
    : new Uint8Array(data);
  const doc = await getDocumentProxy(bytes);
  // mergePages: true 时 text 为 string（多页合并）；防御性兼容 string[] 形态
  const { totalPages, text } = await extractText(doc, { mergePages: true });
  const raw = typeof text === 'string' ? text : (text as string[]).join('\n\n');
  const cleaned = cleanPdfText(raw);
  return { text: cleaned, pages: totalPages };
}

/**
 * 清理 PDF 提取文本：去除单字符空行、折叠多余空白、去除常见页眉页脚噪声。
 * best-effort，不追求完美——保留可读性优先。
 */
function cleanPdfText(text: string): string {
  return text
    // 折叠行内多空格为单空格
    .replace(/[ \t\f\v]+/g, ' ')
    // 去除行首尾空格
    .replace(/^ +| +$/gm, '')
    // 合并 3+ 连续空行为 2 个
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 截断超长 PDF 文本，超出部分用省略标注。纯函数，便于无 mock 测试。
 */
export function truncatePdfText(text: string, maxChars: number = MAX_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n\n[…PDF 内容已截断，原文共 ' + text.length + ' 字符]';
}

/** 判断是否为 PDF（按 content-type 或文件名扩展名） */
export function isPdfContentType(contentType: string): boolean {
  return /application\/pdf/i.test(contentType);
}

/** 判断文件名是否为 .pdf 扩展 */
export function isPdfFilename(filename: string): boolean {
  return /\.pdf$/i.test(filename);
}
