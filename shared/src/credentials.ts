/**
 * 平台凭据表单的字段定义（跨端共享真相）。
 *
 * 为什么放在 shared：表单渲染在 client（Settings 页），而「单字段合并保存」的校验
 * 在 server（POST /api/settings/cookies 的 cookieFields 分支）——两端必须用同一份
 * 字段表，否则客户端改名、服务端拒绝或错位都会静默写出错误的 Cookie 头。
 */

// 仅类型引用：index.ts 反向 re-export 本模块，用 import type 避免运行时循环
import type { PlatformId } from './index.ts';

/** 单个凭据字段（对应设置页的一个输入框） */
export interface CookieFieldDef {
  /** 表单内部 key（与 cookieName 分开，允许同平台多项同名的场景） */
  key: string;
  /** 写入 Cookie 头时使用的名字 */
  cookieName: string;
  /** 输入框上方的静态说明（Cookie 名称 + 获取方式）；缺省时不显示标签行 */
  label?: string;
  /** 空输入框时的占位提示 */
  placeholder?: string;
  /** 是否用密码框渲染（长凭据遮蔽显示） */
  password?: boolean;
  /**
   * 透传模式：输入整段 Cookie 头原样使用，不加 `name=` 前缀，
   * 容忍粘贴时带上 "Cookie: " 前缀（自动剥掉）。
   * 用于会话名不固定、或值本身可能含特殊字符的平台。
   */
  raw?: boolean;
  /**
   * 「仅作为配置项保存、不写入 Cookie 头」的字段（如 QOJ 需复刻的浏览器 User-Agent）。
   * 这类字段由适配器按 `opts.<key>` 单独注入，见 CREDENTIAL_UA_FIELDS。
   */
  configOnly?: boolean;
}

/**
 * 需配置凭据的平台字段表。
 * 未在此表中的平台（纯公开 API 的 codeforces/nowcoder）无需 Cookie。
 *
 * 注意：QOJ 的 cf_clearance 与浏览器/IP 绑定，除字段本身外还需用户填「浏览器 UA」
 * （见 CREDENTIAL_UA_FIELDS），否则同一凭据在服务端请求里必然被判失效。
 */
export const COOKIE_FIELDS: Partial<Record<PlatformId, CookieFieldDef[]>> = {
  // AtCoder：**可选凭据**。普通同步走社区镜像 kenkoooo（无需登录）；配置 Cookie 后适配器
  // 额外直连官网抓「我的提交」页（atcoderDirect.ts），补上镜像迟迟未收录的赛后补题/练习提交
  // ——AtCoder 已把提交列表页全部加上登录墙，镜像对这些提交的收录延迟可达数天（2026-10 实测）。
  // 登录会话只有 REVEL_SESSION 一项；整段 Cookie 粘贴亦可（按名分派）。
  atcoder: [
    { key: 'revelSession', cookieName: 'REVEL_SESSION', label: '登录会话（可选：配置后补题/练习提交同步更及时）', placeholder: '粘贴 REVEL_SESSION 的值（整段 Cookie 亦可，会自动分派）', password: true },
  ],
  luogu: [
    { key: 'uid', cookieName: '_uid', label: '用户 uid', placeholder: '粘贴 _uid 的值' },
    { key: 'clientId', cookieName: '__client_id', label: '登录令牌', placeholder: '粘贴 __client_id 的值', password: true },
  ],
  daimayuan: [
    { key: 'sid', cookieName: 'sid', label: '登录会话（仅需此项）', placeholder: '粘贴 sid 的值', password: true },
  ],
  leetcode: [
    { key: 'session', cookieName: 'LEETCODE_SESSION', label: '登录会话', placeholder: '粘贴 LEETCODE_SESSION 的值', password: true },
    { key: 'csrftoken', cookieName: 'csrftoken', label: 'CSRF 令牌', placeholder: '粘贴 csrftoken 的值' },
  ],
  // 计蒜客：登录态分散在 s 与 JSKUSS 两项会话 Cookie（实测站点共 4 项：acw_tc 为 CDN 项、
  // XSRF-TOKEN 供 POST 使用，均不需要）；两项都建议填写，校验不过通常是缺 JSKUSS。
  // 保持原有的 raw 口径（用户已在使用的工作流，本次不动）。
  jisuanke: [
    { key: 's', cookieName: 's', label: '会话（必需）', placeholder: '粘贴 s 的值', password: true, raw: true },
    { key: 'jskuss', cookieName: 'JSKUSS', label: '登录会话（必需）', placeholder: '粘贴 JSKUSS 的值', password: true, raw: true },
  ],
  // QOJ：两项 Cookie 按名分框 + 浏览器 UA，服务端合并（用户不必手工拼 Cookie 串）。
  //  ① 登录会话 —— **站点现名 `__Host-UOJSESSID`**（2026-10 起；旧名 UOJSESSID 仅历史兼容，
  //     发送前由 withHardenedSessionCookie 统一改写成硬化名）；缺它 → 站点 302 跳登录页。
  //  ② cf_clearance —— Cloudflare 通行凭据（逐字节与签发浏览器绑定、约 30 分钟有效）；缺它 → 被挑战。
  //  ③ 浏览器 User-Agent —— configOnly（不进 Cookie 头，由适配器按 ua.qoj 单独注入）；
  //     实测不带 UA 时 cf_clearance 必然失效。属浏览器属性、**全部账号共用**（各账号卡片里
  //     都可编辑同一个 ua.qoj）；password 渲染以支持点眼睛按需查看已保存值。
  //     注意：Console 里 `navigator.userAgent` 的**输出带引号**，整行粘贴会把引号也存进来
  //     （服务端按原样发送，与签发 cf_clearance 的 UA 不再逐字节相同）——见 ua 字段说明。
  //  值较长且含 . _ - 等字符但**不含 ; 与空格**，按名分框即可；整段粘贴亦容忍（自动分派名字）。
  qoj: [
    { key: 'uojsessid', cookieName: 'UOJSESSID', label: '登录会话（必需；站点名为 __Host-UOJSESSID）', placeholder: '粘贴 __Host-UOJSESSID 的值（旧名 UOJSESSID 亦可；整段 Cookie 会自动分派）', password: true },
    { key: 'clearance', cookieName: 'cf_clearance', label: 'Cloudflare 通行凭据（必需）', placeholder: '粘贴 cf_clearance 的值（整段 Cookie 亦可，会自动分派）', password: true },
    { key: 'ua', cookieName: '__ua', label: '浏览器 User-Agent（必需，全部账号共用）', placeholder: '在 qoj.ac 页 Console 输入 navigator.userAgent 回车，整行粘贴', configOnly: true, password: true },
  ],
};

/** 凭据字段表中「不写入 Cookie 头、而是作为请求头单独注入」的字段（如 QOJ 需复刻浏览器 UA） */
export const CREDENTIAL_UA_FIELDS: Partial<Record<PlatformId, string>> = {
  qoj: 'ua',
};

/**
 * 浏览器 User-Agent 的粘贴净化。
 *
 * 占位提示让用户在 qoj.ac 页 Console 执行 `navigator.userAgent` 并「整行粘贴」，
 * 而 Console 回显会**带引号**（`'Mozilla/5.0 (Windows NT 10.0; …) Edg/154.0.0.0'`），
 * 于是引号被一起存进 `ua.<platform>`（实测生产库即如此）。cf_clearance 与签发它的 UA
 * 逐字节绑定，多出的引号纯属噪声，这里剥掉首尾**成对**的引号。
 */
export function cleanUserAgent(value: string): string {
  const v = value.trim();
  const m = /^(['"])([\s\S]*)\1$/.exec(v);
  return m ? m[2]!.trim() : v;
}

/**
 * 会话 Cookie 的「硬化名」对照表（发送前统一改名）。
 *
 * qoj.ac（UOJ 系）已把登录会话从 `UOJSESSID` 迁到 **`__Host-UOJSESSID`**
 * （`__Host-` 是浏览器强制 Secure + Path=/ + 无 Domain 的前缀；实测 2026-10-02：
 * 响应只下发 `__Host-UOJSESSID`，服务端也只读这个名字）。站点改名后的故障特征极具
 * 迷惑性——**值本身完全有效**（同一串值挂 `__Host-UOJSESSID` 名能正常读到提交记录），
 * 只是名字不对，于是被站点当作未登录（302 跳 /login），前端显示「凭据无效 / 已过期」，
 * 用户反复重新配置也没用。
 *
 * 因此发送前把会话项改写成硬化名：老库里存的是旧名、用户粘贴的整段里可能只有新名，
 * 两种输入都能work。存储侧仍沿用旧名（历史数据与既有测试零迁移）。
 */
export const HARDENED_SESSION_COOKIES: Partial<
  Record<PlatformId, { readonly legacy: string; readonly hardened: string }>
> = {
  qoj: { legacy: 'UOJSESSID', hardened: '__Host-UOJSESSID' },
};

/**
 * 把会话 Cookie 改写成站点当前读取的硬化名（幂等）。
 *
 * **原地改名**：除会话项的名字外，其余 Cookie 项及其顺序保持逐字节不变——用户从 F12
 * 整段复制的头里可能带着 Cloudflare 设备校验项（CF_VERIFIED_DEVICE_…）等站点私有的
 * 附加项，任何摘取/重排都会破坏「整段透传」这一约定。
 * 值取硬化名优先、旧名兜底；两者并存时旧名视为历史残留下丢弃（同名歧义比多一项更危险）。
 * 找不到会话项时原样返回。
 */
export function withHardenedSessionCookie(platform: PlatformId, header: string): string {
  const names = HARDENED_SESSION_COOKIES[platform];
  const s = header.trim();
  if (!names || !s) return s;
  const { legacy, hardened } = names;
  const value = cookieFieldValue(s, hardened) || cookieFieldValue(s, legacy);
  if (!value) return s;
  const alreadyHardened = cookieFieldValue(s, hardened) !== '';
  const out: string[] = [];
  for (const part of s.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    const name = eq < 0 ? p : p.slice(0, eq).trim();
    if (name === hardened) {
      if (!out.some((o) => o.startsWith(`${hardened}=`))) out.push(p); // 同名只留第一项
      continue;
    }
    if (name === legacy) {
      // 已有硬化名时丢弃旧名（历史残留，值可能不同）；否则原地改名，位置与其余项不动
      if (!alreadyHardened) out.push(`${hardened}=${p.slice(eq + 1)}`);
      continue;
    }
    out.push(p);
  }
  return out.join('; ');
}

/** 平台字段定义（无则该平台不需要 Cookie） */
export function cookieFieldsOf(platform: PlatformId): CookieFieldDef[] {
  return COOKIE_FIELDS[platform] ?? [];
}

/** 写入 Cookie 头的字段（排除 UA 等 configOnly 项） */
export function cookieOnlyFieldsOf(platform: PlatformId): CookieFieldDef[] {
  return cookieFieldsOf(platform).filter((f) => f.configOnly !== true);
}

/**
 * 从 Cookie 头按名取出单项**裸值**（含 = 的整段头按名提取，裸值原样返回）。
 *
 * 名字前允许 `__Host-` 前缀：站点把会话 Cookie 硬化后（如 qoj.ac 的
 * `UOJSESSID` → `__Host-UOJSESSID`），用户整段粘贴里只有硬化名，按旧名提取会
 * 取到空值——表现为「粘了整段却提示没配置 / 重新配置后依旧无效」（见
 * HARDENED_SESSION_COOKIES）。
 */
export function cookieFieldValue(header: string, name: string): string {
  const s = header.trim();
  if (!s) return '';
  if (!s.includes('=')) return s;
  const m = new RegExp(`(?:^|;)\\s*(?:__Host-)?${name}=([^;\\s]+)`).exec(s);
  return m ? m[1] : '';
}

/**
 * 单个字段值拼装为 Cookie 头片段（尊重 raw 与 configOnly 语义；空值→空串）。
 *
 * raw 字段的两类输入都要正确：
 * - 裸值（如 `raw-sid`）→ 补名字前缀 `sid=raw-sid`
 * - 整段 Cookie 头（如 `Cookie: sid=raw-sid; x=1`）→ 先剥 `Cookie: ` 前缀；
 *   仅含本字段一项时取该值，含多项时原样保留（透传语义）。
 */
export function buildCookieItem(def: CookieFieldDef, value: string): string {
  const raw = value.trim();
  if (!raw) return '';
  if (def.configOnly) return raw; // 非 Cookie 项（如浏览器 UA）由适配器单独注入
  const stripped = raw.replace(/^cookie:\s*/i, '');
  if (!def.raw) {
    // 同样容忍 `__Host-` 硬化名：否则用户把「只有 __Host-UOJSESSID 的整段 Cookie」粘进来时，
    // 这里会因取不到值而返回空串 —— 保存动作反而把会话清掉（比不配置更糟）。
    const m = new RegExp(`(?:^|;)\\s*(?:__Host-)?${def.cookieName}=([^;\\s]+)`).exec(stripped);
    const val = m ? m[1] : stripped.includes(';') ? '' : stripped;
    return val ? `${def.cookieName}=${val}` : '';
  }
  const parts = stripped.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const only = parts[0] ?? '';
    if (!only.includes('=')) return `${def.cookieName}=${only}`;
    const eq = only.indexOf('=');
    return `${only.slice(0, eq)}=${only.slice(eq + 1)}`;
  }
  return parts.join('; ');
}

/**
 * 单字段合并：只更新本次显式修改的字段，其余字段保留已保存的值。
 *
 * 修复缺陷：此前前端把「若干输入框」整体拼装成 Cookie 头后整条覆盖保存，
 * 于是「另一框留空」被理解为「删除该项」——想补填 cf_clearance 就必须把
 * UOJSESSID 一起重填，否则会话被清空、平台随即显示未连接。
 *
 * @param storedHeader 已保存的 Cookie 头（无则空串）
 * @param defs         参与 Cookie 头的字段定义
 * @param patches      本次显式修改的字段（key → 新值；空串 = 显式清空该项）
 */
export function mergeCookieFields(
  storedHeader: string,
  defs: readonly CookieFieldDef[],
  patches: Record<string, string>,
): string {
  // 先做「整段粘贴分派」：某个框里贴进了整段 Cookie 串（含其它字段的 name=value）时，
  // 把里面属于别的字段的值分派过去——这样用户只需把 F12 里的整段 Cookie 粘到任意一框，
  // 各字段自动落位（显式填写的字段优先，不被分派覆盖；空串仍表示显式清空该项）。
  const effective: Record<string, string> = { ...patches };
  for (const value of Object.values(patches)) {
    const blob = String(value ?? '').trim().replace(/^cookie:\s*/i, '');
    if (!blob.includes(';')) continue; // 单项值不可能是「整段」，无需分派
    for (const def of defs) {
      // 只分派给「按名分框」的普通字段：raw 框（整段透传语义）不参与分派——
      // 否则 raw 框的整段内容会被当成其它字段的值注入，与它的透传语义冲突（出现重复项）。
      if (def.configOnly || def.raw || effective[def.key] !== undefined) continue;
      if (!blob.includes(`${def.cookieName}=`)) continue;
      const v = cookieFieldValue(blob, def.cookieName);
      if (v) effective[def.key] = v;
    }
  }

  const out: string[] = [];
  for (const def of defs) {
    // configOnly 字段（浏览器 UA）不属于 Cookie 头，由适配器单独注入；跳过以免被拼进来
    if (def.configOnly) continue;
    const patch = effective[def.key];
    if (patch !== undefined) {
      const item = buildCookieItem(def, patch);
      if (item) out.push(item);
      continue;
    }
    // 未修改：保留已保存的值。
    // raw 字段保存的就是**整段 Cookie 头**（含多项），必须原样透传——
    // 若走 buildCookieItem 会把它按 `name=value` 重新解析，丢掉第二项起的内容。
    // ⚠️ 该分支只在「每个平台至多一个 raw 框」时成立：两个 raw 框时未修改的那项会把整段已存头
    // 重复推入（历史缺陷：计蒜客 s/JSKUSS 双 raw 时只改 s → "s=NEW; s=OLD; JSKUSS=OLD"）；
    // 因此两 Cookie 的平台一律按名分框（见 COOKIE_FIELDS 注释），本分支当前无平台字段命中。
    if (def.raw) {
      const kept = storedHeader.trim();
      if (kept) out.push(kept);
      continue;
    }
    const kept = cookieFieldValue(storedHeader, def.cookieName);
    if (kept) out.push(`${def.cookieName}=${kept}`);
  }
  return out.filter((s) => s !== '').join('; ');
}

/** 已保存的 Cookie 头 → 各字段裸值（供表单遮蔽展示与「已配置」判定） */
export function splitCookieFields(
  storedHeader: string,
  defs: readonly CookieFieldDef[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of defs) {
    const v = cookieFieldValue(storedHeader, def.cookieName);
    if (v) out[def.key] = v;
  }
  return out;
}
