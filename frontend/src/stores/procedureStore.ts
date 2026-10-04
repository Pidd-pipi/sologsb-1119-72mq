import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { glueStateOf, type PrepProcedure, type PrepProcedureDraft } from '../types/procedure';

interface ProcedureState {
  items: PrepProcedure[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PrepProcedureDraft) => Promise<PrepProcedure>;
  /** 完成节点；胶液待补 / 失效的节点会被拒绝，返回错误原因 */
  finish: (id: string) => Promise<{ ok: boolean; message: string }>;
  rollback: (id: string, reason?: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  bySpecimen: (specimenId: string) => PrepProcedure[];
}

export const useProcedureStore = create<ProcedureState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.procedures.toArray();
    items.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: PrepProcedure = { ...draft, id: newId('prc') };
    await db.procedures.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async finish(id) {
    // 以库内最新记录为准，防止另一标签页刚把胶液判失效
    const fresh = await db.procedures.get(id);
    if (!fresh) return { ok: false, message: '节点不存在，可能已在其它标签页被删除' };
    const gs = glueStateOf(fresh);
    if (gs === 'pending_supplement') {
      return { ok: false, message: '该节点缺配液信息（待补），请先补登或选用有效批次重新确认' };
    }
    if (gs === 'invalid') {
      return { ok: false, message: '所用胶液已过适用期或余量耗尽，请用新批次重新确认后再完成' };
    }
    const patch: Partial<PrepProcedure> = { state: 'done', finishedAt: Date.now() };
    await db.procedures.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    return { ok: true, message: '节点已完成' };
  },
  async rollback(id) {
    const patch: Partial<PrepProcedure> = { state: 'rolledback', finishedAt: undefined };
    await db.procedures.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
  },
  async remove(id) {
    await db.procedures.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  bySpecimen(specimenId) {
    return get()
      .items.filter((it) => it.specimenId === specimenId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
