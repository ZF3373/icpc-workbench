import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { aiRoutes } from '../src/routes/ai.ts';
import type { AiConfig } from '../src/config.ts';
import {
  extractPdfText,
  truncatePdfText,
  isPdfContentType,
  isPdfFilename,
} from '../src/ai/pdf.ts';

const AI_DISABLED: AiConfig = { enabled: false, baseURL: 'https://x/v1', apiKey: '', model: 'm' };

/** 最小合法 2 页文本 PDF（base64）：第 1 页 "Page One Content"，第 2 页 "Second Page Text" */
const TWO_PAGE_PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNiAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0OCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDEwMCA3MDAgVGQgKFBhZ2UgT25lIENvbnRlbnQpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDYxMiA3OTJdIC9Db250ZW50cyA3IDAgUiAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA2IDAgUiA+PiA+PiA+PgplbmRvYmoKNiAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCjcgMCBvYmoKPDwgL0xlbmd0aCA0OCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDEwMCA3MDAgVGQgKFNlY29uZCBQYWdlIFRleHQpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDkKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDAwIDAwMDAwIG4gCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTIxIDAwMDAwIG4gCjAwMDAwMDAyNDcgMDAwMDAgbiAKMDAwMDAwMDM0NSAwMDAwMCBuIAowMDAwMDAwNDcxIDAwMDAwIG4gCjAwMDAwMDA1NDEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA5IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo2MzkKJSVFT0Y=';

function twoPagePdfBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(TWO_PAGE_PDF_B64, 'base64'));
}

// ---------- 纯函数：truncatePdfText / isPdf* ----------

test('truncatePdfText: 短文本原样返回', () => {
  assert.equal(truncatePdfText('hello', 100), 'hello');
  assert.equal(truncatePdfText('hello'), 'hello');
});

test('truncatePdfText: 超长文本截断并标注原长度', () => {
  const long = 'a'.repeat(200);
  const out = truncatePdfText(long, 100);
  assert.ok(out.startsWith('a'.repeat(100)));
  assert.match(out, /已截断.*200/);
  assert.ok(out.length < long.length + 60);
});

test('isPdfContentType / isPdfFilename 判断', () => {
  assert.ok(isPdfContentType('application/pdf'));
  assert.ok(isPdfContentType('application/pdf; charset=binary'));
  assert.ok(!isPdfContentType('text/html'));
  assert.ok(!isPdfContentType('image/png'));
  assert.ok(isPdfFilename('doc.pdf'));
  assert.ok(isPdfFilename('UPPER.PDF'));
  assert.ok(!isPdfFilename('doc.txt'));
});

// ---------- extractPdfText 真实提取（unpdf） ----------

test('extractPdfText: 从 2 页 PDF 提取文本', async () => {
  const { text, pages } = await extractPdfText(twoPagePdfBytes());
  assert.equal(pages, 2);
  assert.match(text, /Page One Content/);
  assert.match(text, /Second Page Text/);
});

test('extractPdfText: 垃圾字节抛错（非合法 PDF）', async () => {
  await assert.rejects(
    extractPdfText(Uint8Array.from(Buffer.from('not a pdf at all'))),
    // unpdf 对非法 PDF 抛错，具体消息不固定，只断言抛出
  );
});

test('extractPdfText: 空字节抛错', async () => {
  await assert.rejects(extractPdfText(new Uint8Array(0)));
});

// ---------- /api/ai/extract-text 端点 ----------

/** 启动带 aiRoutes 的 Express 服务器（无需上游），返回 root URL + 关闭函数 */
async function withServer(
  fn: (root: string) => Promise<void>,
  cfg: AiConfig = AI_DISABLED,
): Promise<void> {
  const db: Db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/ai', aiRoutes(db, () => cfg));
  const srv = app.listen(0);
  await new Promise<void>((resolve) => srv.once('listening', resolve));
  const root = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await fn(root);
  } finally {
    srv.close();
    db.close();
  }
}

test('POST /api/ai/extract-text: PDF 提取成功返回 text + pages', async () => {
  await withServer(async (root) => {
    const res = await fetch(`${root}/api/ai/extract-text`, {
      method: 'POST',
      headers: {
        'content-type': 'application/pdf',
        'x-file-name': encodeURIComponent('题集.pdf'),
      },
      body: Buffer.from(TWO_PAGE_PDF_B64, 'base64'),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { text: string; pages: number };
    assert.equal(body.pages, 2);
    assert.match(body.text, /Page One Content/);
    assert.match(body.text, /Second Page Text/);
  });
});

test('POST /api/ai/extract-text: 不支持的文件类型返回 400', async () => {
  await withServer(async (root) => {
    const res = await fetch(`${root}/api/ai/extract-text`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': 'a.txt' },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /不支持的文件类型/);
  });
});

test('POST /api/ai/extract-text: 靠文件名 .pdf 识别（content-type 缺失）', async () => {
  await withServer(async (root) => {
    const res = await fetch(`${root}/api/ai/extract-text`, {
      method: 'POST',
      headers: { 'x-file-name': encodeURIComponent('report.PDF') },
      body: Buffer.from(TWO_PAGE_PDF_B64, 'base64'),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { text: string; pages: number };
    assert.match(body.text, /Page One Content/);
  });
});

test('POST /api/ai/extract-text: 空请求体返回 400', async () => {
  await withServer(async (root) => {
    const res = await fetch(`${root}/api/ai/extract-text`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array(0),
    });
    assert.equal(res.status, 400);
  });
});
