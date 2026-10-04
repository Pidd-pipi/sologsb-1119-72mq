import { db } from './db';
import { newId } from './id';
import {
  glueInvalidReasonOf,
  GLUE_INVALID_REASON_LABEL,
  type GlueBatch,
  type GlueIssue,
  type GlueInvalidReason,
} from '../types/glue';
import {
  stepNeedsGlue,
  type PrepProcedure,
  type PrepProcedureDraft,
  type ProcedureGlueInvalidReason,
} from '../types/procedure';

export interface GlueSelection {
  batchId: string;
  qty: number;
  operator: string;
  specimenNo: string;
}

export type GlueActionCode = 'ok' | 'potlife' | 'depleted' | 'manual' | 'qty' | 'conflict';

export interface GlueActionResult {
  ok: boolean;
  code: GlueActionCode;
  message: string;
}

export interface CreateGluedResult extends GlueActionResult {
  procedure?: PrepProcedure;
}

function fail(code: Exclude<GlueActionCode, 'ok'>, message: string): GlueActionResult {
  return { ok: false, code, message };
}

/**
 * 将一个批次标记失效，并级联处理绑定它的工序与已交付标本：
 * - 未完成工序：立即失效、回到待办，等待重新确认；
 * - 已完成工序：胶液绑定失效（完成结论不再可靠）；
 * - 关联标本若已交付：撤下，回到待交付队列。
 * 必须在持有 glueBatches / procedures / specimens 的读写事务中调用。
 *
 * excludeProcedureIds：本次操作（领用/重新确认）中刚把余量用完的工序自身——
 * 它使用的是最后一份有效胶液，不随「余量不足」失效。
 */
async function invalidateBatchCascade(
  tables: {
    glueBatches: typeof db.glueBatches;
    procedures: typeof db.procedures;
    specimens: typeof db.specimens;
  },
  batch: GlueBatch,
  reason: GlueInvalidReason,
  now: number,
  excludeProcedureIds: Set<string> = new Set(),
): Promise<Set<string>> {
  const reasonLabel = GLUE_INVALID_REASON_LABEL[reason];
  const procedures = await tables.procedures.toArray();
  const affectedSpecimenIds = new Set<string>();
  const reasonTs = now;

  const nextProcedures = procedures.map((p) => {
    if (p.glue?.batchId !== batch.id || p.glue.glueState !== 'confirmed') return p;
    if (excludeProcedureIds.has(p.id)) return p;
    affectedSpecimenIds.add(p.specimenId);
    const nextBinding = {
      ...p.glue,
      glueState: 'invalid' as const,
      invalidReason: reason as ProcedureGlueInvalidReason,
      invalidatedAt: reasonTs,
      glueNote: `批号 ${batch.lotNo} ${reasonLabel}，胶液结论失效，须用新批次重新确认`,
    };
    const next: PrepProcedure = { ...p, glue: nextBinding };
    // 未完成工序立即失效并回到待办；已完成节点保留完成标记但胶液结论失效
    if (next.state !== 'done') {
      next.state = 'pending';
      next.finishedAt = undefined;
    }
    return next;
  });

  await tables.procedures.bulkPut(nextProcedures);

  if (affectedSpecimenIds.size > 0) {
    const specimens = await tables.specimens.where('id').anyOf([...affectedSpecimenIds]).toArray();
    const withdrawn = specimens
      .filter((s) => s.status === '已交付')
      .map((s) => ({
        ...s,
        status: '已撤下' as const,
        withdrawnAt: reasonTs,
        withdrawReason: `批号 ${batch.lotNo} ${reasonLabel}，交付标本撤下，待重新加固/确认`,
      }));
    if (withdrawn.length > 0) await tables.specimens.bulkPut(withdrawn);
  }

  return affectedSpecimenIds;
}

/**
 * 失效巡检：把已过适用期或余量耗尽的在用批次置为失效并级联。
 * 返回是否发生了变更（供调用方决定是否重载/广播）。
 */
export async function enforceGlueValidity(now = Date.now()): Promise<boolean> {
  let changed = false;
  await db.transaction('rw', db.glueBatches, db.procedures, db.specimens, async () => {
    const batches = await db.glueBatches.toArray();

    for (const batch of batches) {
      // 仅处理「本次巡检中发生失效转换」的批次；已失效批次此前已级联过，不回溯
      if (batch.state !== 'usable') continue;
      const reason = glueInvalidReasonOf(batch, now);
      if (!reason) continue;
      changed = true;
      const nextBatch: GlueBatch = { ...batch, state: 'invalid', invalidReason: reason, invalidatedAt: now };
      await db.glueBatches.put(nextBatch);
      await invalidateBatchCascade(db, nextBatch, reason, now);
    }
  });
  return changed;
}

/** 领用前置校验（供表单即时提示，实际写入仍以事务内结果为准） */
export function checkGlueUsable(batch: GlueBatch | undefined, qty: number, now = Date.now()): GlueActionResult {
  if (!batch) return fail('conflict', '未找到胶液批次，可能已在另一标签页被停用');
  if (!(qty > 0)) return fail('qty', '领用数量必须大于 0');
  const reason = glueInvalidReasonOf(batch, now);
  if (reason === 'potlife') return fail('potlife', `批号 ${batch.lotNo} 适用期已到，禁止领用，请重新配液`);
  if (reason === 'manual') return fail('manual', `批号 ${batch.lotNo} 已停用，禁止领用`);
  if (reason === 'depleted' || qty > batch.qty) {
    return fail('depleted', `批号 ${batch.lotNo} 余量不足：现存 ${batch.qty} ${batch.unit}，申请 ${qty} ${batch.unit}`);
  }
  return { ok: true, code: 'ok', message: 'ok' };
}

/**
 * 胶液领用（跨标签页串行化的原子事务）：
 * 校验适用期/余量 → 写领用流水并扣减余量；扣完自动失效级联。
 * 两个标签页同时领用时只有一个事务成功，失败方返回冲突原因，由 UI 恢复草稿。
 */
export async function issueGlue(
  batchId: string,
  payload: { qty: number; operator: string; specimenNo: string; purpose?: string },
  now = Date.now(),
): Promise<GlueActionResult> {
  try {
    return await db.transaction('rw', db.glueBatches, db.procedures, db.specimens, async () => {
      const batch = await db.glueBatches.get(batchId);
      const check = checkGlueUsable(batch, payload.qty, now);
      if (!check.ok || !batch) return check;

      const issue: GlueIssue = {
        id: newId('gis'),
        qty: payload.qty,
        operator: payload.operator.trim(),
        specimenNo: payload.specimenNo || '未关联标本',
        purpose: payload.purpose ?? '直接领用',
        issuedAt: now,
      };
      const nextQty = batch.qty - payload.qty;
      const nextBatch: GlueBatch = {
        ...batch,
        qty: nextQty,
        issues: [issue, ...batch.issues],
      };

      if (nextQty <= 0) {
        nextBatch.state = 'invalid';
        nextBatch.invalidReason = 'depleted';
        nextBatch.invalidatedAt = now;
        await db.glueBatches.put(nextBatch);
        await invalidateBatchCascade(db, nextBatch, 'depleted', now);
        return { ok: true, code: 'ok', message: '领用成功，该批次余量已扣完并自动失效' };
      }

      await db.glueBatches.put(nextBatch);
      return { ok: true, code: 'ok', message: '领用成功' };
    });
  } catch (err) {
    return fail('conflict', `写入失败（可能另一标签页同时领用），草稿已保留：${(err as Error).message}`);
  }
}

/**
 * 新建用胶工序：序号校验 + 胶液原子领用 + 写入工序（绑定批号快照）。
 * 任一环节失败整个事务回滚：余量未扣、工序未建，调用方保留表单草稿。
 */
export async function createGluedProcedure(
  draft: PrepProcedureDraft,
  glue: GlueSelection,
  now = Date.now(),
): Promise<CreateGluedResult> {
  const procedureId = newId('prc');
  try {
    return await db.transaction('rw', db.procedures, db.glueBatches, db.specimens, async () => {
      const sameSpecimen = await db.procedures.where('specimenId').equals(draft.specimenId).toArray();
      const seqs = sameSpecimen.map((p) => p.seq);
      if (seqs.includes(draft.seq)) {
        return fail('conflict', `序号 ${draft.seq} 已被占用（可能另一标签页刚写入），草稿已保留`);
      }

      const batch = await db.glueBatches.get(glue.batchId);
      const check = checkGlueUsable(batch, glue.qty, now);
      if (!check.ok || !batch) return check;

      const boundAt = now;
      const issue: GlueIssue = {
        id: newId('gis'),
        qty: glue.qty,
        operator: glue.operator.trim(),
        specimenNo: glue.specimenNo,
        procedureId,
        purpose: `工序${draft.stepType}`,
        issuedAt: boundAt,
      };
      const record: PrepProcedure = {
        ...draft,
        id: procedureId,
        adhesive: batch.adhesive,
        adhesiveConc: batch.concPct,
        glue: {
          batchId: batch.id,
          lotNo: batch.lotNo,
          issueQty: glue.qty,
          boundAt,
          boundOperator: glue.operator.trim(),
          glueState: 'confirmed',
        },
      };

      const nextQty = batch.qty - glue.qty;
      const nextBatch: GlueBatch = {
        ...batch,
        qty: nextQty,
        issues: [issue, ...batch.issues],
      };
      if (nextQty <= 0) {
        nextBatch.state = 'invalid';
        nextBatch.invalidReason = 'depleted';
        nextBatch.invalidatedAt = boundAt;
      }

      await db.glueBatches.put(nextBatch);
      await db.procedures.put(record);
      if (nextBatch.state === 'invalid') {
        await invalidateBatchCascade(db, nextBatch, 'depleted', boundAt, new Set([procedureId]));
      }
      return { ok: true, code: 'ok', message: '工序已保存并完成胶液领用', procedure: record };
    });
  } catch (err) {
    return fail('conflict', `写入失败（可能另一标签页同时领用同一批次），草稿已保留：${(err as Error).message}`);
  }
}

/**
 * 重新确认：失效/待办工序改用新批次，原子领用并覆盖绑定快照。
 * 若关联标本此前因胶液被撤下，确认后转回「待交付」，由人工重新交付。
 */
export async function reconfirmProcedureGlue(
  procedureId: string,
  glue: GlueSelection,
  now = Date.now(),
): Promise<GlueActionResult> {
  try {
    return await db.transaction('rw', db.procedures, db.glueBatches, db.specimens, async () => {
      const proc = await db.procedures.get(procedureId);
      if (!proc) return fail('conflict', '工序不存在或已被删除');
      if (!stepNeedsGlue(proc.stepType)) return fail('conflict', '该工序不使用胶液');

      const batch = await db.glueBatches.get(glue.batchId);
      const check = checkGlueUsable(batch, glue.qty, now);
      if (!check.ok || !batch) return check;

      const specimen = await db.specimens.get(proc.specimenId);
      const issue: GlueIssue = {
        id: newId('gis'),
        qty: glue.qty,
        operator: glue.operator.trim(),
        specimenNo: specimen?.specimenNo ?? glue.specimenNo,
        procedureId,
        purpose: '重新确认',
        issuedAt: now,
      };

      const nextProc: PrepProcedure = {
        ...proc,
        adhesive: batch.adhesive,
        adhesiveConc: batch.concPct,
        glue: {
          batchId: batch.id,
          lotNo: batch.lotNo,
          issueQty: glue.qty,
          boundAt: now,
          boundOperator: glue.operator.trim(),
          glueState: 'confirmed',
          invalidReason: undefined,
          invalidatedAt: undefined,
          glueNote: undefined,
        },
      };

      const nextQty = batch.qty - glue.qty;
      const nextBatch: GlueBatch = {
        ...batch,
        qty: nextQty,
        issues: [issue, ...batch.issues],
      };
      if (nextQty <= 0) {
        nextBatch.state = 'invalid';
        nextBatch.invalidReason = 'depleted';
        nextBatch.invalidatedAt = now;
      }

      await db.glueBatches.put(nextBatch);

      if (nextBatch.state === 'invalid') {
        // 先级联其它工序（排除本次重新确认的节点自身）
        await invalidateBatchCascade(db, nextBatch, 'depleted', now, new Set([procedureId]));
      }

      await db.procedures.put(nextProc);

      if (specimen && specimen.status === '已撤下') {
        const otherBinding = (await db.procedures.where('specimenId').equals(specimen.id).toArray()).some(
          (p) => p.id !== procedureId && p.glue?.glueState === 'invalid',
        );
        if (!otherBinding) {
          await db.specimens.put({
            ...specimen,
            status: '待交付',
            withdrawnAt: undefined,
            withdrawReason: undefined,
          });
        }
      }

      return { ok: true, code: 'ok', message: '已用新批次重新确认' };
    });
  } catch (err) {
    return fail('conflict', `写入失败（可能另一标签页同时领用同一批次），草稿已保留：${(err as Error).message}`);
  }
}

/**
 * 旧工序补配液信息：补登当时批号，不扣减余量（历史追溯，不发生新领用）。
 * 不沿用原完成结论：工序回到待办，由责任人核对后再次「完成节点」。
 * 若补登的批次当前已失效，则直接呈现失效态，要求改用有效批次重新确认。
 */
export async function supplementProcedureGlue(
  procedureId: string,
  payload: { batchId: string; operator: string; note?: string },
  now = Date.now(),
): Promise<GlueActionResult> {
  try {
    return await db.transaction('rw', db.procedures, db.glueBatches, async () => {
      const proc = await db.procedures.get(procedureId);
      if (!proc) return fail('conflict', '工序不存在或已被删除');
      if (!stepNeedsGlue(proc.stepType)) return fail('conflict', '该工序不使用胶液');

      const batch = await db.glueBatches.get(payload.batchId);
      if (!batch) return fail('conflict', '未找到所选胶液批次');

      const reason = glueInvalidReasonOf(batch, now);
      const nextProc: PrepProcedure = {
        ...proc,
        adhesive: batch.adhesive,
        adhesiveConc: batch.concPct,
        state: 'pending',
        finishedAt: undefined,
        glue: {
          batchId: batch.id,
          lotNo: batch.lotNo,
          issueQty: 0,
          boundAt: now,
          boundOperator: payload.operator.trim(),
          glueState: reason ? 'invalid' : 'confirmed',
          invalidReason: reason ?? undefined,
          invalidatedAt: reason ? now : undefined,
          glueNote: payload.note?.trim() || (reason ? '补登批次当前已失效，请改用有效批次重新确认' : '配液信息已补登，请重新核对并完成节点'),
        },
      };
      await db.procedures.put(nextProc);
      return {
        ok: true,
        code: 'ok',
        message: reason ? '已补登，但该批次已失效，需重新确认' : '配液信息已补登，节点待重新完成',
      };
    });
  } catch (err) {
    return fail('conflict', `写入失败，草稿已保留：${(err as Error).message}`);
  }
}
