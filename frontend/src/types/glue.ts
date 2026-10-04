/** 胶液批次状态：可调 / 已封档（到适用期、余量耗尽或人工作废） */
export type GlueStatus = 'active' | 'sealed';

/** 封档原因 */
export type GlueCloseReason = 'potlife' | 'empty' | 'manual';

export const GLUE_CLOSE_REASON_LABEL: Record<GlueCloseReason, string> = {
  potlife: '已过适用期',
  empty: '余量耗尽',
  manual: '人工封档',
};

/** 胶液领用流水 */
export interface GlueIssue {
  id: string;
  /** 本次领用量（ml） */
  qty: number;
  operator: string;
  /** 领用关联的标本号 */
  specimenNo: string;
  /** 领用关联的工序节点（工序内领用时有值，材料台账直接领用可缺省） */
  procedureId?: string;
  issuedAt: number;
}

/** 胶液批次（配液登记） */
export interface GlueBatch {
  id: string;
  /** 批号，配液时登记 */
  lotNo: string;
  /** 胶种名称（与工序胶种一致，用于匹配候选） */
  adhesive: string;
  /** 浓度 % */
  concentration: number;
  /** 初始量（ml） */
  initialQty: number;
  /** 当前余量（ml），领用后扣减 */
  qty: number;
  unit: string;
  /** 配制时间 */
  preparedAt: number;
  /** 适用期（分钟），到期封档 */
  potLifeMin: number;
  /** 配液责任人 */
  owner: string;
  status: GlueStatus;
  /** 乐观锁版本号：每次领用/封档 +1，跨标签页领用只允许一个成功 */
  rev: number;
  /** 封档时间 */
  closedAt?: number;
  closedReason?: GlueCloseReason;
  /** 领用流水 */
  issues: GlueIssue[];
}

export type GlueBatchDraft = Pick<
  GlueBatch,
  'lotNo' | 'adhesive' | 'concentration' | 'initialQty' | 'potLifeMin' | 'owner'
>;

/** 适用期截止时间 */
export function potDeadline(batch: Pick<GlueBatch, 'preparedAt' | 'potLifeMin'>): number {
  return batch.preparedAt + batch.potLifeMin * 60 * 1000;
}

/** 适用期剩余分钟（负数表示已到期） */
export function potLifeLeftMin(batch: Pick<GlueBatch, 'preparedAt' | 'potLifeMin'>, now = Date.now()): number {
  return Math.floor((potDeadline(batch) - now) / 60000);
}

/** 胶液当前是否可调：未封档、有余量、未过适用期 */
export function isGlueUsable(batch: GlueBatch, now = Date.now()): boolean {
  return batch.status === 'active' && batch.qty > 0 && now < potDeadline(batch);
}

/** 建议批号：GL-YYYYMMDD-序号 */
export function suggestGlueLotNo(seq: number, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `GL-${date}-${String(seq).padStart(3, '0')}`;
}
