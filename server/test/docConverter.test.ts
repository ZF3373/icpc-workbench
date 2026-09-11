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
