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

/**
 * 工序节点状态
 * pending 待办 / done 已完成 / rolledback 已回退 / invalid 因胶液到期或余量不足被撤销
 */
export type ProcedureState = 'pending' | 'done' | 'rolledback' | 'invalid';

/** 时间线上的派生状态：老工序有胶种却缺配液批次时标「待补」，不沿用完成结论 */
export type DerivedProcState = ProcedureState | 'needInfo';

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
  /** 关联的胶液批次（配液批号冗余存快照，批次被删/查不到时仍可追溯） */
  glueBatchId?: string;
  glueLotNo?: string;
  /** 本节点领用胶液量 ml */
  glueQty?: number;
  /** 胶液浓度 % */
  adhesiveConc: number;
  /** 被撤销原因（胶液适用期到 / 余量不足） */
  invalidReason?: string;
  /** 失效前状态，重新确认后恢复 */
  stateBeforeInvalid?: ProcedureState;
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
}

export type PrepProcedureDraft = Omit<PrepProcedure, 'id'>;

/** 该工序是否涉及胶液（已选胶种即必须关联配液批次） */
export function procedureUsesGlue(p: Pick<PrepProcedure, 'adhesive'>): boolean {
  return !!p.adhesive?.trim();
}
