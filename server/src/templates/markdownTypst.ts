import { typstString } from './typstEscape.ts';

/**
 * 极简 Markdown → Typst 渲染器（服务端导出专用）。
 *
 * 模板「思路 / 大纲要点」等字段存的是 AI 写的 Markdown，此前被整段塞进
 * #text() 字符串，`##`、`-`、`**` 等记号原样打印。这里把一个够用的
 * CommonMark 子集解析成安全 Typst：所有叶子文本仍走 typstString 字符串
 * 参数，用户内容永远不参与 Typst 标记解析（与 typst.ts 的安全边界一致）。
 *
 * 支持块级：ATX 标题、有序/无序列表（含嵌套）、围栏代码块、引用块、
 * GFM 表格、分隔线、段落。行内：**加粗**、*斜体*、`行内代码`、
 * [链接](url)、<https://自动链接>、裸 URL、<br>、反斜杠转义。
 *
 * 另外修一桩数据旧账：部分笔记以字面 `\n`（反斜杠 + n）的形式存库，
 * 导出前把它们还原为真实换行（围栏代码块与行内代码 span 中的 `\n`
 * 是代码内容，保持字面）。
 */

// ---------------------------------------------------------------------------
// 字面 \n 规整
// ---------------------------------------------------------------------------

/** 把正文里字面 `\n`（含 `\\n`）还原成真实换行；代码区域内的保持字面。 */
export function normalizeLiteralNewlines(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const outLines: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines) {
    if (fence) {
      outLines.push(line);
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence.marker[0] && close[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { marker: open[1]!, length: open[1]!.length };
      outLines.push(line);
      continue;
    }
    outLines.push(unescapeLiteralNewlineInLine(line));
  }
  return outLines.join('\n');
}

function unescapeLiteralNewlineInLine(line: string): string {
  let out = '';
  let i = 0;
  let openTicks = 0; // 当前行内代码 span 的反引号数量；0 表示不在代码 span 内
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '`') {
      let run = 0;
      while (line[i + run] === '`') run += 1;
      if (openTicks === 0) openTicks = run;
      else if (run === openTicks) openTicks = 0;
      out += line.slice(i, i + run);
      i += run;
      continue;
    }
    if (openTicks === 0 && ch === '\\') {
      let slashes = 0;
      while (line[i + slashes] === '\\') slashes += 1;
      if (line[i + slashes] === 'n') {
        out += '\n';
        i += slashes + 1;
        continue;
      }
      out += '\\'.repeat(slashes);
      i += slashes;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'para'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ulist'; items: Block[][] }
  | { kind: 'olist'; start: number; items: Block[][] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; header: string[]; aligns: ('left' | 'center' | 'right' | null)[]; rows: string[][] }
  | { kind: 'hr' };

const BULLET_RE = /^(\s*)([-*+])(\s+)(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;
const FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^ {0,3}(?:[-*_] *){3,}$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const TABLE_DELIM_RE = /^\s{0,3}\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n += 1;
  return n;
}

/** 该行是否开启新的块级结构（段落收集时用于中断）。 */
function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line) ||
    (line.includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]!))
  );
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1]!;
      const info = fence[2] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = l.match(FENCE_CLOSE_RE);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          i += 1;
          break;
        }
        body.push(l);
        i += 1;
      }
      blocks.push({ kind: 'code', lang: info.split(/\s+/)[0] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(QUOTE_RE);
        if (m) {
          inner.push(m[1]!);
          i += 1;
          continue;
        }
        if (inner.length > 0 && lines[i]!.trim() !== '' && !isBlockStart(lines, i)) {
          inner.push(lines[i]!); // 懒惰续行
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1]!)) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]!).map(cellAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) {
        rows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      blocks.push({ kind: 'table', header, aligns, rows });
      continue;
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !isBlockStart(lines, i)) {
      para.push(lines[i]!);
      i += 1;
    }
    if (para.length > 0) blocks.push({ kind: 'para', lines: para });
    else i += 1; // 兜底，防止意外字符死循环
  }
  return blocks;
}

function parseList(lines: string[], start: number): { block: Block; next: number } {
  const first = lines[start]!;
  const ordered = first.match(ORDERED_RE)!;
  const bullet = first.match(BULLET_RE)!;
  const isOrdered = !!ordered;
  const baseIndent = (isOrdered ? ordered[1]! : bullet[1]!).length;
  const startNum = isOrdered ? parseInt(ordered[2]!, 10) : 0;

  const isItemMarker = (line: string): boolean => {
    if (leadingSpaces(line) !== baseIndent) return false;
    return isOrdered ? ORDERED_RE.test(line) : BULLET_RE.test(line);
  };

  // 收集列表整体范围内的行：条目行、嵌套/续行（缩进更深）、懒惰续行、条目间空行。
  const chunks: string[][] = [];
  let current: string[] | null = null;
  let pendingBlanks: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      pendingBlanks.push(line);
      i += 1;
      continue;
    }
    if (isItemMarker(line)) {
      if (current) chunks.push(current);
      current = [line];
      pendingBlanks = [];
      i += 1;
      continue;
    }
    if (current && leadingSpaces(line) > baseIndent) {
      current.push(...pendingBlanks, line);
      pendingBlanks = [];
      i += 1;
      continue;
    }
    if (current && pendingBlanks.length === 0 && !isBlockStart(lines, i)) {
      current.push(line); // 懒惰续行
      i += 1;
      continue;
    }
    break;
  }
  if (current) chunks.push(current);

  const items: Block[][] = [];
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const m = chunk[0]!.match(isOrdered ? ORDERED_RE : BULLET_RE)!;
    // 首行内容从「缩进 + 标记 + 间隔」之后开始；有序/无序的分组号不同。
    const contentIndent = isOrdered
      ? m[1]!.length + m[2]!.length + m[3]!.length + m[4]!.length
      : m[1]!.length + m[2]!.length + m[3]!.length;
    const inner: string[] = [chunk[0]!.slice(contentIndent)];
    for (let k = 1; k < chunk.length; k += 1) {
      const l = chunk[k]!;
      if (l.trim() === '') {
        inner.push('');
        continue;
      }
      inner.push(leadingSpaces(l) >= contentIndent ? l.slice(contentIndent) : l);
    }
    items.push(parseBlocks(inner));
  }

  const block: Block = isOrdered ? { kind: 'olist', start: startNum, items } : { kind: 'ulist', items };
  return { block, next: i };
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function cellAlign(cell: string): 'left' | 'center' | 'right' | null {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

const PUNCT_ESCAPE_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

interface EmphasisMatch {
  content: string;
  end: number;
  strong: boolean;
}

function matchEmphasis(src: string, i: number): EmphasisMatch | null {
  const ch = src[i]!;
  let run = 0;
  while (src[i + run] === ch) run += 1;
  const prev = i > 0 ? src[i - 1]! : '';
  const next = src[i + run] ?? '';
  // 下划线不作词内强调（snake_case_name 不能被斜体拆开）
  if (ch === '_' && isWordChar(prev) && isWordChar(next)) return null;

  if (run >= 2) {
    const closer = src.indexOf(ch.repeat(2), i + run);
    if (closer !== -1) {
      let content = src.slice(i + run, closer);
      let end = closer + 2;
      // ***粗斜体***：闭合侧会多出一个单字符，剥掉后按粗斜体嵌套渲染
      if (content.endsWith(ch) && content.trim().length > 1) {
        content = content.slice(0, -1);
        end -= 1;
        if (content.startsWith(ch)) content = content.slice(1);
      }
      if (isValidEmphasisContent(content)) return { content, end, strong: true };
    }
  }
  // 单字符斜体：从标记后找下一个单字符闭标
  for (let j = i + run; j < src.length; j += 1) {
    if (src[j] !== ch) continue;
    if (src[j + 1] === ch) {
      // 连续闭标不是单字符闭标，跳过整段 run
      while (src[j] === ch) j += 1;
      continue;
    }
    const content = src.slice(i + run, j);
    if (isValidEmphasisContent(content)) return { content, end: j + 1, strong: false };
    return null;
  }
  return null;
}

function isValidEmphasisContent(content: string): boolean {
  return content.trim() !== '' && !/^\s/.test(content) && !/\s$/.test(content);
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

interface LinkMatch {
  text: string;
  url: string;
  end: number;
}

function matchLink(src: string, i: number): LinkMatch | null {
  if (src[i + 1] === '[') return null; // 嵌套方括号（引用式链接）不支持，按字面处理
  let depth = 0;
  let j = i;
  for (; j < src.length; j += 1) {
    if (src[j] === '\\') {
      j += 1;
      continue;
    }
    if (src[j] === '[') depth += 1;
    else if (src[j] === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (j >= src.length || src[j + 1] !== '(') return null;
  const closeParen = src.indexOf(')', j + 2);
  if (closeParen === -1) return null;
  const url = src.slice(j + 2, closeParen).trim();
  if (!url || /\s/.test(url)) return null;
  return { text: src.slice(i + 1, j), url, end: closeParen + 1 };
}

/** 匹配从 i 开始的裸 URL（前面须是空白/起始/开括号），返回 url 与结束位置。 */
function matchBareUrl(src: string, i: number): { url: string; end: number } | null {
  if (!/^https?:\/\//i.test(src.slice(i, i + 8))) return null;
  const prev = i > 0 ? src[i - 1]! : '';
  if (prev !== '' && !/[\s([{'"（【「]/.test(prev)) return null;
  let end = i;
  while (end < src.length && !/[\s<>()[\]{}"'`]/.test(src[end]!) && !/[、。；：！？｜]/.test(src[end]!)) {
    end += 1;
  }
  while (end > i && /[.,;:!?)\]}>、。，；：！？）】」'"”’]/.test(src[end - 1]!)) end -= 1;
  if (end - i <= 8) return null;
  return { url: src.slice(i, end), end };
}

/** 行内 markdown → Typst 行内内容（仅函数调用与已转义字符串）。 */
export function renderInlineMarkdown(src: string): string {
  const out: string[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf !== '') {
      out.push(`#text(${typstString(buf)})`);
      buf = '';
    }
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;

    if (ch === '`') {
      let ticks = 0;
      while (src[i + ticks] === '`') ticks += 1;
      const closer = src.indexOf('`'.repeat(ticks), i + ticks);
      if (closer !== -1 && (closer + ticks === n || src[closer + ticks] !== '`')) {
        flush();
        out.push(`#raw(${typstString(stripCodePadding(src.slice(i + ticks, closer)))})`);
        i = closer + ticks;
        continue;
      }
      buf += '`'.repeat(ticks);
      i += ticks;
      continue;
    }

    if (ch === '\\' && i + 1 < n && PUNCT_ESCAPE_RE.test(src[i + 1]!)) {
      buf += src[i + 1]!;
      i += 2;
      continue;
    }

    if (ch === '*' || ch === '_') {
      const m = matchEmphasis(src, i);
      if (m) {
        flush();
        const inner = renderInlineMarkdown(m.content);
        out.push(m.strong ? `#strong[${inner}]` : `#emph[${inner}]`);
        i = m.end;
        continue;
      }
    }

    if (ch === '[') {
      const link = matchLink(src, i);
      if (link) {
        flush();
        out.push(`#link(${typstString(link.url)})[${renderInlineMarkdown(link.text)}]`);
        i = link.end;
        continue;
      }
    }

    if (ch === '<') {
      const br = /^<br\s*\/?\s*>/i.exec(src.slice(i));
      if (br) {
        flush();
        out.push('#linebreak()');
        i += br[0].length;
        continue;
      }
      const auto = /^<(https?:\/\/[^<>\s]+)>/i.exec(src.slice(i));
      if (auto) {
        flush();
        out.push(`#link(${typstString(auto[1]!)})[#text(${typstString(auto[1]!)})]`);
        i += auto[0].length;
        continue;
      }
    }

    const url = matchBareUrl(src, i);
    if (url) {
      flush();
      out.push(`#link(${typstString(url.url)})[#text(${typstString(url.url)})]`);
      i = url.end;
      continue;
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out.join('');
}

/** CommonMark：行内代码两端若各有且仅有一个空格，剥掉。 */
function stripCodePadding(content: string): string {
  if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') {
    return content.slice(1, -1);
  }
  return content;
}

/** 段落：软换行折叠成空格，行尾两空格或反斜杠为硬换行。 */
function renderParagraph(lines: string[]): string {
  const parts: string[] = [];
  for (let k = 0; k < lines.length; k += 1) {
    let line = lines[k]!;
    let hard = false;
    const m = /( {2,}|\\)\s*$/.exec(line);
    if (m) {
      hard = true;
      line = line.slice(0, m.index);
    }
    parts.push(renderInlineMarkdown(line.trim()));
    if (hard && k < lines.length - 1) parts.push('#linebreak()');
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 块级渲染
// ---------------------------------------------------------------------------

const BULLET_MARKERS = ['•', '–', '·'];
const ENUM_PATTERNS = ['1.', 'a.', 'i.'];

function renderListArgs(items: Block[][], depth: number): string {
  // list/enum 的实参在代码模式中，内容块写作 [...]（#[...] 仅在标记模式合法）。
  return items.map((item) => `[${renderItemBlocks(item, depth)}]`).join(', ');
}

function renderItemBlocks(item: Block[], depth: number): string {
  // 条目内的段落与嵌套块用换行衔接（Typst markup 里换行 = 空格）。
  return item.map((b) => renderBlock(b, depth + 1)).filter((s) => s !== '').join('\n');
}

function renderBlock(block: Block, depth: number = 0): string {
  switch (block.kind) {
    case 'para': {
      const inline = renderParagraph(block.lines);
      return inline === '' ? '' : inline;
    }
    case 'heading': {
      // 条目标题是 level 3，笔记内的 ## 等小标题映射到其下的 4~6 级。
      const level = block.level <= 2 ? 4 : block.level === 3 ? 5 : 6;
      return `#heading(level: ${level})[${renderInlineMarkdown(block.text)}]`;
    }
    case 'hr':
      return '#line(length: 100%, stroke: 0.3pt + luma(225))';
    case 'code': {
      if (block.text.trim() === '') return '';
      // 围栏代码块必须显式 block: true（#raw 字符串默认按行内 raw 处理）。
      const lang = /^[A-Za-z0-9+#-]{1,20}$/.test(block.lang) ? block.lang : '';
      return lang
        ? `#raw(block: true, lang: ${typstString(lang)}, ${typstString(block.text)})`
        : `#raw(block: true, ${typstString(block.text)})`;
    }
    case 'quote': {
      const inner = block.blocks.map((b) => renderBlock(b, depth)).filter((s) => s !== '').join('\n\n');
      return inner === '' ? '' : `#quote(block: true)[\n${inner}\n]`;
    }
    case 'ulist': {
      if (block.items.length === 0) return '';
      const marker = BULLET_MARKERS[Math.min(depth, BULLET_MARKERS.length - 1)]!;
      const indent = depth > 0 ? 'indent: 0.65em, ' : '';
      return `#list(${indent}marker: ([${marker}]), ${renderListArgs(block.items, depth)})`;
    }
    case 'olist': {
      if (block.items.length === 0) return '';
      const pattern = ENUM_PATTERNS[Math.min(depth, ENUM_PATTERNS.length - 1)]!;
      const indent = depth > 0 ? 'indent: 0.65em, ' : '';
      return `#enum(start: ${block.start}, ${indent}numbering: ${typstString(pattern)}, ${renderListArgs(block.items, depth)})`;
    }
    case 'table': {
      const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
      const aligns = block.aligns.slice(0, cols);
      while (aligns.length < cols) aligns.push(null);
      const alignArg =
        aligns.some((a) => a !== null) && !aligns.every((a) => a === null)
          ? `align: (${aligns.map((a) => a ?? 'auto').join(', ')}),\n  `
          : '';
      // table 的实参处于代码模式，单元格一律包成 [...] 内容块，
      // 其内部回到标记模式，行内渲染产物（#text/#strong/…）因此合法。
      const headerCells = block.header.map((c) => `[#strong[${renderInlineMarkdown(c)}]]`);
      while (headerCells.length < cols) headerCells.push('[]');
      const bodyCells = block.rows.flatMap((r) => {
        const row = r.slice();
        while (row.length < cols) row.push('');
        return row.map((c) => `[${renderInlineMarkdown(c)}]`);
      });
      const lines = [
        '#table(',
        `  columns: ${cols},`,
        '  inset: 5.5pt,',
        `${alignArg}  fill: (x, y) => if y == 0 { luma(242) },`,
        `  table.header(${headerCells.join(', ')}),`,
      ];
      for (const cell of bodyCells) lines.push(`  ${cell},`);
      lines.push(')');
      return lines.join('\n');
    }
  }
}

/** 入口：markdown 文本 → Typst 块级内容（段落间以空行分隔）。 */
export function renderMarkdownToTypst(markdown: string): string {
  const normalized = normalizeLiteralNewlines(markdown);
  const blocks = parseBlocks(normalized.split('\n'));
  return blocks.map((b) => renderBlock(b, 0)).filter((s) => s !== '').join('\n\n');
}
