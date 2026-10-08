import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { renderMarkdownToTypst } from './markdownTypst.ts';
import { typstString } from './typstEscape.ts';
import { templateTierLabel } from '../../../shared/src/index.ts';
import type { ExportBundle } from '../routes/templates.ts';

export { typstString };

export const TYPST_VERSION = '0.15.1';

const EXPORT_STATUS_LABEL: Record<string, string> = {
  todo: '未学',
  learning: '学习中',
  mastered: '已掌握',
};

const difficultyStars = (difficulty: number): string =>
  `#text(fill: rgb("#d97706"))[${'★'.repeat(difficulty)}]` +
  (difficulty < 5 ? `#text(fill: luma(185))[${'☆'.repeat(5 - difficulty)}]` : '');

/** 小节标签（思路与备注 / 模板代码等），自产字符串，不涉及用户内容。 */
const sectionLabel = (value: string): string =>
  `#text(weight: 600, size: 10.5pt, fill: rgb("#1f4e79"))[${value}]`;

const text = (value: string): string => `#text(${typstString(value)})`;

const typstBinaryName = process.platform === 'win32' ? 'typst.exe' : 'typst';

let bundledTypst: Buffer | null = null;

/** SEA 启动时注入内嵌的 Typst 二进制；开发模式不需要调用。 */
export function setBundledTypstBinary(data: Buffer): void {
  bundledTypst = Buffer.from(data);
}

function platformKey(): string {
  const key = `${process.platform}-${process.arch}`;
  if (
    key === 'win32-x64' ||
    key === 'win32-arm64' ||
    key === 'darwin-arm64' ||
    key === 'darwin-x64' ||
    key === 'linux-x64' ||
    key === 'linux-arm64'
  ) {
    return key;
  }
  throw new Error(`当前平台暂不支持 Typst 导出：${key}`);
}

function vendoredTypstPath(): string {
  const serverRoot = path.resolve(import.meta.dirname, '..', '..');
  return path.join(serverRoot, 'vendor', 'typst', platformKey(), `v${TYPST_VERSION}`, typstBinaryName);
}

function extractBundledTypst(dataDir: string): string {
  const targetDir = path.join(dataDir, 'typst-bin', `v${TYPST_VERSION}-${process.platform}-${process.arch}`);
  const target = path.join(targetDir, typstBinaryName);
  if (fs.existsSync(target)) return target;

  fs.mkdirSync(targetDir, { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, bundledTypst!);
  if (process.platform !== 'win32') fs.chmodSync(temp, 0o755);
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    if (fs.existsSync(target)) {
      fs.rmSync(temp, { force: true });
      return target;
    }
    throw error;
  }
  return target;
}

/** 依次查找显式配置、SEA 内嵌、开发目录中的 Typst 可执行文件。 */
export function resolveTypstBinary(dataDir: string = path.join(os.tmpdir(), 'icpc-typst')): string {
  const explicit = process.env.TYPST_BIN?.trim();
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`TYPST_BIN 指向的文件不存在：${explicit}`);
    return explicit;
  }
  if (bundledTypst) return extractBundledTypst(dataDir);

  const vendored = vendoredTypstPath();
  if (fs.existsSync(vendored)) return vendored;

  throw new Error(
    `未找到 Typst ${TYPST_VERSION} 编译器。开发环境请先运行 npm run prepare:typst。`,
  );
}

function runTypst(binary: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = String(stderr ?? '').trim().slice(-2000);
        reject(new Error(detail ? `Typst 编译失败：${detail}` : `Typst 编译失败：${error.message}`));
      },
    );
  });
}

/** 将 Typst 源编译成 PDF 字节；临时目录无论成功失败都会清理。 */
export async function compileTypstToPdf(
  source: string,
  options: { dataDir?: string; typstBin?: string; timeoutMs?: number } = {},
): Promise<Buffer> {
  const binary = options.typstBin ?? resolveTypstBinary(options.dataDir);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icpc-typst-'));
  const input = path.join(dir, 'templates.typ');
  const output = path.join(dir, 'templates.pdf');
  try {
    fs.writeFileSync(input, source, 'utf8');
    await runTypst(
      binary,
      ['compile', '--root', dir, input, output],
      dir,
      options.timeoutMs ?? 60_000,
    );
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 将模板导出 bundle 直接渲染为 Typst 文档。
 *
 * 代码与标题等确定性字段直接放字符串参数；思路/大纲等 Markdown 笔记
 * 经 markdownTypst 渲染成标题、列表、行内样式。两条路径的共同边界是：
 * 用户内容只以 typstString 字符串参数的形式进入文档，永不参与
 * Typst 标记解析，因此不会被解释成布局指令。
 */
export function renderTemplatesTypst(bundle: ExportBundle): string {
  const exportedAt = new Date(bundle.exportedAt).toLocaleString('zh-CN', { hour12: false });
  const out: string[] = [
    '#set page(',
    '  paper: "a4",',
    '  margin: (x: 18mm, y: 18mm),',
    '  header: context {',
    '    if counter(page).get().first() > 1 [',
    '      #set align(right)',
    '      #set text(size: 8pt, fill: luma(150))',
    '      ICPC 算法模板库',
    '    ]',
    '  },',
    '  footer: context [',
    '    #set align(center)',
    '    #set text(size: 8pt, fill: luma(130))',
    '    #counter(page).display("第 1 页 / 共 1 页", both: true)',
    '  ],',
    ')',
    '#set text(',
    '  font: ("Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "SimSun", "DejaVu Sans"),',
    '  size: 10pt,',
    '  lang: "zh",',
    '  region: "cn",',
    ')',
    '#set par(justify: true, leading: 0.75em)',
    // 标题层级：条目本身是 level 3，笔记内的小标题落在 4~6 级，逐级收紧。
    '#show heading.where(level: 1): set text(size: 20pt, weight: 800, fill: rgb("#12283d"))',
    '#show heading.where(level: 2): set text(size: 14.5pt, weight: 700, fill: rgb("#17324f"))',
    '#show heading.where(level: 2): set block(above: 1.6em, below: 0.8em)',
    '#show heading.where(level: 3): set text(size: 12.5pt, weight: 700, fill: rgb("#1f4e79"))',
    '#show heading.where(level: 3): set block(above: 1.45em, below: 0.6em)',
    '#show heading.where(level: 4): set text(size: 10.5pt, weight: 700, fill: rgb("#2b5c8a"))',
    '#show heading.where(level: 4): set block(above: 1.1em, below: 0.5em)',
    '#show heading.where(level: 5): set text(size: 10pt, weight: 600, fill: rgb("#2b5c8a"))',
    '#show heading.where(level: 5): set block(above: 1em, below: 0.45em)',
    '#show heading.where(level: 6): set text(size: 9.5pt, weight: 600, fill: rgb("#52606d"))',
    // 代码：等宽字体带 CJK 兜底；块级 raw 必须可跨页，否则长模板整块跳页。
    '#show raw: set text(font: ("Cascadia Code", "Consolas", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "DejaVu Sans Mono", "Microsoft YaHei"), size: 9pt)',
    '#show raw.where(block: true): set text(size: 8.5pt)',
    '#show raw.where(block: true): block.with(',
    '  breakable: true,',
    '  width: 100%,',
    '  inset: 9pt,',
    '  radius: 4pt,',
    '  fill: rgb("#f7f8fa"),',
    '  stroke: 0.5pt + rgb("#d8dee6"),',
    '  above: 7pt,',
    '  below: 7pt,',
    ')',
    '#show raw.where(block: false): box.with(',
    '  fill: rgb("#eef1f5"),',
    '  inset: (x: 3pt, y: 1.5pt),',
    '  outset: (y: 2pt),',
    '  radius: 2pt,',
    ')',
    '#set list(indent: 0.55em, spacing: 0.72em, body-indent: 0.5em)',
    '#set enum(indent: 0.55em, spacing: 0.72em, body-indent: 0.5em)',
    '#show link: set text(fill: rgb("#2563eb"))',
    '#show quote: set block(fill: rgb("#fafbfc"), stroke: (left: 2pt + rgb("#c9d4e0")), inset: (x: 10pt, y: 6pt), width: 100%)',
    '#set table(stroke: 0.5pt + rgb("#cfd6df"), inset: 5.5pt)',
    '',
    `#heading(level: 1)[${text('ICPC 算法模板库 · 导出')}]`,
    '',
    `#text(size: 9pt, fill: luma(110), ${typstString(`导出时间：${exportedAt}`)}) \\`,
    `#text(size: 9pt, fill: luma(110), ${typstString(`自建模板：${bundle.customCount} 篇 · 内置模板笔记：${bundle.builtinNoteCount} 篇`)})`,
    '',
    '#line(length: 100%, stroke: 1.1pt + rgb("#1f4e79"))',
    '',
  ];

  if (bundle.customCount === 0 && bundle.builtinNoteCount === 0) {
    out.push(text('暂无可导出的模板 —— 你还没有自建模板，也没有在内置课程条目里写入模板内容。'), '');
    return out.join('\n');
  }

  let index = 0;
  if (bundle.customCount > 0) {
    out.push(`#heading(level: 2)[${text(`一、自建模板（${bundle.customCount} 篇）`)}]`, '');
    for (const item of bundle.customTemplates) {
      index += 1;
      out.push(`#heading(level: 3)[${text(`${index}. ${item.name}`)}]`, '');
      out.push(`- *分类：* ${text(item.category)}`);
      out.push(`- *难度：* ${difficultyStars(item.difficulty)} ${text(templateTierLabel(item.difficulty))}`);
      if (item.tags.length) out.push(`- *标签：* ${text(item.tags.join('、'))}`);
      if (item.complexity) out.push(`- *复杂度：* ${text(item.complexity)}`);
      if (item.url) out.push(`- *出处：* #link(${typstString(item.url)})[${text(item.url)}]`);
      if (item.status !== 'todo') {
        out.push(`- *状态：* ${text(EXPORT_STATUS_LABEL[item.status] ?? item.status)}`);
      }
      if (item.note) out.push(`- *笔记：* ${renderInlineMarkdownSafe(item.note)}`);
      out.push('');
      if (item.idea.trim()) {
        out.push(sectionLabel('思路与备注'), '', renderMarkdownToTypst(item.idea.trim()), '');
      }
      if (item.code.trim()) {
        // block: true 必须显式给出 —— #raw(字符串) 默认是行内 raw，
        // 会被 raw.where(block: false) 的 show 规则包成不可跨页的盒子。
        out.push(sectionLabel('模板代码'), '', `#raw(block: true, lang: "cpp", ${typstString(item.code.trimEnd())})`, '');
      }
      out.push('#line(length: 100%, stroke: 0.3pt + luma(225))', '');
    }
  }

  if (bundle.builtinNoteCount > 0) {
    const section = bundle.customCount > 0 ? '二' : '一';
    out.push(
      `#heading(level: 2)[${text(`${section}、内置模板笔记（${bundle.builtinNoteCount} 篇）`)}]`,
      '',
    );
    let builtinIndex = 0;
    for (const item of bundle.builtinNotes) {
      builtinIndex += 1;
      out.push(`#heading(level: 3)[${text(`${builtinIndex}. ${item.name}`)}]`, '');
      out.push(`- *分类：* ${text(item.category)}`);
      out.push(`- *难度：* ${difficultyStars(item.difficulty)} ${text(templateTierLabel(item.difficulty))}`);
      if (item.tags.length) out.push(`- *标签：* ${text(item.tags.join('、'))}`);
      if (item.complexity) out.push(`- *复杂度：* ${text(item.complexity)}`);
      if (item.url) out.push(`- *参考链接：* #link(${typstString(item.url)})[${text(item.url)}]`);
      if (item.status !== 'todo') {
        out.push(`- *状态：* ${text(EXPORT_STATUS_LABEL[item.status] ?? item.status)}`);
      }
      if (item.note) out.push(`- *笔记：* ${renderInlineMarkdownSafe(item.note)}`);
      out.push('');
      out.push(sectionLabel('大纲要点'), '', renderMarkdownToTypst(item.outline), '');
      if (item.idea?.trim()) out.push(sectionLabel('我的思路'), '', renderMarkdownToTypst(item.idea.trim()), '');
      if (item.code?.trim()) {
        out.push(sectionLabel('我的模板'), '', `#raw(block: true, lang: "cpp", ${typstString(item.code.trimEnd())})`, '');
      }
      out.push('#line(length: 100%, stroke: 0.3pt + luma(225))', '');
    }
  }

  return out.join('\n');
}

/**
 * 单行备注字段走行内 markdown（`代码` / **加粗** 会被正常渲染），
 * 多行内容会被压平为空格 —— 备注本就设计为一句话，长内容应写进思路。
 */
function renderInlineMarkdownSafe(value: string): string {
  const rendered = renderMarkdownToTypst(value.trim());
  return rendered === '' ? text('') : rendered.replace(/\n+/g, ' ');
}
