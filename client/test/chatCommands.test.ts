/**
 * chatCommands.ts 单元测试：`/` 快捷指令的解析与匹配。
 *
 * 这些边界正是「悄悄吞掉用户输入」的高发区：只打了个 `/`、命令名拼了一半、
 * 需要参数却没给、多行正文里的斜杠 —— 都必须落回「当普通消息发送」或「等待参数」，
 * 不能静默丢弃。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHAT_COMMANDS,
  commandPrompt,
  commandReady,
  isCommandInput,
  matchChatCommands,
  parseChatCommand,
} from '../src/chatCommands'

describe('isCommandInput', () => {
  it('以 / 开头且单行才算命令态', () => {
    assert.equal(isCommandInput('/new'), true)
    assert.equal(isCommandInput('/problem 二分'), true)
    assert.equal(isCommandInput('/a\n/题目 x'), false) // 多行正文里的斜杠不是命令
    assert.equal(isCommandInput('请解释 /search 的用法'), false) // 不是行首
    assert.equal(isCommandInput(''), false)
  })
})

describe('parseChatCommand', () => {
  it('识别主名与参数', () => {
    const r = parseChatCommand('/problem 二分答案')
    assert.ok(r)
    assert.equal(r.command.name, 'problem')
    assert.equal(r.arg, '二分答案')
  })

  it('识别中文别名', () => {
    assert.equal(parseChatCommand('/题目 二分')?.command.name, 'problem')
    assert.equal(parseChatCommand('/新建')?.command.name, 'new')
  })

  it('无参数命令的 arg 为空串', () => {
    const r = parseChatCommand('/new')
    assert.ok(r)
    assert.equal(r.command.name, 'new')
    assert.equal(r.arg, '')
  })

  it('只打了个 / 或命令名不完整 → null（照常当普通消息）', () => {
    assert.equal(parseChatCommand('/'), null)
    assert.equal(parseChatCommand('/ 二分'), null)
    assert.equal(parseChatCommand('/pro'), null) // 半截命令名不算命中
    assert.equal(parseChatCommand('/notacommand x'), null)
  })

  it('不是命令态一律 null', () => {
    assert.equal(parseChatCommand('二分答案/搜索'), null)
    assert.equal(parseChatCommand('/problem 二分\n第二行'), null)
  })

  it('大小写不敏感', () => {
    assert.equal(parseChatCommand('/NEW')?.command.name, 'new')
    assert.equal(parseChatCommand('/Problem x')?.command.name, 'problem')
  })
})

describe('matchChatCommands', () => {
  it('只在命令态给候选', () => {
    assert.deepEqual(matchChatCommands('普通文本'), [])
    assert.deepEqual(matchChatCommands('/new\n第二行'), [])
  })

  it('空命令名（只打 /）给全部候选', () => {
    assert.equal(matchChatCommands('/').length, CHAT_COMMANDS.length)
  })

  it('按主名前缀过滤', () => {
    assert.deepEqual(matchChatCommands('/pro').map((c) => c.name), ['problem'])
    assert.deepEqual(matchChatCommands('/t').map((c) => c.name), ['template', 'today'])
  })

  it('按中文别名前缀过滤', () => {
    assert.deepEqual(matchChatCommands('/题').map((c) => c.name), ['problem'])
  })

  it('补上参数后不再显示候选（已选定，正在填参数）', () => {
    // '/problem 二分' 仍会命中前缀 problem → 保留候选，便于用户确认自己选对了
    assert.deepEqual(matchChatCommands('/problem 二分').map((c) => c.name), ['problem'])
    // 但拼错的命令名不会有候选
    assert.deepEqual(matchChatCommands('/zzz'), [])
  })
})

describe('commandReady / commandPrompt', () => {
  const problem = CHAT_COMMANDS.find((c) => c.name === 'problem')!
  const newCmd = CHAT_COMMANDS.find((c) => c.name === 'new')!

  it('需要参数的命令：没参数不可执行，给了就可执行', () => {
    assert.equal(commandReady(problem, ''), false)
    assert.equal(commandReady(problem, '   '), false)
    assert.equal(commandReady(problem, '二分'), true)
  })

  it('不需要参数的命令：随时可执行', () => {
    assert.equal(commandReady(newCmd, ''), true)
  })

  it('补全文本以空格结尾，方便接着填参数', () => {
    assert.equal(commandPrompt(problem), '/problem ')
  })
})
