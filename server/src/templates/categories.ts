/**
 * 模板库分类清单（内置课程大纲 + 用户自建标签）的唯一读取入口。
 *
 * 为什么要单独抽这一层：AI 助手要让用户「把这个模板记到某个标签下」，就必须知道
 * 用户自建标签的 key 与名称 —— 旧实现只把内置 10 个分类写进提示词，自建标签对 AI
 * 完全不可见，于是「记到 XX 标签下」这类要求无从满足（用户反馈）。
 * 模板库页面、提示词注入、分类校验三处现在共用同一份清单，避免口径漂移。
 */
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import { CURRICULUM } from './curriculum.ts';

export interface TemplateCategoryOption {
  key: string;
  name: string;
  /** 用户自建标签（可在模板库创建/删除；内置课程分类不可删） */
  custom: boolean;
}

/** 全部可选分类：内置课程大纲在前（保持课程顺序），用户自建标签按创建顺序在后 */
export function listTemplateCategoryOptions(db: Db): TemplateCategoryOption[] {
  const custom = db
    .prepare('SELECT key, name FROM template_categories WHERE user_id = ? ORDER BY id')
    .all(DEFAULT_USER_ID) as unknown as Array<{ key: string; name: string }>;
  return [
    ...CURRICULUM.map((c) => ({ key: c.key, name: c.name, custom: false })),
    ...custom.map((c) => ({ key: c.key, name: c.name, custom: true })),
  ];
}
