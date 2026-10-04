/** 胶液批次状态 */
export type GlueBatchState = 'usable' | 'invalid';

/** 胶液失效原因 */
export type GlueInvalidReason = 'potlife' | 'depleted' | 'manual';

export interface GlueBatch {
  id: string;
  /** 批号（配液时登记） */
  lotNo: string;
  /** 胶种名称（对应工序的胶种候选） */
  adhesive: string;
  /** 浓度 % */
  concPct: number;
  /** 配液时间 */
  mixedAt: number;
  /** 初始量（同剩余量单位） */
  initialQty: number;
  /** 剩余量，领用后扣减 */
  qty: number;
  unit: string;
  /** 适用期（配液后可使用的分钟数） */
  potLifeMin: number;
  /** 配液责任人 */
  operator: string;
  state: GlueBatchState;
  /** 失效原因与时间 */
  invalidReason?: GlueInvalidReason;
  invalidatedAt?: number;
  /** 领用流水（含工序领用与直接领用） */
  issues: GlueIssue[];
  createdAt: number;
}

/** 胶液领用记录 */
export interface GlueIssue {
  id: string;
  qty: number;
  /** 领用人 */
  operator: string;
  specimenNo: string;
  /** 关联工序 id（工序保存时的领用） */
  procedureId?: string;
  /** 领用事由：工序加固 / 重新确认 / 直接领用 */
  purpose: string;
  issuedAt: number;
}

export type GlueBatchDraft = Omit<
  GlueBatch,
  'id' | 'qty' | 'state' | 'invalidReason' | 'invalidatedAt' | 'issues' | 'createdAt'
>;

/** 适用期截止时间 */
export function potLifeEndAt(batch: Pick<GlueBatch, 'mixedAt' | 'potLifeMin'>): number {
  return batch.mixedAt + batch.potLifeMin * 60 * 1000;
}

/** 剩余适用期（分钟，负数表示已到适用期） */
export function potLifeLeftMin(batch: Pick<GlueBatch, 'mixedAt' | 'potLifeMin'>, now = Date.now()): number {
  return Math.floor((potLifeEndAt(batch) - now) / 60000);
}

/** 批次当前是否可用：未失效、未过适用期、有余量 */
export function isGlueUsable(batch: GlueBatch, now = Date.now()): boolean {
  return batch.state === 'usable' && now < potLifeEndAt(batch) && batch.qty > 0;
}

/** 批次当前不可用的原因（可用时返回 null） */
export function glueInvalidReasonOf(batch: GlueBatch, now = Date.now()): GlueInvalidReason | null {
  if (batch.state === 'invalid') return batch.invalidReason ?? 'manual';
  if (now >= potLifeEndAt(batch)) return 'potlife';
  if (batch.qty <= 0) return 'depleted';
  return null;
}

/** 失效原因文案 */
export const GLUE_INVALID_REASON_LABEL: Record<GlueInvalidReason, string> = {
  potlife: '适用期已到',
  depleted: '余量不足',
  manual: '人工停用',
};

/** 剩余适用期文案 */
export function formatPotLifeLeft(batch: GlueBatch, now = Date.now()): string {
  if (batch.state === 'invalid') {
    return GLUE_INVALID_REASON_LABEL[batch.invalidReason ?? 'manual'];
  }
  const left = potLifeLeftMin(batch, now);
  if (left < 0) return `已过适用期 ${-left} 分钟`;
  if (left < 60) return `剩余 ${left} 分钟`;
  const h = Math.floor(left / 60);
  const m = left % 60;
  return `剩余 ${h} 小时 ${m} 分`;
}

/** 时间戳格式化为 yyyy-MM-dd HH:mm */
export function formatTs(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
