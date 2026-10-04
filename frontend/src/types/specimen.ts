/** 标本状态 */
export type SpecimenStatus = '待清修' | '修复中' | '已加固' | '待交付' | '已交付' | '已撤下';

export const SPECIMEN_STATUSES: SpecimenStatus[] = [
  '待清修',
  '修复中',
  '已加固',
  '待交付',
  '已交付',
  '已撤下',
];

/** 化石标本 */
export interface Specimen {
  id: string;
  /** 标本号 */
  specimenNo: string;
  /** 分类鉴定 */
  taxon: string;
  /** 层位 */
  horizon: string;
  /** 产地 */
  locality: string;
  /** 围岩岩性 */
  lithology: string;
  /** 围岩莫氏硬度 */
  matrixHardness: number;
  /** 尺寸 mm，形如 210×140×60 */
  dimensions: string;
  /** 重量 g */
  weight: number;
  /** 匣位 */
  storageBox: string;
  status: SpecimenStatus;
  createdAt: number;
  /** 因胶液失效被撤下的时间 */
  withdrawnAt?: number;
  /** 撤下原因（胶液批号 / 适用期 / 余量） */
  withdrawReason?: string;
}

export type SpecimenDraft = Omit<Specimen, 'id' | 'createdAt'>;
