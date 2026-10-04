/** 工序类型 */
export type StepType = '清修' | '加固' | '粘接' | '补配' | '翻模';

export const STEP_TYPES: StepType[] = ['清修', '加固', '粘接', '补配', '翻模'];

/** 各工序类型适用的工具、磨料、胶种候选（表单动态字段用） */
export const STEP_FIELD_MAP: Record<
  StepType,
  { tools: string[]; abrasives: string[]; adhesives: string[]; needConc: boolean }
> = {
  清修: {
    tools: ['气动笔', '剔针', '超声波清洗机', '软毛刷'],
    abrasives: ['400 目', '800 目', '1200 目'],
    adhesives: [],
    needConc: false,
  },
  加固: {
    tools: ['渗透滴管', '真空浸渗罐', '加热台'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '环氧树脂 E44'],
    needConc: true,
  },
  粘接: {
    tools: ['点胶针', '夹持架', '热风枪'],
    abrasives: [],
    adhesives: ['Paraloid B-72', '氰基丙烯酸酯', '动物胶'],
    needConc: true,
  },
  补配: {
    tools: ['刮刀', '雕刻刀', '石膏模'],
    abrasives: ['600 目', '1000 目'],
    adhesives: ['环氧树脂 E44', 'Paraloid B-72'],
    needConc: true,
  },
  翻模: {
    tools: ['硅胶模具', '真空脱泡机', '石膏桶'],
    abrasives: [],
    adhesives: ['硅橡胶', '石膏浆料'],
    needConc: false,
  },
};

/** 工序节点状态 */
export type ProcedureState = 'pending' | 'done' | 'rolledback';

/** 工序与胶液批次的绑定状态 */
export type ProcedureGlueState = 'none' | 'pending_supplement' | 'confirmed' | 'invalid';

/** 失效原因：胶液适用期到 / 余量不足 */
export type ProcedureGlueInvalidReason = 'potlife' | 'depleted' | 'manual';

/** 胶液绑定快照（配液批号、用量随工序留痕） */
export interface ProcedureGlueSnapshot {
  /** 胶液批次 id */
  batchId: string;
  /** 批号快照 */
  lotNo: string;
  /** 领用量 */
  issueQty: number;
  /** 领用（确认）时间 */
  boundAt: number;
  /** 绑定责任人（领用人） */
  boundOperator: string;
}

/** 工序的胶液绑定信息：待补态只有状态与备注，确认/失效态带批次快照 */
export type ProcedureGlueBinding = (
  | ({ glueState: 'pending_supplement' } & Partial<ProcedureGlueSnapshot>)
  | ({ glueState: 'confirmed' | 'invalid' } & ProcedureGlueSnapshot)
) & {
  invalidReason?: ProcedureGlueInvalidReason;
  invalidatedAt?: number;
  /** 待补 / 失效备注 */
  glueNote?: string;
};

/** 修复工序 */
export interface PrepProcedure {
  id: string;
  specimenId: string;
  stepType: StepType;
  /** 节点名称 */
  nodeName: string;
  /** 序号，不得跳号 */
  seq: number;
  /** 工具 */
  tools: string[];
  /** 磨料目数 */
  abrasive: string;
  /** 胶种 */
  adhesive: string;
  /** 胶液浓度 % */
  adhesiveConc: number;
  /** 耗时 min */
  durationMin: number;
  /** 环境温度 ℃ */
  tempC: number;
  /** 相对湿度 % */
  rh: number;
  photoBeforeIds: string[];
  photoAfterIds: string[];
  operator: string;
  startedAt: number;
  state: ProcedureState;
  finishedAt?: number;
  /** 胶液绑定：用胶工序为绑定信息，不用胶工序为 null */
  glue: ProcedureGlueBinding | null;
}

export type PrepProcedureDraft = Omit<PrepProcedure, 'id'>;

/** 该工序类型是否需要胶液（候选胶种非空） */
export function stepNeedsGlue(stepType: StepType): boolean {
  return STEP_FIELD_MAP[stepType].adhesives.length > 0;
}

/** 工序的胶液绑定状态（兼容缺字段的旧记录） */
export function glueStateOf(p: PrepProcedure): ProcedureGlueState {
  if (!stepNeedsGlue(p.stepType)) return 'none';
  return p.glue?.glueState ?? 'pending_supplement';
}

/** 节点在时间线/进度口径下的状态视图 */
export function procedureViewState(
  p: PrepProcedure,
): { label: string; tone: 'success' | 'error' | 'warning' | 'default' } {
  const gs = glueStateOf(p);
  if (gs === 'invalid') return { label: '胶液失效', tone: 'error' };
  if (gs === 'pending_supplement') return { label: '待补配液', tone: 'warning' };
  if (p.state === 'done') return { label: '已完成', tone: 'success' };
  if (p.state === 'rolledback') return { label: '已回退', tone: 'error' };
  return { label: '待办', tone: 'default' };
}
