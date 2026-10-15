import type { AiProvider, ChatMessage, ToolCall } from './provider.ts';
import { readProblemTool } from './read-problem.ts';
import type { ToolContext } from './tools/registry.ts';

/** 非流式 AI 入口共用的有界读题循环，最终一轮关闭工具，保留原入口的输出格式。 */
export async function chatWithProblemReading(
  provider: Pick<AiProvider, 'chat'>,
  initial: ChatMessage[],
  ctx: ToolContext,
): Promise<string> {
  const messages = [...initial];
  // 只统计真正执行读题的时间；模型思考不能耗尽尚未开始的抓取预算。
  let remainingToolMs = 30_000;
  for (let round = 0; round < 4; round++) {
    ctx.signal?.throwIfAborted();
    let calls: ToolCall[] | undefined;
    const final = round === 3;
    const raw = await provider.chat(messages, {
      tools: final ? undefined : [readProblemTool.definition],
      parseDsmlTools: !final, signal: ctx.signal,
      onFinish: (_reason, tc) => { calls = tc; },
    });
    ctx.signal?.throwIfAborted();
    if (!calls?.length || final) return raw;
    if (calls.length > 8) throw new Error('单轮读题请求过多');
    messages.push({ role: 'assistant', content: raw, tool_calls: calls });
    for (const call of calls) {
      ctx.signal?.throwIfAborted();
      let content: string;
      const started = Date.now();
      try {
        if (remainingToolMs <= 0) throw new Error('读题预算已用完');
        const toolDeadline = AbortSignal.timeout(remainingToolMs);
        const toolSignal = ctx.signal ? AbortSignal.any([ctx.signal, toolDeadline]) : toolDeadline;
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        content = call.function.name === 'read_problem'
          ? (await readProblemTool.execute(args, { ...ctx, signal: toolSignal })).content
          : '本轮仅支持 read_problem，请使用已提供的题目。';
      } catch {
        ctx.signal?.throwIfAborted();
        content = '未取得题面或读题预算已用完，不得编造题意或卡点。';
      } finally {
        remainingToolMs = Math.max(0, remainingToolMs - (Date.now() - started));
      }
      messages.push({ role: 'tool', content, tool_call_id: call.id });
    }
    if (round === 2) messages.push({ role: 'user', content: '读取轮数已达上限，请依据已取得的证据按原要求输出最终结果。未读到的题标明仅按标签与难度初选、待核验；不要编造具体考点。' });
  }
  throw new Error('AI 未返回最终结果');
}
