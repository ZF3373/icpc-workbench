import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_PROVIDER_PRESETS,
  capsFromModelNameHint,
  guessModelCaps,
  type ModelCaps,
} from '../../shared/src/aiProviders.ts'

/** 断言某个模型名识别出的档位（缺省的字段用 undefined 显式写出，避免 deepEqual 漏字段） */
const capsOf = (model: string): ModelCaps => guessModelCaps(model) ?? {}

describe('guessModelCaps（内置参数表口径：2026-10 官方文档）', () => {
  it('现役旗舰取各家真实档位，不再是 2025 年的小窗口', () => {
    // DeepSeek V4 代际：1M 上下文 / 384K 输出（旧别名 deepseek-chat|reasoner 同档）
    assert.deepEqual(capsOf('deepseek-flash'), { maxTokens: 393216, contextWindow: 1048576 })
    assert.deepEqual(capsOf('deepseek-v4-pro'), { maxTokens: 393216, contextWindow: 1048576 })
    assert.deepEqual(capsOf('deepseek-chat'), { maxTokens: 393216, contextWindow: 1048576 })
    assert.deepEqual(capsOf('deepseek-reasoner'), { maxTokens: 393216, contextWindow: 1048576 })
    // OpenAI：档位跟「旗舰 / mini-nano」走，不跟代数走
    assert.deepEqual(capsOf('gpt-6.1-sol'), { maxTokens: 128000, contextWindow: 1050000 })
    assert.deepEqual(capsOf('gpt-5.5'), { maxTokens: 128000, contextWindow: 1050000 })
    assert.deepEqual(capsOf('gpt-5.4-mini'), { maxTokens: 128000, contextWindow: 400000 })
    assert.deepEqual(capsOf('gpt-5-mini'), { maxTokens: 128000, contextWindow: 400000 })
    assert.deepEqual(capsOf('gpt-4o'), { maxTokens: 16384, contextWindow: 128000 })
    // Kimi / GLM / Qwen
    assert.deepEqual(capsOf('kimi-k3'), { maxTokens: 65536, contextWindow: 1048576 })
    assert.deepEqual(capsOf('kimi-k2.6'), { maxTokens: 65536, contextWindow: 262144 })
    assert.deepEqual(capsOf('glm-5.3'), { maxTokens: 131072, contextWindow: 1048576 })
    assert.deepEqual(capsOf('glm-4.7'), { maxTokens: 131072, contextWindow: 204800 })
    assert.deepEqual(capsOf('qwen-plus'), { maxTokens: 32768, contextWindow: 1000000 })
    assert.deepEqual(capsOf('qwen3.8-max'), { maxTokens: 131072, contextWindow: 1000000 })
    // Claude：4.6 起含 5 系 = 1M/128K；4 与 4.5 系仍是 200K/64K（当年的 1M beta 已停）
    assert.deepEqual(capsOf('claude-sonnet-5-5'), { maxTokens: 128000, contextWindow: 1000000 })
    assert.deepEqual(capsOf('claude-opus-4-7'), { maxTokens: 128000, contextWindow: 1000000 })
    assert.deepEqual(capsOf('claude-sonnet-4-5'), { maxTokens: 64000, contextWindow: 200000 })
    assert.deepEqual(capsOf('claude-haiku-4-5'), { maxTokens: 64000, contextWindow: 200000 })
    // Gemini 全系 1M / 64K，-image 系是小窗口特例
    assert.deepEqual(capsOf('gemini-3.1-pro-preview'), { maxTokens: 65536, contextWindow: 1048576 })
    assert.deepEqual(capsOf('gemini-2.5-flash'), { maxTokens: 65536, contextWindow: 1048576 })
    assert.deepEqual(capsOf('gemini-3-pro-image'), { maxTokens: 32768, contextWindow: 131072 })
    // 聚合网关里的完整 id（带厂商前缀）
    assert.deepEqual(capsOf('deepseek/deepseek-v4.1-flash'), { maxTokens: 393216, contextWindow: 1048576 })
    assert.deepEqual(capsOf('anthropic/claude-sonnet-5.5'), { maxTokens: 128000, contextWindow: 1000000 })
    assert.deepEqual(capsOf('openai/gpt-6.1-sol'), { maxTokens: 128000, contextWindow: 1050000 })
    assert.deepEqual(capsOf('moonshotai/kimi-k3'), { maxTokens: 65536, contextWindow: 1048576 })
    assert.deepEqual(capsOf('z-ai/glm-5.3'), { maxTokens: 131072, contextWindow: 1048576 })
  })

  it('先专后泛：型号里的日期/版本号/参数量不会被当成窗口', () => {
    // gpt-4.1-mini 属于 4.1 系（1M），不该被「-mini = 400K」的 5.x/6 系规则吃掉
    assert.equal(guessModelCaps('gpt-4.1-mini')?.contextWindow, 1047576)
    // grok-4.20 的「20」是 2025-06 发布日期
    assert.equal(guessModelCaps('grok-4.20')?.contextWindow, 262144)
    // grok-4.5~4.7 才是 500K 档
    assert.equal(guessModelCaps('grok-4.7')?.contextWindow, 500000)
    // doubao：Seed 2.1 pro = 1M，mini/turbo = 256K，老 pro 系仍是 128K
    assert.equal(guessModelCaps('doubao-seed-2.1-pro')?.contextWindow, 1048576)
    assert.equal(guessModelCaps('doubao-seed-2.1-mini')?.contextWindow, 262144)
    assert.equal(guessModelCaps('doubao-seed-2-0-mini')?.contextWindow, 262144)
    assert.equal(guessModelCaps('doubao-pro-32k')?.contextWindow, 131072)
    // o 系列不受 gpt 泛匹配影响
    assert.equal(guessModelCaps('o4-mini')?.contextWindow, 200000)
    // 老式 qwen-max 只有 32K，不能被商用版的 1M 档抬上去
    assert.equal(guessModelCaps('qwen-max')?.contextWindow, 32768)
    assert.equal(guessModelCaps('qwen3-max')?.contextWindow, 262144)
    // mistral-large-3 的「3」是代际；-2512 是版本月份
    assert.equal(guessModelCaps('mistral-large-3-2512')?.contextWindow, 262144)
    assert.equal(guessModelCaps('mistral-small-2405-22b')?.contextWindow, 131072)
  })

  it('认不出的模型不编造数字（返回 null，交给全局兜底）', () => {
    assert.equal(guessModelCaps(''), null)
    assert.equal(guessModelCaps('my-local-model'), null)
    assert.equal(guessModelCaps('internlm2-chat-7b'), null)
    assert.equal(guessModelCaps('bge-reranker-v2'), null)
    // ChatGLM 名字里带 glm，但不能被 GLM 商用系的档位抬到 200K
    assert.deepEqual(capsOf('chatglm3-6b'), { maxTokens: 8192, contextWindow: 32768 })
  })

  it('建议档位内部自洽：输出上限不超过上下文窗口', () => {
    for (const preset of AI_PROVIDER_PRESETS) {
      for (const id of [...preset.defaultModels, preset.defaultModel]) {
        const caps = guessModelCaps(id)
        assert.ok(caps, `预设 ${preset.key} 的模型 ${id} 应能被参数表认出`)
        assert.ok(
          caps!.maxTokens === undefined || caps!.contextWindow! >= caps!.maxTokens,
          `${id}：输出上限 ${caps!.maxTokens} 大于上下文窗口 ${caps!.contextWindow}`,
        )
      }
    }
  })
})

describe('capsFromModelNameHint（名字里写了窗口的模型）', () => {
  it('读出写在名字尾部的窗口标记', () => {
    assert.deepEqual(capsFromModelNameHint('moonshot-v1-128k'), { contextWindow: 131072 })
    assert.deepEqual(capsFromModelNameHint('qwen2.5-7b-instruct-1m'), { contextWindow: 1048576 })
    assert.deepEqual(capsFromModelNameHint('GLM-4.6-200K'), { contextWindow: 204800 })
    assert.deepEqual(capsFromModelNameHint('yi-1.5-34b-chat-1m'), { contextWindow: 1048576 })
    assert.deepEqual(capsFromModelNameHint('command-r-plus-128k-08-24'), { contextWindow: 131072 })
  })

  it('参数量写法（-7b / -32b）不当成窗口；无标记返回 null', () => {
    assert.equal(capsFromModelNameHint('deepseek-r1-distill-qwen-7b'), null)
    assert.equal(capsFromModelNameHint('qwen3-32b'), null)
    assert.equal(capsFromModelNameHint('gpt-4o'), null)
    assert.equal(capsFromModelNameHint('kimi-k2-0905-preview'), null)
    assert.equal(capsFromModelNameHint('bge-m3'), null)
    assert.equal(capsFromModelNameHint(''), null)
  })

  it('小于 32K 的标记视为噪声', () => {
    assert.equal(capsFromModelNameHint('some-tiny-8k'), null)
  })
})
