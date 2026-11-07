/**
 * 热力图配色单测（node:test 运行）。
 *
 * issue #61 的反馈是「颜色更新完后感觉淡淡的」——这类问题此前只能靠截图肉眼看，
 * 改一次配色就可能悄悄退化。这里把三条**可计算的**视觉性质锁成断言：
 * 1. 四档亮度单调递增（浅→深），否则深浅阶梯会"回跳"；
 * 2. 相邻档对比度达标，否则"练了多少"分不出来；
 * 3. 首档与空格色对比度达标，否则"没练"和"练了一点"同色。
 * 另外守住"整体不比修复前更暗"，防止配色又被压回一片灰绿。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  contrastRatio,
  heatmapPalette,
  HEATMAP_PALETTES,
  parseHexColor,
  relativeLuminance,
  type HeatmapTheme,
} from '../src/heatmapColors.ts'

const THEMES = Object.keys(HEATMAP_PALETTES) as HeatmapTheme[]

/** 各主题的卡片底色：对比度相对**它**才有意义（热力图渲染在卡片里） */
const CARD_BG: Record<HeatmapTheme, string> = { light: '#ffffff', dark: '#1a1a1d' }

/** 逐项门槛：亮色底可用亮度区间窄，相邻档天然拉不开那么远，因此分开定 */
const FLOOR: Record<HeatmapTheme, { adjacent: number; firstVsEmpty: number; meanLuminance: number }> = {
  light: { adjacent: 1.18, firstVsEmpty: 1.18, meanLuminance: 0.38 },
  dark: { adjacent: 1.2, firstVsEmpty: 4.0, meanLuminance: 0.5 },
}

/** 饱和度（HSV 的 S，0~1）：用来守住"亮色档位不是一片灰" */
function saturationOf(hex: string): number {
  const rgb = parseHexColor(hex)
  assert.ok(rgb, `非法色值 ${hex}`)
  const max = Math.max(rgb[0], rgb[1], rgb[2])
  return max === 0 ? 0 : (max - Math.min(rgb[0], rgb[1], rgb[2])) / max
}

describe('heatmapPalette', () => {
  it('每套主题都给齐四个实格色 + 一个空格色，且都是合法的 #rrggbb', () => {
    for (const theme of THEMES) {
      const p = heatmapPalette(theme)
      assert.equal(p.levels.length, 4, `${theme} 应有四档`)
      assert.notEqual(parseHexColor(p.empty), null, `${theme} 空格色非法：${p.empty}`)
      for (const c of p.levels) assert.notEqual(parseHexColor(c), null, `${theme} 档位色非法：${c}`)
    }
  })

  it('四档与空格色互不相同，不会有两档同色', () => {
    for (const theme of THEMES) {
      const p = heatmapPalette(theme)
      const all = [p.empty, ...p.levels]
      assert.equal(new Set(all).size, all.length, `${theme} 存在重复色：${all.join(' ')}`)
    }
  })

  it('档位越"多"越显眼：对卡片底的对比度严格递增', () => {
    // 注意方向在两套主题里是**相反**的：亮色底上练得多 = 更深，暗色底上练得多 = 更亮。
    // 统一的不变量因此不是"亮度递增"，而是"对卡片底的对比度递增"——
    // 那才是眼睛看到的"一格比一格重"。
    for (const theme of THEMES) {
      const ratios = heatmapPalette(theme).levels.map((c) => contrastRatio(c, CARD_BG[theme]))
      for (let i = 1; i < ratios.length; i += 1) {
        assert.ok(
          ratios[i] > ratios[i - 1],
          `${theme} 第 ${i + 1} 档对卡片底不比第 ${i} 档显眼：${ratios.map((v) => v.toFixed(2)).join(' < ')}`,
        )
      }
    }
  })

  it('两套主题的明暗方向各自正确（亮色越练越深、暗色越练越亮）', () => {
    const lightLums = heatmapPalette('light').levels.map(relativeLuminance)
    const darkLums = heatmapPalette('dark').levels.map(relativeLuminance)
    assert.ok(lightLums[3] < lightLums[0], '亮色最深档应比最浅档更暗')
    assert.ok(darkLums[3] > darkLums[0], '暗色最高档应比最低档更亮（深底上提亮才显眼）')
  })

  it('相邻档对比度达到可辨下限', () => {
    for (const theme of THEMES) {
      const p = heatmapPalette(theme)
      for (let i = 1; i < p.levels.length; i += 1) {
        const ratio = contrastRatio(p.levels[i], p.levels[i - 1])
        assert.ok(
          ratio >= FLOOR[theme].adjacent,
          `${theme} 第 ${i}→${i + 1} 档对比度只有 ${ratio.toFixed(2)}，低于 ${FLOOR[theme].adjacent}`,
        )
      }
    }
  })

  it('首档与空格色分得开（"没练"不等于"练了一点"）', () => {
    for (const theme of THEMES) {
      const p = heatmapPalette(theme)
      const ratio = contrastRatio(p.levels[0], p.empty)
      assert.ok(
        ratio >= FLOOR[theme].firstVsEmpty,
        `${theme} 首档对空格只有 ${ratio.toFixed(2)}，低于 ${FLOOR[theme].firstVsEmpty}`,
      )
    }
  })

  it('空格色对卡片底可见（否则格子像"掉了一块"）', () => {
    for (const theme of THEMES) {
      const p = heatmapPalette(theme)
      const ratio = contrastRatio(p.empty, CARD_BG[theme])
      assert.ok(ratio >= 1.1, `${theme} 空格色对卡片底只有 ${ratio.toFixed(2)}`)
    }
  })

  it('平均亮度不低于下线（防止观感再次变淡）', () => {
    for (const theme of THEMES) {
      const lums = heatmapPalette(theme).levels.map(relativeLuminance)
      const mean = lums.reduce((a, b) => a + b, 0) / lums.length
      assert.ok(
        mean >= FLOOR[theme].meanLuminance,
        `${theme} 平均相对亮度 ${mean.toFixed(3)} 低于 ${FLOOR[theme].meanLuminance}`,
      )
    }
  })

  it('亮色档位饱和度递增（浅档柔和、深档够"绿"，不是一片灰）', () => {
    const sats = heatmapPalette('light').levels.map(saturationOf)
    for (let i = 1; i < sats.length; i += 1) {
      assert.ok(
        sats[i] > sats[i - 1],
        `亮色第 ${i + 1} 档饱和度未高于前一档：${sats.map((v) => v.toFixed(2)).join(',')}`,
      )
    }
    // 旧版首档 #cfe2d6 饱和度仅 0.08，读作灰色；这一档必须明显有"绿"
    assert.ok(sats[0] >= 0.35, `亮色最浅档饱和度 ${sats[0].toFixed(2)} 偏低，仍会被读成灰`)
  })
})

describe('contrastRatio / relativeLuminance', () => {
  it('同色对比度为 1，黑白为 21', () => {
    assert.equal(contrastRatio('#123456', '#123456'), 1)
    assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-9)
  })

  it('对比度与参数顺序无关', () => {
    const a = '#8cefb4'
    const b = '#086f40'
    assert.equal(contrastRatio(a, b), contrastRatio(b, a))
  })

  it('相对亮度对非法色值返回 NaN（而不是静默当成 0）', () => {
    assert.ok(Number.isNaN(relativeLuminance('#12')))
    assert.ok(Number.isNaN(relativeLuminance('rgba(0,0,0,1)')))
    assert.equal(parseHexColor('#GGGGGG'), null)
  })

  it('接受大小写混写的色值', () => {
    assert.equal(relativeLuminance('#8CEFB4'), relativeLuminance('#8cefb4'))
  })
})
