import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { postDataChange } from '../utils/bus';
import {
  issueGlue,
  sealBatch as sealBatchSvc,
  sweepGlueBatches,
  GlueIssueError,
  type GlueIssueInput,
  type GlueIssueResult,
} from '../utils/glueService';
import type { GlueBatch, GlueBatchDraft } from '../types/glue';
import type { PrepProcedure } from '../types/procedure';
import { useProcedureStore } from './procedureStore';
import { useSpecimenStore } from './specimenStore';

interface GlueState {
  items: GlueBatch[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: GlueBatchDraft) => Promise<GlueBatch>;
  issue: (batchId: string, input: GlueIssueInput) => Promise<GlueIssueResult>;
  seal: (batchId: string) => Promise<number>;
  sweep: () => Promise<boolean>;
  /** 工序补录 / 重新确认配液：绑定可用胶液批次并恢复节点结论 */
  linkProcedure: (args: {
    procedureId: string;
    glueBatchId: string;
    glueQty: number;
    operator: string;
    specimenNo: string;
  }) => Promise<void>;
}

/** 任何胶液 / 工序 / 标本联动写库后，重新装载三张表并通知其它标签页 */
async function reloadAll(): Promise<void> {
  await Promise.all([
    useGlueStore.getState().load(),
    useProcedureStore.getState().load(),
    useSpecimenStore.getState().load(),
  ]);
  postDataChange('glue-changed');
}

export const useGlueStore = create<GlueState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const items = await db.glueBatches.orderBy('preparedAt').reverse().toArray();
    set({ items, loaded: true });
  },
  async add(draft) {
    const record: GlueBatch = {
      ...draft,
      id: newId('glu'),
      unit: 'ml',
      qty: draft.initialQty,
      preparedAt: Date.now(),
      status: 'active',
      rev: 0,
      issues: [],
    };
    await db.glueBatches.put(record);
    set({ items: [record, ...get().items] });
    postDataChange('glue-changed');
    return record;
  },
  async issue(batchId, input) {
    const result = await issueGlue(batchId, input);
    // 联动可能失效工序、撤回已交付标本，统一刷新
    await reloadAll();
    return result;
  },
  async seal(batchId) {
    const invalidated = await sealBatchSvc(batchId, 'manual');
    await reloadAll();
    return invalidated.length;
  },
  async sweep() {
    const changed = await sweepGlueBatches();
    if (changed) await reloadAll();
    return changed;
  },
  async linkProcedure({ procedureId, glueBatchId, glueQty, operator, specimenNo }) {
    const proc = await db.procedures.get(procedureId);
    const batch = await db.glueBatches.get(glueBatchId);
    if (!proc) throw new Error('工序不存在');
    if (!batch) throw new Error('胶液批次不存在');
    if (batch.status !== 'active') throw new GlueIssueError('sealed', '该胶液批次已封档，请另选批次');
    if (!(glueQty > 0)) throw new GlueIssueError('exceed', '领用量必须大于 0');
    if (glueQty > batch.qty) throw new GlueIssueError('exceed', `余量不足：当前仅剩 ${batch.qty} ${batch.unit}`);

    const wasInvalid = proc.state === 'invalid';
    const restoredState: PrepProcedure['state'] = wasInvalid ? proc.stateBeforeInvalid ?? 'pending' : proc.state;

    await db.transaction('rw', db.glueBatches, db.procedures, db.specimens, async () => {
      const patch: Partial<PrepProcedure> = {
        glueBatchId: batch.id,
        glueLotNo: batch.lotNo,
        glueQty,
        adhesive: batch.adhesive,
        adhesiveConc: batch.concentration,
        state: restoredState,
        stateBeforeInvalid: undefined,
        invalidReason: undefined,
        ...(restoredState === 'done' && !proc.finishedAt ? { finishedAt: Date.now() } : {}),
      };
      await db.procedures.update(procedureId, patch);

      // 补录 / 重新确认同样记一条领用流水，便于批号追溯（按登记量扣减余量）
      const next: GlueBatch = {
        ...batch,
        qty: Math.max(0, Number((batch.qty - glueQty).toFixed(3))),
        rev: batch.rev + 1,
        issues: [
          {
            id: newId('gis'),
            qty: glueQty,
            operator,
            specimenNo,
            procedureId,
            issuedAt: Date.now(),
          },
          ...batch.issues,
        ],
      };
      if (next.qty <= 0) {
        // 余量在补录环节耗尽：批次封档，其它关联节点同步失效（本节点除外）
        next.status = 'sealed';
        next.closedAt = Date.now();
        next.closedReason = 'empty';
        await db.glueBatches.put(next);
        const linked = await db.procedures.where('glueBatchId').equals(next.id).toArray();
        for (const other of linked) {
          if (other.id === procedureId || other.state === 'invalid' || other.state === 'rolledback') continue;
          await db.procedures.update(other.id, {
            state: 'invalid',
            stateBeforeInvalid: other.state,
            invalidReason: '余量不足封档',
          });
          const sp = await db.specimens.get(other.specimenId);
          if (sp?.status === '已交付') {
            await db.specimens.update(sp.id, {
              status: '待交付',
              withdrawReason: `胶液批次 ${next.lotNo} 余量不足封档，关联节点 #${other.seq} 失效，需重新确认`,
              withdrawnAt: Date.now(),
            });
          }
        }
      } else {
        await db.glueBatches.put(next);
      }

      // 标本若因该批胶液被撤回，本节点重新确认后清空撤回标记（仍停留待交付等待复核交付）
      const specimen = await db.specimens.get(proc.specimenId);
      if (specimen?.withdrawnAt) {
        await db.specimens.update(specimen.id, {
          withdrawReason: undefined,
          withdrawnAt: undefined,
        });
      }
    });
    await reloadAll();
  },
}));
