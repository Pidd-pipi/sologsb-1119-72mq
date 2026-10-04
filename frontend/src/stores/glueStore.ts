import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import {
  enforceGlueValidity,
  issueGlue,
} from '../utils/glueService';
import { potLifeEndAt, type GlueBatch, type GlueBatchDraft } from '../types/glue';

const CHANNEL_NAME = 'gbfossilprep:glue-sync';

interface GlueState {
  items: GlueBatch[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 配液登记 */
  add: (draft: GlueBatchDraft) => Promise<GlueBatch>;
  /** 直接领用（跨标签页事务，失败返回原因供 UI 恢复草稿） */
  issue: (
    batchId: string,
    payload: { qty: number; operator: string; specimenNo: string; purpose?: string },
  ) => Promise<{ ok: boolean; message: string }>;
  /** 失效巡检：到适用期 / 余量耗尽的批次级联失效，有变更时广播其它标签页 */
  enforce: (opts?: { silent?: boolean }) => Promise<boolean>;
}

function openChannel(): BroadcastChannel | null {
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

const channel = openChannel();

export function broadcastGlueChanged(): void {
  try {
    channel?.postMessage({ type: 'changed', at: Date.now() });
  } catch {
    /* 跨标签页通道不可用时忽略 */
  }
}

export const useGlueStore = create<GlueState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.glueBatches.toArray();
    items.sort((a, b) => b.mixedAt - a.mixedAt);
    set({ items, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const record: GlueBatch = {
      ...draft,
      id: newId('glu'),
      qty: draft.initialQty,
      state: 'usable',
      issues: [],
      createdAt: now,
    };
    await db.glueBatches.put(record);
    set({ items: [record, ...get().items] });
    broadcastGlueChanged();
    return record;
  },
  async issue(batchId, payload) {
    const result = await issueGlue(batchId, payload);
    // 无论成功失败都以库内现状为准重新载入（失败方据此看到另一个标签页的扣减结果）
    await get().load();
    if (result.ok) broadcastGlueChanged();
    return { ok: result.ok, message: result.message };
  },
  async enforce(opts) {
    const changed = await enforceGlueValidity();
    if (changed) {
      await get().load();
      if (!opts?.silent) broadcastGlueChanged();
    }
    return changed;
  },
}));

/**
 * 订阅其它标签页的胶液变更：收到广播后本标签页重新拉取四张表。
 * 由路由 Shell 在启动时挂一次；返回取消订阅函数。
 */
export function subscribeGlueChannel(reload: () => void): () => void {
  if (!channel) return () => undefined;
  const handler = (event: MessageEvent) => {
    if (event.data?.type === 'changed') reload();
  };
  channel.addEventListener('message', handler);
  return () => channel.removeEventListener('message', handler);
}

/** 配液默认批号：胶种缩写-配液日期-当日序号 */
export function suggestLotNo(adhesive: string, mixedAt = Date.now()): string {
  const d = new Date(mixedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const prefix = Array.from(adhesive.replace(/\s|-/g, ''))
    .filter((c) => /[A-Za-z0-9]/.test(c))
    .slice(0, 6)
    .join('')
    .toUpperCase();
  const sameDay = useGlueStore
    .getState()
    .items.filter((b) => potLifeEndAt(b) > 0 && new Date(b.mixedAt).toDateString() === new Date(mixedAt).toDateString()).length;
  return `${prefix || 'GLUE'}-${date}-${String(sameDay + 1).padStart(2, '0')}`;
}
