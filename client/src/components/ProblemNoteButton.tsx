/**
 * 题目 / 比赛 独立笔记的编辑入口（issue #71）。
 *
 * 与「复习笔记」的区别在于**归属**：复习笔记挂在复习条目上，移出队列就跟着没了；
 * 这里的笔记挂在题目身份 / 比赛 key 上（后端 /api/notes），与复习队列彻底解耦。
 *
 * 组件形态：一个图标按钮（默认「笔记」），点击读库 → 空则直接开写、有内容则先给
 * 查看卡片（与复习库同一套阅读/写作外壳，见 NoteCardModal / NoteWriterModal）。
 * 有笔记时按钮带一个小圆点，一眼能看出这题/这场记过东西。
 */
import { useCallback, useEffect, useState } from 'react'
import { App as AntdApp, Button, Tooltip } from 'antd'
import { ReadOutlined } from '@ant-design/icons'
import { get, put } from '../api'
import NoteCardModal from './NoteCardModal'
import NoteWriterModal from './NoteWriterModal'
import type { NoteKind } from '../noteView'

/** GET/PUT /api/notes/* 的响应（服务端 routes/notes.ts） */
interface NoteResponse {
  identity: string;
  text: string;
  hasNote: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface NoteTargetProps {
  /** 题目笔记传 platform+problemKey；比赛笔记传 contestKey */
  target: { platform: string; problemKey: string } | { contestKey: string };
  /** 卡片标题里的归属说明：`[1919C] Two Binary Strings` / `CF Round 900` */
  subject?: string;
  /** 依附展示：icon = 只显示图标按钮（行内操作列），text = 显示「笔记」文字按钮 */
  variant?: 'icon' | 'text';
  /** 保存成功后回调（列表据此刷新摘要角标） */
  onSaved?: () => void;
}

const isProblemTarget = (t: NoteTargetProps['target']): t is { platform: string; problemKey: string } =>
  (t as { platform?: string }).platform !== undefined;

function notePath(target: NoteTargetProps['target']): string {
  if (isProblemTarget(target)) {
    return `/api/notes/problem/${encodeURIComponent(target.platform)}/${encodeURIComponent(target.problemKey)}`;
  }
  return `/api/notes/contest/${encodeURIComponent(target.contestKey)}`;
}

export default function ProblemNoteButton({ target, subject, variant = 'icon', onSaved }: NoteTargetProps) {
  const { message } = AntdApp.useApp()
  const [text, setText] = useState('');
  /** 已读过库（未读完前不显示圆点，避免先闪一下「没笔记」再变成有） */
  const [loaded, setLoaded] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false)

  const path = notePath(target);
  const kind: NoteKind = isProblemTarget(target) ? 'problem' : 'contest'

  // 只读一次：入口按钮要显示「有没有笔记」的小圆点，但笔记正文可能很大，
  // 不必每次渲染都拉一遍（切换行时 key 由外层决定，见用法处）
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    get<NoteResponse>(path)
      .then((r) => {
        if (!alive) return;
        setText(r.text ?? '');
        setLoaded(true);
      })
      .catch(() => {
        // 读失败按「没有笔记」处理：入口仍可点，写入时才会报错
        if (alive) setLoaded(true);
      });
    return () => { alive = false; };
  }, [path]);

  const open = useCallback(() => {
    if (text.trim() !== '') setViewing(true);
    else {
      setDraft('');
      setEditing(true);
    }
  }, [text]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await put<NoteResponse>(path, { text: draft });
      setText(r.text ?? '');
      setEditing(false);
      message.success(r.hasNote ? '笔记已保存' : '笔记已清空');
      onSaved?.();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const hasNote = loaded && text.trim() !== '';
  const label = kind === 'problem' ? '题目笔记' : '比赛笔记';

  return (
    <>
      <Tooltip title={hasNote ? `查看/编辑${label}` : `添加${label}（Markdown，与复习队列无关）`}>
        <Button
          size="small"
          type="text"
          className={hasNote ? 'note-dot-btn is-written' : 'note-dot-btn'}
          icon={<ReadOutlined />}
          aria-label={hasNote ? `查看${label}` : `添加${label}`}
          onClick={open}
        >
          {variant === 'text' ? '笔记' : null}
        </Button>
      </Tooltip>

      {viewing && (
        <NoteCardModal
          kind={kind}
          subject={subject ?? null}
          text={text}
          onEdit={() => {
            setViewing(false);
            setDraft(text);
            setEditing(true);
          }}
          onClose={() => setViewing(false)}
        />
      )}

      {editing && (
        <NoteWriterModal
          kind={kind}
          subject={subject ?? null}
          value={draft}
          onChange={setDraft}
          saving={saving}
          onSave={() => void save()}
          onClose={() => setEditing(false)}
          maxLength={20000}
          placeholder={
            kind === 'problem'
              ? '从题面发现的关键性质、最初的卡点、纠偏过程、下次先看什么……（Markdown，可直接粘贴 / 拖入截图）'
              : '选题与换题的判断、赛场策略、赛后复盘结论……（Markdown）'
          }
        />
      )}
    </>
  );
}
