import Dexie, { type Table } from 'dexie';
import type { Specimen } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import type { SupplyLot } from '../types/supply';
import type { GlueBatch } from '../types/glue';
import type { PrepPhoto } from '../types/photo';
import { makeSketchDataUrl } from '../types/photo';
import { stepNeedsGlue } from '../types/procedure';
import { newId } from './id';

/** 当前数据结构版本，写入 localStorage 便于回显 */
export const DB_VERSION = 3;
export const DB_NAME = 'gbfossilprep';
export const LS_VERSION_KEY = 'gbfossilprep:db-version';

class FossilPrepDB extends Dexie {
  specimens!: Table<Specimen, string>;
  procedures!: Table<PrepProcedure, string>;
  supplies!: Table<SupplyLot, string>;
  glueBatches!: Table<GlueBatch, string>;
  photos!: Table<PrepPhoto, string>;

  constructor() {
    super(DB_NAME);
    // v1：初版四张业务表
    this.version(1).stores({
      specimens: 'id, specimenNo, taxon, locality, status, createdAt',
      procedures: 'id, specimenId, seq, stepType, state',
      supplies: 'id, kind, lotNo, name',
      photos: 'id, specimenId, procedureId, stage',
    });
    // v2：工序增加 state 索引与 finishedAt；影像增加 stage 索引
    this.version(2)
      .stores({
        specimens: 'id, specimenNo, taxon, locality, status, createdAt',
        procedures: 'id, specimenId, seq, stepType, state, startedAt',
        supplies: 'id, kind, lotNo, name, openedAt',
        photos: 'id, specimenId, procedureId, stage, capturedAt',
      })
      .upgrade(async (tx) => {
        // 老版本记录缺字段，迁移时逐表补齐（用宽松类型，避免升级事务里做多余断言）
        await tx
          .table('procedures')
          .toCollection()
          .modify((row: any) => {
            if (!row.state) row.state = 'pending';
            if (row.tools === undefined) row.tools = [];
            if (row.photoBeforeIds === undefined) row.photoBeforeIds = [];
            if (row.photoAfterIds === undefined) row.photoAfterIds = [];
            if (row.adhesiveConc === undefined) row.adhesiveConc = 0;
          });
        await tx
          .table('supplies')
          .toCollection()
          .modify((row: any) => {
            if (!row.issues) row.issues = [];
            if (row.lowThreshold === undefined) row.lowThreshold = 1;
          });
      });
    // v3：胶液批次表 + 工序绑定胶液批号 + 标本撤下状态
    this.version(3)
      .stores({
        specimens: 'id, specimenNo, taxon, locality, status, createdAt',
        procedures: 'id, specimenId, seq, stepType, state, startedAt',
        supplies: 'id, kind, lotNo, name, openedAt',
        glueBatches: 'id, lotNo, adhesive, state, mixedAt',
        photos: 'id, specimenId, procedureId, stage, capturedAt',
      })
      .upgrade(async (tx) => {
        // 旧工序缺配液信息：用胶工序标「待补」；已完成的不沿用完成结论，回到待办重新确认
        await tx
          .table('procedures')
          .toCollection()
          .modify((row: any) => {
            if (row.glue === undefined) {
              if (stepNeedsGlue(row.stepType)) {
                const note = '旧工序缺配液信息，不沿用原完成结论，待补胶液批次后重新确认';
                row.glue = { glueState: 'pending_supplement', glueNote: note };
                if (row.state === 'done') {
                  row.state = 'pending';
                  row.finishedAt = undefined;
                }
              } else {
                row.glue = null;
              }
            }
          });
      });
  }
}

export const db = new FossilPrepDB();

/** 记录结构版本，迁移完成后回写 */
export async function markDbVersion(): Promise<void> {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 首次进入时灌入示范档案，保证页面非空壳 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.specimens.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const hour = 60 * 60 * 1000;
  const specimenId = newId('spm');
  const specimenId2 = newId('spm');
  const specimenId3 = newId('spm');

  const specimens: Specimen[] = [
    {
      id: specimenId,
      specimenNo: 'FP-2024-0031',
      taxon: 'Sinokannemeyeria yingchiaoensis（山西肯氏兽）',
      horizon: '中三叠统二马营组',
      locality: '山西武乡',
      lithology: '紫红色粉砂质泥岩',
      matrixHardness: 2.5,
      dimensions: '320×210×150',
      weight: 4820,
      storageBox: 'A 区 3 匣 2 格',
      status: '修复中',
      createdAt: now - 12 * day,
    },
    {
      id: specimenId2,
      specimenNo: 'FP-2024-0058',
      taxon: 'Psittacosaurus sp.（鹦鹉嘴龙）',
      horizon: '下白垩统义县组',
      locality: '辽宁北票',
      lithology: '灰绿色凝灰质砂岩',
      matrixHardness: 4.2,
      dimensions: '180×120×90',
      weight: 1640,
      storageBox: 'B 区 1 匣 4 格',
      status: '待清修',
      createdAt: now - 5 * day,
    },
    {
      id: specimenId3,
      specimenNo: 'FP-2024-0077',
      taxon: 'Lystrosaurus sp.（水龙兽）',
      horizon: '下三叠统和尚沟组',
      locality: '新疆吉木萨尔',
      lithology: '灰绿色泥质粉砂岩',
      matrixHardness: 3.2,
      dimensions: '260×150×95',
      weight: 2260,
      storageBox: 'C 区 2 匣 1 格',
      status: '已撤下',
      createdAt: now - 20 * day,
      withdrawnAt: now - 6 * day + 6 * hour,
      withdrawReason: '批号 PB72-260927-05 胶液适用期已到，交付标本撤下待重新加固',
    },
  ];

  // 在用胶液批次：刚配 2 小时，适用期 8 小时
  const glueFreshId = newId('glu');
  // 已过适用期的旧批次（标本 0077 曾用于粘接，已交付后被撤下）
  const glueExpiredId = newId('glu');
  // 速凝胶，小容量
  const glueCaId = newId('glu');
  const bondProcId = newId('prc');

  const procedures: PrepProcedure[] = [
    {
      id: newId('prc'),
      specimenId,
      stepType: '清修',
      nodeName: '左侧肩胛区粗清',
      seq: 1,
      tools: ['气动笔', '剔针'],
      abrasive: '800 目',
      adhesive: '',
      adhesiveConc: 0,
      durationMin: 145,
      tempC: 22,
      rh: 48,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: now - 10 * day,
      state: 'done',
      finishedAt: now - 10 * day + 145 * 60000,
      glue: null,
    },
    {
      id: newId('prc'),
      specimenId,
      stepType: '加固',
      nodeName: '围岩裂隙渗透加固',
      seq: 2,
      tools: ['渗透滴管'],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      adhesiveConc: 5,
      durationMin: 90,
      tempC: 23,
      rh: 45,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '林砚秋',
      startedAt: now - 6 * day,
      state: 'pending',
      glue: {
        glueState: 'pending_supplement' as const,
        glueNote: '旧工序缺配液信息，不沿用原完成结论，待补胶液批次后重新确认',
      },
    },
    {
      id: newId('prc'),
      specimenId: specimenId3,
      stepType: '清修',
      nodeName: '吻部围岩清理',
      seq: 1,
      tools: ['剔针', '软毛刷'],
      abrasive: '600 目',
      adhesive: '',
      adhesiveConc: 0,
      durationMin: 120,
      tempC: 21,
      rh: 50,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '周令珩',
      startedAt: now - 9 * day,
      state: 'done',
      finishedAt: now - 9 * day + 120 * 60000,
      glue: null,
    },
    {
      id: bondProcId,
      specimenId: specimenId3,
      stepType: '粘接',
      nodeName: '下颌骨裂隙粘接',
      seq: 2,
      tools: ['点胶针', '夹持架'],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      adhesiveConc: 3,
      durationMin: 70,
      tempC: 22,
      rh: 46,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '周令珩',
      startedAt: now - 6 * day,
      state: 'done',
      finishedAt: now - 6 * day + 70 * 60000,
      glue: {
        batchId: glueExpiredId,
        lotNo: 'PB72-260927-05',
        issueQty: 20,
        boundAt: now - 6 * day,
        boundOperator: '周令珩',
        glueState: 'invalid',
        invalidReason: 'potlife',
        invalidatedAt: now - 6 * day + 6 * hour,
        glueNote: '胶液适用期已到，节点完成结论失效，须用新批次重新确认；关联交付标本已撤下',
      },
    },
  ];

  const photos: PrepPhoto[] = [
    {
      id: newId('pho'),
      specimenId,
      procedureId: procedures[0].id,
      stage: 'before',
      caption: '清修前 · 左侧肩胛区围岩包裹',
      dataUrl: makeSketchDataUrl('清修前 · FP-2024-0031', '#6b5844'),
      capturedAt: now - 10 * day,
    },
    {
      id: newId('pho'),
      specimenId,
      procedureId: procedures[0].id,
      stage: 'after',
      caption: '清修后 · 肩胛骨轮廓显露',
      dataUrl: makeSketchDataUrl('清修后 · FP-2024-0031', '#3f5a4a'),
      capturedAt: now - 9 * day,
    },
  ];
  procedures[0].photoBeforeIds = [photos[0].id];
  procedures[0].photoAfterIds = [photos[1].id];

  const supplies: SupplyLot[] = [
    {
      id: newId('sup'),
      name: 'Paraloid B-72',
      kind: '胶种',
      spec: '分析纯 500 g',
      lotNo: 'B72-20240312',
      qty: 4,
      unit: '瓶',
      openedAt: now - 40 * day,
      shelfLifeMonths: 36,
      lowThreshold: 2,
      issues: [
        {
          id: newId('iss'),
          qty: 1,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0031',
          issuedAt: now - 6 * day,
        },
      ],
    },
    {
      id: newId('sup'),
      name: '碳化硅磨料',
      kind: '磨料',
      spec: '800 目 1 kg',
      lotNo: 'SIC-800-2401',
      qty: 1,
      unit: '袋',
      openedAt: now - 60 * day,
      shelfLifeMonths: 60,
      lowThreshold: 2,
      issues: [],
    },
    {
      id: newId('sup'),
      name: '气动笔针头',
      kind: '耗材',
      spec: '钨钢 2.3 mm',
      lotNo: 'NEEDLE-2312',
      qty: 18,
      unit: '支',
      openedAt: now - 90 * day,
      shelfLifeMonths: 120,
      lowThreshold: 5,
      issues: [],
    },
    {
      id: newId('sup'),
      name: '超声波清洗机',
      kind: '工具',
      spec: '6 L / 40 kHz',
      lotNo: 'US-6L-01',
      qty: 1,
      unit: '台',
      openedAt: now - 200 * day,
      shelfLifeMonths: 120,
      lowThreshold: 1,
      issues: [],
    },
  ];

  const glueBatches: GlueBatch[] = [
    {
      id: glueFreshId,
      lotNo: 'PB72-261003-02',
      adhesive: 'Paraloid B-72',
      concPct: 5,
      mixedAt: now - 2 * hour,
      initialQty: 50,
      qty: 42,
      unit: 'mL',
      potLifeMin: 480,
      operator: '林砚秋',
      state: 'usable',
      issues: [
        {
          id: newId('gis'),
          qty: 8,
          operator: '林砚秋',
          specimenNo: 'FP-2024-0058',
          purpose: '直接领用',
          issuedAt: now - 90 * 60000,
        },
      ],
      createdAt: now - 2 * hour,
    },
    {
      id: glueCaId,
      lotNo: 'CA-261003-01',
      adhesive: '氰基丙烯酸酯',
      concPct: 100,
      mixedAt: now - 30 * 60000,
      initialQty: 20,
      qty: 20,
      unit: 'mL',
      potLifeMin: 120,
      operator: '周令珩',
      state: 'usable',
      issues: [],
      createdAt: now - 30 * 60000,
    },
    {
      id: glueExpiredId,
      lotNo: 'PB72-260927-05',
      adhesive: 'Paraloid B-72',
      concPct: 3,
      mixedAt: now - 6 * day,
      initialQty: 60,
      qty: 24,
      unit: 'mL',
      potLifeMin: 360,
      operator: '周令珩',
      state: 'invalid',
      invalidReason: 'potlife',
      invalidatedAt: now - 6 * day + 6 * hour,
      issues: [
        {
          id: newId('gis'),
          qty: 20,
          operator: '周令珩',
          specimenNo: 'FP-2024-0077',
          procedureId: bondProcId,
          purpose: '工序粘接',
          issuedAt: now - 6 * day,
        },
        {
          id: newId('gis'),
          qty: 16,
          operator: '周令珩',
          specimenNo: '未关联标本',
          purpose: '直接领用',
          issuedAt: now - 6 * day + 2 * hour,
        },
      ],
      createdAt: now - 6 * day,
    },
  ];

  await db.transaction(
    'rw',
    db.specimens,
    db.procedures,
    db.supplies,
    db.glueBatches,
    db.photos,
    async () => {
      await db.specimens.bulkPut(specimens);
      await db.procedures.bulkPut(procedures);
      await db.supplies.bulkPut(supplies);
      await db.glueBatches.bulkPut(glueBatches);
      await db.photos.bulkPut(photos);
    },
  );
}
