import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { convertDocument, isDocumentFile, DOCUMENT_EXTENSIONS } from '../src/ai/docConverter.ts';

// ==================== Fixture 构造 ====================

/** 构造最小可解析的 .docx（OOXML zip：document.xml 含段落） */
async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="text/xml"/>' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  );
  const body = paragraphs
    .map(
      (p) =>
        `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`,
    )
    .join('');
  zip.file(
    'word/document.xml',
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}

/** 构造最小可解析的 .pptx（zip：slide1.xml 含 <a:t> 文本） */
async function makePptx(slides: string[][]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="text/xml"/>' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      slides
        .map(
          (_, i) =>
            `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
        )
        .join('') +
      '</Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
  );
  slides.forEach((texts, i) => {
    const textRuns = texts
      .map((t) => `<a:r><a:t>${t}</a:t></a:r>`)
      .join('');
    zip.file(
      `ppt/slides/slide${i + 1}.xml`,
      '<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        `<p:cSld><p:spTree><p:sp><p:txBody>${textRuns}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  });
  return zip.generateAsync({ type: 'uint8array' });
}

/** 构造最小可解析的 .epub（EPUB 2 结构：mimetype + container.xml + OPF + NCX + 章节） */
async function makeEpub(title: string, chapters: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  // mimetype 必须是首个条目且不压缩，epub2 依赖它做 MIME 校验
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
      '</container>',
  );
  const manifestItems = chapters
    .map((_, i) => `<item id="ch${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('');
  const spineItems = chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('');
  zip.file(
    'OEBPS/content.opf',
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">' +
      '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      `<dc:title>${title}</dc:title><dc:language>zh</dc:language><dc:identifier id="bookid">urn:uuid:test</dc:identifier>` +
      '</metadata>' +
      `<manifest>${manifestItems}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>` +
      `<spine toc="ncx">${spineItems}</spine>` +
      '</package>',
  );
  zip.file(
    'OEBPS/toc.ncx',
    '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
      `<docTitle><text>${title}</text></docTitle>` +
      '<navMap>' +
      chapters
        .map((c, i) => `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${c}</text></navLabel><content src="chapter${i + 1}.xhtml"/></navPoint>`)
        .join('') +
      '</navMap></ncx>',
  );
  chapters.forEach((c, i) => {
    zip.file(
      `OEBPS/chapter${i + 1}.xhtml`,
      '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>' +
        c +
        '</title></head><body><h1>' +
        c +
        '</h1><p>这是第 ' +
        (i + 1) +
        ' 章的正文内容。</p></body></html>',
    );
  });
  return zip.generateAsync({ type: 'uint8array' });
}

function strToUint8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// ==================== isDocumentFile ====================

test('docConverter: isDocumentFile 按扩展名和 content-type 判断', () => {
  assert.equal(isDocumentFile('report.docx'), true);
  assert.equal(isDocumentFile('data.xlsx'), true);
  assert.equal(isDocumentFile('slides.pptx'), true);
  assert.equal(isDocumentFile('page.html'), true);
  assert.equal(isDocumentFile('data.csv'), true);
  assert.equal(isDocumentFile('config.json'), true);
  assert.equal(isDocumentFile('feed.xml'), true);
  assert.equal(isDocumentFile('book.epub'), true);
  assert.equal(isDocumentFile('photo.jpg'), false);
  assert.equal(isDocumentFile('code.py'), false);
  assert.equal(isDocumentFile('file.pdf'), false);
  // content-type 兜底
  assert.equal(isDocumentFile('upload', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
  assert.equal(isDocumentFile('upload', 'text/csv'), true);
  assert.equal(isDocumentFile('upload', 'application/octet-stream'), false);
});

test('docConverter: DOCUMENT_EXTENSIONS 包含所有支持格式', () => {
  assert.ok(DOCUMENT_EXTENSIONS.includes('.docx'));
  assert.ok(DOCUMENT_EXTENSIONS.includes('.xlsx'));
  assert.ok(DOCUMENT_EXTENSIONS.includes('.pptx'));
  assert.ok(DOCUMENT_EXTENSIONS.includes('.html'));
  assert.ok(DOCUMENT_EXTENSIONS.includes('.csv'));
  assert.ok(DOCUMENT_EXTENSIONS.includes('.json'));
  assert.ok(DOCUMENT_EXTENSIONS.includes('.xml'));
  assert.ok(DOCUMENT_EXTENSIONS.includes('.epub'));
});

// ==================== HTML ====================

test('docConverter: HTML 转 Markdown 保留结构', async () => {
  const html = '<h1>标题</h1><p>这是一段<b>加粗</b>文字</p><ul><li>项目1</li><li>项目2</li></ul>';
  const result = await convertDocument(strToUint8(html), 'test.html');
  assert.ok(result.text.includes('# 标题'));
  assert.ok(result.text.includes('加粗'));
  assert.ok(result.text.includes('项目1'));
  assert.ok(result.text.includes('项目2'));
});

// ==================== CSV ====================

test('docConverter: CSV 转 GFM 表格', async () => {
  const csv = 'name,score,grade\nAlice,95,A\nBob,87,B\n';
  const result = await convertDocument(strToUint8(csv), 'data.csv');
  assert.ok(result.text.includes('| name | score | grade |'));
  assert.ok(result.text.includes('| --- |'));
  assert.ok(result.text.includes('| Alice | 95 | A |'));
  assert.ok(result.text.includes('| Bob | 87 | B |'));
});

test('docConverter: CSV 带引号字段（含逗号/换行）', async () => {
  const csv = 'name,desc\n"Smith, John","Line1\nLine2"\n';
  const result = await convertDocument(strToUint8(csv), 'data.csv');
  assert.ok(result.text.includes('Smith, John'));
  assert.ok(result.text.includes('Line1'));
  assert.ok(result.text.includes('Line2'));
});

// ==================== JSON ====================

test('docConverter: JSON 格式化输出', async () => {
  const json = '{"name":"test","value":42,"items":[1,2,3]}';
  const result = await convertDocument(strToUint8(json), 'config.json');
  assert.ok(result.text.includes('```json'));
  assert.ok(result.text.includes('"name": "test"'));
  assert.ok(result.text.includes('"value": 42'));
});

test('docConverter: 非法 JSON 退化为原始文本', async () => {
  const result = await convertDocument(strToUint8('{bad json}'), 'bad.json');
  assert.ok(result.text.includes('```json'));
  assert.ok(result.text.includes('{bad json}'));
  assert.ok(result.warning);
});

// ==================== XML ====================

test('docConverter: XML 提取标签文本和层级', async () => {
  const xml = '<?xml version="1.0"?><root><item>文本1</item><item>文本2</item></root>';
  const result = await convertDocument(strToUint8(xml), 'feed.xml');
  assert.ok(result.text.includes('item'));
  assert.ok(result.text.includes('文本1'));
  assert.ok(result.text.includes('文本2'));
});

// ==================== Word (.docx) ====================

test('docConverter: Word docx 提取段落文本', async () => {
  const data = await makeDocx(['第一段落', '第二段落', '第三段落']);
  const result = await convertDocument(data, 'doc.docx');
  assert.ok(result.text.includes('第一段落'));
  assert.ok(result.text.includes('第二段落'));
  assert.ok(result.text.includes('第三段落'));
});

test('docConverter: 空 docx 返回 warning', async () => {
  const data = await makeDocx([]);
  const result = await convertDocument(data, 'empty.docx');
  assert.equal(result.text, '');
  assert.ok(result.warning);
});

// ==================== PowerPoint (.pptx) ====================

test('docConverter: PPT pptx 按幻灯片提取文本', async () => {
  const data = await makePptx([
    ['标题页', '副标题'],
    ['内容页', '要点1', '要点2'],
  ]);
  const result = await convertDocument(data, 'slides.pptx');
  assert.ok(result.text.includes('幻灯片 1'));
  assert.ok(result.text.includes('标题页'));
  assert.ok(result.text.includes('副标题'));
  assert.ok(result.text.includes('幻灯片 2'));
  assert.ok(result.text.includes('要点1'));
  assert.ok(result.text.includes('要点2'));
});

test('docConverter: 无文本的 PPT 返回 warning', async () => {
  const data = await makePptx([[]]);
  const result = await convertDocument(data, 'images.pptx');
  assert.equal(result.text, '');
  assert.ok(result.warning);
});

// ==================== Excel (.xlsx) ====================

test('docConverter: Excel xlsx 转表格', async () => {
  // 用 exceljs 构造测试 xlsx
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['name', 'score']);
  ws.addRow(['Alice', 95]);
  ws.addRow(['Bob', 87]);
  const buf = await wb.xlsx.writeBuffer();
  const result = await convertDocument(new Uint8Array(buf), 'data.xlsx');
  assert.ok(result.text.includes('Sheet1'));
  assert.ok(result.text.includes('| name | score |'));
  assert.ok(result.text.includes('| Alice | 95 |'));
  assert.ok(result.text.includes('| Bob | 87 |'));
});

// ==================== EPub (.epub) ====================

test('docConverter: EPub 提取元数据标题和章节正文', async () => {
  const data = await makeEpub('测试电子书', ['第一章 引言', '第二章 方法']);
  const result = await convertDocument(data, 'book.epub');
  // 元数据标题应作为一级标题
  assert.ok(result.text.includes('# 测试电子书'), `缺少标题，实际输出：${result.text}`);
  // 两章正文都应被提取并转为 Markdown
  assert.ok(result.text.includes('第一章 引言'));
  assert.ok(result.text.includes('这是第 1 章的正文内容。'));
  assert.ok(result.text.includes('第二章 方法'));
  assert.ok(result.text.includes('这是第 2 章的正文内容。'));
  assert.equal(result.warning, undefined);
});

/**
 * epub2/adm-zip 失败时会把文件内容拼进错误信息。其字节解码后既含控制字符，
 * 也含 `. ]oa,` 这类 ASCII 可打印碎片；后者无法靠字符类识别，只能靠调用前的
 * zip 魔数校验挡住（见 convertEpub），此处校验控制字符这一必要条件。
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

test('docConverter: 非 zip 内容伪装成 .epub 时给出可读错误', async () => {
  await assert.rejects(
    () => convertDocument(strToUint8('this is definitely not a zip archive'), 'book.epub'),
    (err: Error) => {
      assert.ok(err.message.startsWith('EPub 解析失败：'), `前缀不符：${err.message}`);
      assert.ok(
        !err.message.includes('zonk'),
        `错误信息回显了文件内容：${JSON.stringify(err.message)}`,
      );
      assert.ok(
        !CONTROL_CHARS.test(err.message),
        `错误信息含控制字符：${JSON.stringify(err.message)}`,
      );
      return true;
    },
  );
});

test('docConverter: 截断的 .epub 不致错误信息泄漏控制字符', async () => {
  // 截断文件保留 zip 魔数，会进入 epub2 并在失败信息里回显字节；
  // 这些字节必须已被 sanitizeErrorMessage 过滤
  const valid = await makeEpub('测试电子书', ['第一章']);
  const truncated = valid.slice(0, 40);
  await assert.rejects(
    () => convertDocument(truncated, 'book.epub'),
    (err: Error) => {
      assert.ok(err.message.length > 0, '错误信息不应为空');
      assert.ok(
        !CONTROL_CHARS.test(err.message),
        `错误信息含控制字符：${JSON.stringify(err.message)}`,
      );
      return true;
    },
  );
});

// ==================== 分发与错误 ====================

test('docConverter: 不支持的格式抛错', async () => {
  await assert.rejects(
    () => convertDocument(strToUint8('x'), 'file.xyz'),
    /不支持的文件格式/,
  );
});

test('docConverter: content-type 兜底识别无扩展名文件', async () => {
  const html = '<p>hello</p>';
  const result = await convertDocument(strToUint8(html), 'upload', 'text/html');
  assert.ok(result.text.includes('hello'));
});

test('docConverter: 超长内容截断', async () => {
  const longJson = JSON.stringify({ data: 'x'.repeat(60000) });
  const result = await convertDocument(strToUint8(longJson), 'big.json');
  assert.ok(result.text.length < 60000);
  assert.ok(result.text.includes('已截断'));
});

test('docConverter: .xls（BIFF 旧格式）不再伪装支持 —— ExcelJS 只能读 zip 系 xlsx', async () => {
  // 旧实现把 .xls 映射到 convertXlsx：wb.xlsx.load 只认 zip 容器，真实 .xls（OLE2 头）
  // 必然抛 "Can't find end of central directory"；即使用 xlsx 字节喂 .xls 后缀也只是侥幸。
  // 与其让用户上传后报神秘错误，不如明确拒绝（客户端 accept 列表同步移除）。
  assert.ok(!DOCUMENT_EXTENSIONS.includes('.xls'), '.xls 不应出现在支持列表');
  await assert.rejects(
    () => convertDocument(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'legacy.xls'), // OLE2 魔数
    /不支持/,
  );
});
