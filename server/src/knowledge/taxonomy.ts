/**
 * 知识点体系（taxonomy）加载与查询。
 * taxonomy.json 是版本化的静态文件：code 全局唯一、稳定不可改；
 * 改语义 = 新增 code + 废弃旧 code，保证历史标注可解释。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAXONOMY_PATH = path.join(__dirname, 'taxonomy.json');

export interface TaxonomyPoint {
  code: string;
  /** 短展示名（与标签词表对齐，如「线段树」） */
  name: string;
  /** 模板课程全名（如「线段树（区间加 + 区间求和，懒标记）」） */
  fullName?: string;
  templateIds?: string[];
}

export interface TaxonomyCategory {
  key: string;
  name: string;
  points: TaxonomyPoint[];
}

export interface Taxonomy {
  version: number;
  categories: TaxonomyCategory[];
}

let cache: Taxonomy | null = null;
let jsonOverride: string | null = null;
let pointsCache: TaxonomyPoint[] | null = null;
let pointByCode: Map<string, TaxonomyPoint> | null = null;

function invalidateIndexes(): void {
  cache = null;
  pointsCache = null;
  pointByCode = null;
}

/** SEA 单文件分发时由入口注入 JSON 文本（不再读磁盘）；传 null 恢复磁盘读取 */
export function setTaxonomyJson(json: string | null): void {
  jsonOverride = json;
  invalidateIndexes();
}

export function loadTaxonomy(): Taxonomy {
  if (!cache) {
    cache = JSON.parse(jsonOverride ?? fs.readFileSync(TAXONOMY_PATH, 'utf8')) as Taxonomy;
  }
  return cache;
}

/** 测试专用：注入自定义 taxonomy 并重置缓存 */
export function setTaxonomyForTest(t: Taxonomy | null): void {
  cache = t;
  pointsCache = null;
  pointByCode = null;
}

/** 平铺后的全量知识点（缓存，避免每次调用重建数组）；返回引用仅供只读遍历。 */
export function allPoints(): TaxonomyPoint[] {
  if (!pointsCache) {
    pointsCache = loadTaxonomy().categories.flatMap((c) => c.points);
  }
  return pointsCache;
}

/** code → point 的 O(1) 索引（缓存），热路径（逐题/逐 tag）避免线性 find。 */
function codeIndex(): Map<string, TaxonomyPoint> {
  if (!pointByCode) {
    pointByCode = new Map(allPoints().map((p) => [p.code, p]));
  }
  return pointByCode;
}

export function isValidCode(code: string): boolean {
  return codeIndex().has(code);
}

/** code → 展示名；未知 code 返回 null（幻觉 code 拦截用） */
export function nameOfCode(code: string): string | null {
  return codeIndex().get(code)?.name ?? null;
}

/** code → 模板课程全名（无课程的综合点回退展示名） */
export function fullNameOfCode(code: string): string | null {
  const p = codeIndex().get(code);
  return p ? (p.fullName ?? p.name) : null;
}

/** code → 所属大类 key（code 命名空间前缀，拿不到时查表兜底） */
export function categoryOfCode(code: string): string | null {
  for (const cat of loadTaxonomy().categories) {
    if (cat.points.some((p) => p.code === code)) return cat.key;
  }
  return null;
}

/** code → 关联课程模板 id 列表（掌握度地图「看课」入口） */
export function templateIdsOfCode(code: string): string[] {
  return codeIndex().get(code)?.templateIds ?? [];
}
