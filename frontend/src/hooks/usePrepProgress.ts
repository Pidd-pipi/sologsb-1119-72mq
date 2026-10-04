import { useMemo } from 'react';
import { useProcedureStore } from '../stores/procedureStore';
import { useGlueStore } from '../stores/glueStore';
import { isGlueUsable, type GlueBatch } from '../types/glue';
import {
  procedureUsesGlue,
  type DerivedProcState,
  type PrepProcedure,
} from '../types/procedure';
import { findSeqGaps } from '../utils/id';

export interface PrepProgress {
  list: PrepProcedure[];
  total: number;
  done: number;
  rolledback: number;
  /** 已失效（胶液到适用期 / 余量不足） */
  invalid: number;
  /** 待补配液信息：老工序有胶种但无配液批次，不沿用完成结论 */
  needInfo: number;
  /**
   * 有效完成数：已完成且既不是「待补」、关联胶液也仍然可用。
   * 老工序缺配液信息时不计入，已完成但胶液失效的节点也不计入。
   */
  effectiveDone: number;
  percent: number;
  /** 当前待办节点（不含已失效 / 待补） */
  current: PrepProcedure | undefined;
  /** 跳号（应为空） */
  gaps: number[];
  /** 关联胶液批次映射，供时间线展示批次状态 */
  glueMap: Map<string, GlueBatch>;
  /** 节点的派生状态（含「待补」） */
  stateOf: (proc: PrepProcedure) => DerivedProcState;
}

/**
 * 计算某标本的工序完成度与当前待办节点。
 * 被标本详情页与工序录入页消费。
 */
export function usePrepProgress(specimenId: string | undefined): PrepProgress {
  const items = useProcedureStore((s) => s.items);
  const glueBatches = useGlueStore((s) => s.items);

  return useMemo<PrepProgress>(() => {
    const list = items
      .filter((it) => (specimenId ? it.specimenId === specimenId : true))
      .sort((a, b) => a.seq - b.seq);
    const glueMap = new Map(glueBatches.map((b) => [b.id, b]));
    const stateOf = (proc: PrepProcedure): DerivedProcState => {
      if (proc.state !== 'done' && proc.state !== 'pending') return proc.state;
      if (procedureUsesGlue(proc) && !proc.glueBatchId) return 'needInfo';
      return proc.state;
    };

    const invalid = list.filter((it) => it.state === 'invalid').length;
    const needInfo = list.filter((it) => stateOf(it) === 'needInfo').length;
    const rolledback = list.filter((it) => it.state === 'rolledback').length;
    const isEffectiveDone = (it: PrepProcedure) => {
      if (stateOf(it) !== 'done') return false;
      if (procedureUsesGlue(it)) {
        const batch = it.glueBatchId ? glueMap.get(it.glueBatchId) : undefined;
        if (!batch || !isGlueUsable(batch)) return false;
      }
      return true;
    };
    const effectiveDone = list.filter(isEffectiveDone).length;
    const done = list.filter((it) => it.state === 'done').length;
    const percent = list.length === 0 ? 0 : Math.round((effectiveDone / list.length) * 100);
    const current = list.find((it) => {
      const s = stateOf(it);
      return s === 'pending';
    });
    const gaps = findSeqGaps(list.map((it) => it.seq));
    return {
      list,
      total: list.length,
      done,
      rolledback,
      invalid,
      needInfo,
      effectiveDone,
      percent,
      current,
      gaps,
      glueMap,
      stateOf,
    };
  }, [items, glueBatches, specimenId]);
}

/**
 * 交付前阻断项：未完成、已失效、待补配液的节点都不允许交付；
 * 已回退节点只做提醒（回退是既有流程允许的状态）。
 */
export function deliveryBlockers(progress: PrepProgress): string[] {
  const blockers: string[] = [];
  for (const proc of progress.list) {
    const s = progress.stateOf(proc);
    if (s === 'pending') blockers.push(`#${proc.seq} ${proc.nodeName} 尚未完成`);
    if (s === 'invalid') blockers.push(`#${proc.seq} ${proc.nodeName} 所用胶液已失效，需重新确认`);
    if (s === 'needInfo') blockers.push(`#${proc.seq} ${proc.nodeName} 缺配液批次信息，需补录后才能交付`);
  }
  return blockers;
}
