import { db } from './db';
import { newId } from './id';
import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import { potDeadline, type GlueBatch, type GlueCloseReason, type GlueIssue } from '../types/glue';

/** 领用失败原因，供页面保留草稿并给出提示 */
export type GlueIssueErrorKind = 'notfound' | 'stale' | 'sealed' | 'potlife' | 'empty' | 'exceed';

export class GlueIssueError extends Error {
  kind: GlueIssueErrorKind;
  constructor(kind: GlueIssueErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface GlueIssueInput {
  qty: number;
  operator: string;
  specimenNo: string;
  /** 乐观锁：领用时必须等于批次当前 rev，跨标签页并发只允许一人成功 */
  expectedRev: number;
  procedureId?: string;
}

export interface GlueIssueResult {
  batch: GlueBatch;
  issue: GlueIssue;
  /** 是否导致批次封档（余量耗尽）或关联工序失效 / 标本撤回 */
  invalidated: PrepProcedure[];
  withdrawnSpecimenIds: string[];
}

/** 失效某批次关联的未完成 / 已完成工序；已交付标本同步撤下 */
async function invalidateForBatch(
  tx: {
    procedures: typeof db.procedures;
    specimens: typeof db.specimens;
  },
  batch: GlueBatch,
  reasonText: string,
  excludeProcedureId?: string,
): Promise<{ invalidated: PrepProcedure[]; withdrawnSpecimenIds: string[] }> {
  const linked = await tx.procedures.where('glueBatchId').equals(batch.id).toArray();
  const invalidated: PrepProcedure[] = [];
  const withdrawnSpecimenIds = new Set<string>();

  for (const proc of linked) {
    if (excludeProcedureId && proc.id === excludeProcedureId) continue;
    // 已失效 / 已回退的节点不重复撤销（回退本身就不是完成结论）
    if (proc.state === 'invalid' || proc.state === 'rolledback') continue;
    const patch: Partial<PrepProcedure> = {
      state: 'invalid',
      stateBeforeInvalid: proc.state,
      invalidReason: reasonText,
    };
    await tx.procedures.update(proc.id, patch);
    invalidated.push({ ...proc, ...patch });

    // 已交付标本即使工序已完成也要撤下，回到待交付重新确认
    const specimen = await tx.specimens.get(proc.specimenId);
    if (specimen && !withdrawnSpecimenIds.has(specimen.id)) {
      const wReason = `胶液批次 ${batch.lotNo}（${batch.adhesive}）${reasonText}，关联节点 #${proc.seq} ${proc.nodeName} 失效，交付结论需重新确认`;
      const wPatch: Partial<Specimen> = { status: '待交付', withdrawReason: wReason, withdrawnAt: Date.now() };
      await tx.specimens.update(specimen.id, wPatch);
      withdrawnSpecimenIds.add(specimen.id);
    }
  }

  return { invalidated, withdrawnSpecimenIds: [...withdrawnSpecimenIds] };
}

/**
 * 领用胶液：Dexie 可串行化事务 + rev 乐观锁。
 * 两个浏览器标签页同时领用同一批次时，后提交者 rev 不匹配，写入失败（草稿由页面保留）。
 * 本次领用把余量扣到 0 时批次即封档，其余关联工序立即失效。
 */
export async function issueGlue(batchId: string, input: GlueIssueInput): Promise<GlueIssueResult> {
  // 领用前先把已到适用期的批次封档，避免沿用过期胶液
  await sweepGlueBatches();

  return db.transaction('rw', db.glueBatches, db.procedures, db.specimens, async () => {
    const batch = await db.glueBatches.get(batchId);
    if (!batch) throw new GlueIssueError('notfound', '胶液批次不存在');
    if (batch.rev !== input.expectedRev) {
      throw new GlueIssueError('stale', '该批次刚被其他人领用或封档，余量已变化，请刷新后重试（已保留草稿）');
    }
    if (batch.status !== 'active') throw new GlueIssueError('sealed', '该胶液批次已封档，不能继续领用');
    if (Date.now() >= potDeadline(batch)) throw new GlueIssueError('potlife', '已过适用期，胶液禁止使用');
    if (batch.qty <= 0) throw new GlueIssueError('empty', '余量不足');
    if (!(input.qty > 0)) throw new GlueIssueError('exceed', '领用数量必须大于 0');
    if (input.qty > batch.qty) throw new GlueIssueError('exceed', `余量不足：当前仅剩 ${batch.qty} ${batch.unit}`);

    const issue: GlueIssue = {
      id: newId('gis'),
      qty: input.qty,
      operator: input.operator,
      specimenNo: input.specimenNo,
      procedureId: input.procedureId,
      issuedAt: Date.now(),
    };
    const next: GlueBatch = {
      ...batch,
      qty: Number((batch.qty - input.qty).toFixed(3)),
      issues: [issue, ...batch.issues],
    };

    let invalidated: PrepProcedure[] = [];
    let withdrawnSpecimenIds: string[] = [];
    if (next.qty <= 0) {
      // 余量不足：批次封档，其它在用节点立即失效（本次领用所属节点除外）
      next.status = 'sealed';
      next.closedAt = Date.now();
      next.closedReason = 'empty';
      next.qty = 0;
      const effect = await invalidateForBatch(
        { procedures: db.procedures, specimens: db.specimens },
        next,
        '余量不足封档',
        input.procedureId,
      );
      invalidated = effect.invalidated;
      withdrawnSpecimenIds = effect.withdrawnSpecimenIds;
    }
    next.rev = batch.rev + 1;
    await db.glueBatches.put(next);
    return { batch: next, issue, invalidated, withdrawnSpecimenIds };
  });
}

/** 人工封档（作废）：关联未完成 / 已完成工序立即失效 */
export async function sealBatch(batchId: string, reason: GlueCloseReason = 'manual'): Promise<PrepProcedure[]> {
  const invalidated = await db.transaction('rw', db.glueBatches, db.procedures, db.specimens, async () => {
    const batch = await db.glueBatches.get(batchId);
    if (!batch) return [] as PrepProcedure[];
    const sealed: GlueBatch = {
      ...batch,
      status: 'sealed',
      closedAt: batch.closedAt ?? Date.now(),
      closedReason: batch.closedReason ?? reason,
      rev: batch.rev + 1,
    };
    await db.glueBatches.put(sealed);
    const effect = await invalidateForBatch(
      { procedures: db.procedures, specimens: db.specimens },
      sealed,
      `批次封档（${reason === 'manual' ? '人工作废' : reason}）`,
    );
    return effect.invalidated;
  });
  return invalidated;
}

/**
 * 巡检：到适用期 / 已耗尽但还在 active 的批次立即封档，
 * 并把批次下未完成及已完成工序置为失效、撤下已交付标本。
 * 返回是否发生任何变化（页面据此决定是否刷新与跨页通知）。
 */
export async function sweepGlueBatches(now = Date.now()): Promise<boolean> {
  const openBatches = await db.glueBatches.where('status').equals('active').toArray();
  const due = openBatches.filter((b) => now >= potDeadline(b) || b.qty <= 0);
  if (due.length === 0) return false;

  await db.transaction('rw', db.glueBatches, db.procedures, db.specimens, async () => {
    for (const batch of due) {
      const expired = now >= potDeadline(batch);
      const reason: GlueCloseReason = expired ? 'potlife' : 'empty';
      const sealed: GlueBatch = {
        ...batch,
        status: 'sealed',
        closedAt: now,
        closedReason: reason,
        qty: Math.max(0, batch.qty),
        rev: batch.rev + 1,
      };
      await db.glueBatches.put(sealed);
      await invalidateForBatch(
        { procedures: db.procedures, specimens: db.specimens },
        sealed,
        expired ? '已过适用期封档' : '余量不足封档',
      );
    }
  });
  return true;
}
