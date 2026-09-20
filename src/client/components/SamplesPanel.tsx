import {useState} from 'react';
import type {SampleRow} from '../../shared/types';

interface Props {
  samples: SampleRow[];
  onSave: (sample: SampleRow, content: string) => Promise<void>;
  onRefresh: () => Promise<unknown>;
  disabled?: boolean;
}

/**
 * 固定样例维护：改样例内容会让 revision 前进；
 * revision 不匹配时保存返回 409，提示样例已被更新。
 */
export function SamplesPanel({samples, onSave, onRefresh, disabled}: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, string>>({});

  const current = samples.find((s) => s.id === openId) ?? null;
  const text = current ? (drafts[current.id] ?? current.content) : '';
  const dirty = current ? text !== current.content : false;

  async function save(sample: SampleRow) {
    setBusy(sample.id);
    setMessages((m) => ({...m, [sample.id]: ''}));
    try {
      await onSave(sample, drafts[sample.id] ?? sample.content);
      setMessages((m) => ({...m, [sample.id]: `已保存，revision 前进到新版本`}));
    } catch (error) {
      const status = (error as {status?: number}).status;
      setMessages((m) => ({
        ...m,
        [sample.id]:
          status === 409
            ? '保存冲突：样例已被更新（revision 不匹配），已重新加载最新版本，请合并你的修改'
            : `保存失败：${(error as Error).message}`,
      }));
      // 409 后丢弃本地草稿，跟随服务端最新版本
      if (status === 409) {
        setDrafts((d) => {
          const next = {...d};
          delete next[sample.id];
          return next;
        });
      }
    } finally {
      setBusy(null);
      await onRefresh();
    }
  }

  return (
    <div className="samples-panel">
      <div className="section-head">
        <h3>固定样例</h3>
        <button className="mini" onClick={onRefresh} disabled={disabled}>
          刷新列表
        </button>
      </div>
      <div className="sample-editor-list">
        {samples.map((s) => (
          <div key={s.id} className={`sample-editor ${openId === s.id ? 'open' : ''}`}>
            <button className="sample-editor-head" onClick={() => setOpenId(openId === s.id ? null : s.id)}>
              <span>{s.name}</span>
              <small>rev {s.revision}</small>
            </button>
            {openId === s.id && (
              <div className="sample-editor-body">
                <textarea
                  aria-label={`编辑样例 ${s.name}`}
                  value={drafts[s.id] ?? s.content}
                  disabled={disabled || busy === s.id}
                  onChange={(e) => setDrafts((d) => ({...d, [s.id]: e.target.value}))}
                />
                <div className="sample-editor-foot">
                  <button className="mini primary" disabled={disabled || !dirty || busy === s.id} onClick={() => void save(s)}>
                    {busy === s.id ? '保存中…' : '保存样例'}
                  </button>
                  {dirty && <span className="muted">有未保存修改</span>}
                  {messages[s.id] && <span className={messages[s.id].includes('冲突') ? 'err-text' : 'ok-text'}>{messages[s.id]}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
