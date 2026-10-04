import { useMemo } from 'react';
import { useProcedureStore } from '../stores/procedureStore';
import { glueStateOf, type PrepProcedure } from '../types/procedure';
import { findSeqGaps } from '../utils/id';

export interface PrepProgress {
  list: PrepProcedure[];
  total: number;
  done: number;
  rolledback: number;
  percent: number;
  /** 当前待办节点（待补 / 失效的未完成节点优先暴露） */
  current: PrepProcedure | undefined;
  /** 跳号（应为空） */
  gaps: number[];
  /** 胶液待补节点数 */
  pendingSupplement: number;
  /** 胶液失效节点数 */
  glueInvalid: number;
}

/**
 * 计算某标本的工序完成度与当前待办节点。
 * 被标本详情页与工序录入页消费。
 */
export function usePrepProgress(specimenId: string | undefined): PrepProgress {
  const items = useProcedureStore((s) => s.items);

  return useMemo<PrepProgress>(() => {
    const list = items
      .filter((it) => (specimenId ? it.specimenId === specimenId : true))
      .sort((a, b) => a.seq - b.seq);
    const isFinishingBlocked = (it: PrepProcedure) =>
      ['pending_supplement', 'invalid'].includes(glueStateOf(it));
    const done = list.filter((it) => it.state === 'done' && !isFinishingBlocked(it)).length;
    const rolledback = list.filter((it) => it.state === 'rolledback').length;
    const pendingSupplement = list.filter((it) => glueStateOf(it) === 'pending_supplement').length;
    const glueInvalid = list.filter((it) => glueStateOf(it) === 'invalid').length;
    const percent = list.length === 0 ? 0 : Math.round((done / list.length) * 100);
    // 待补 / 失效节点排在最前，保证技师一打开就被拦住
    const current =
      list.find((it) => isFinishingBlocked(it) && it.state !== 'done') ??
      list.find((it) => glueStateOf(it) === 'invalid') ??
      list.find((it) => it.state !== 'done');
    const gaps = findSeqGaps(list.map((it) => it.seq));
    return { list, total: list.length, done, rolledback, percent, current, gaps, pendingSupplement, glueInvalid };
  }, [items, specimenId]);
}
