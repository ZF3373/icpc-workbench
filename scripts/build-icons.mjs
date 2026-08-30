/**
 * 软件图标生成：scripts/build-icons.mjs
 * 从 client/public/favicon.svg（品牌标识）栅格化多尺寸 PNG，打包为 Windows .ico
 * （ICO 条目用 PNG 格式，Vista+ 全支持），写入桌面壳与挂件的 icons/icon.ico。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const svgPath = path.join(repoRoot, 'client', 'public', 'favicon.svg');

/** 原 viewBox 48x46 → 居中放入 48x48 方形画布 */
const WRAPPED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><g transform="translate(0,1">${fs.readFileSync(svgPath, 'utf8').replace(/<svg[^>]*>|<\/svg>/g, '')}</g></svg>`;

/** PNG 编码：RGBA8 + filter 0 */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const chunks = [];
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  chunks.push(chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const SIZES = [256, 128, 64, 48, 32, 24, 16];
const pngs = SIZES.map((size) => {
  const r = new Resvg(WRAPPED_SVG, { fitTo: { mode: 'width', value: size } });
  const rendered = r.render();
  return { size, png: rendered.asPng() };
});

// ---- ICO 容器 ----
const entries = pngs.map(({ size, png }) => ({
  size,
  bytes: png.length,
  data: png,
}));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(entries.length, 4);
const dir = Buffer.alloc(16 * entries.length);
let offset = 6 + 16 * entries.length;
entries.forEach((e, i) => {
  const base = i * 16;
  dir[base] = e.size === 256 ? 0 : e.size;
  dir[base + 1] = e.size === 256 ? 0 : e.size;
  dir[base + 4] = 1; // planes
  dir.writeUInt16LE(32, base + 6); // bpp
  dir.writeUInt32LE(e.bytes, base + 8);
  dir.writeUInt32LE(offset, base + 12);
  offset += e.bytes;
});
const ico = Buffer.concat([header, dir, ...entries.map((e) => e.data)]);

const targets = [
  path.join(repoRoot, 'desktop', 'app', 'src-tauri', 'icons', 'icon.ico'),
  path.join(repoRoot, 'desktop', 'src-tauri', 'icons', 'icon.ico'),
];
for (const t of targets) {
  fs.writeFileSync(t, ico);
  console.log(`已写入 ${path.relative(repoRoot, t)} (${ico.length} 字节, ${SIZES.join('/')})`);
}
