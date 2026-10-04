import 'fake-indexeddb/auto';
import { db } from '../src/utils/db';
import { issueGlue, sweepGlueBatches, sealBatch } from '../src/utils/glueService';
import type { GlueBatch } from '../src/types/glue';
import type { PrepProcedure, Specimen } from '../src/types/procedure';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log('  ✅', msg);
  } else {
    fail++;
    console.error('  ❌', msg);
  }
}

const now = Date.now();
const specimenId = 'spm_test';
const batchId = 'glu_test';
const batchId2 = 'glu_test2';
const procDone = 'prc_done';
const procPending = 'prc_pending';
const procOther = 'prc_other';

async function seed() {
  await db.specimens.bulkPut<Specimen | any>([
    {
      id: specimenId,
      specimenNo: 'T-1',
      taxon: '',
      horizon: '',
      locality: '',
      lithology: '',
      matrixHardness: 3,
      dimensions: '',
      weight: 1,
      storageBox: '',
      status: '已交付',
      createdAt: now,
    },
  ]);
  await db.glueBatches.bulkPut<GlueBatch>([
    {
      id: batchId,
      lotNo: 'LOT-1',
      adhesive: 'Paraloid B-72',
      concentration: 5,
      initialQty: 100,
      qty: 100,
      unit: 'ml',
      preparedAt: now,
      potLifeMin: 240,
      owner: '甲',
      status: 'active',
      rev: 0,
      issues: [],
    },
    {
      id: batchId2,
      lotNo: 'LOT-2',
      adhesive: 'Paraloid B-72',
      concentration: 5,
      initialQty: 10,
      qty: 10,
      unit: 'ml',
      preparedAt: now,
      potLifeMin: 240,
      owner: '乙',
      status: 'active',
      rev: 3,
      issues: [],
    },
  ]);
  await db.procedures.bulkPut<PrepProcedure>([
    {
      id: procDone,
      specimenId,
      stepType: '加固',
      nodeName: '已完成节点',
      seq: 1,
      tools: [],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      glueBatchId: batchId,
      glueLotNo: 'LOT-1',
      adhesiveConc: 5,
      durationMin: 10,
      tempC: 20,
      rh: 50,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '甲',
      startedAt: now - 1000,
      finishedAt: now,
      state: 'done',
    } as PrepProcedure,
    {
      id: procPending,
      specimenId,
      stepType: '加固',
      nodeName: '未完成节点',
      seq: 2,
      tools: [],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      glueBatchId: batchId,
      glueLotNo: 'LOT-1',
      adhesiveConc: 5,
      durationMin: 10,
      tempC: 20,
      rh: 50,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '甲',
      startedAt: now - 500,
      state: 'pending',
    } as PrepProcedure,
    {
      id: procOther,
      specimenId,
      stepType: '加固',
      nodeName: '本次领用节点',
      seq: 3,
      tools: [],
      abrasive: '',
      adhesive: 'Paraloid B-72',
      glueBatchId: batchId2,
      glueLotNo: 'LOT-2',
      adhesiveConc: 5,
      durationMin: 10,
      tempC: 20,
      rh: 50,
      photoBeforeIds: [],
      photoAfterIds: [],
      operator: '乙',
      startedAt: now - 200,
      state: 'pending',
    } as PrepProcedure,
  ]);
}

async function main() {
  await seed();

  console.log('1) 正常领用扣减余量、rev +1');
  const r1 = await issueGlue(batchId, {
    qty: 30,
    operator: '甲',
    specimenNo: 'T-1',
    expectedRev: 0,
  });
  assert(r1.batch.qty === 70, `余量应为 70，实际 ${r1.batch.qty}`);
  assert(r1.batch.rev === 1, `rev 应为 1，实际 ${r1.batch.rev}`);
  assert(r1.batch.issues.length === 1, '领用流水 1 条');

  console.log('2) 两个标签页并发领用（同 rev），只允许一人成功');
  const [a, b] = await Promise.allSettled([
    issueGlue(batchId, { qty: 20, operator: '标签页A', specimenNo: 'T-1', expectedRev: 1 }),
    issueGlue(batchId, { qty: 25, operator: '标签页B', specimenNo: 'T-1', expectedRev: 1 }),
  ]);
  assert(a.status === 'fulfilled' || b.status === 'fulfilled', '至少一人成功');
  assert(!(a.status === 'fulfilled' && b.status === 'fulfilled'), '不能两人都成功');
  const loser = a.status === 'rejected' ? a : b;
  const winner = a.status === 'fulfilled' ? a.value : b.status === 'fulfilled' ? b.value : null;
  // @ts-ignore
  assert(loser?.reason?.kind === 'stale', `失败者原因为 stale，实际 ${(loser as any)?.reason?.kind}`);
  assert(!!winner && [50, 45].includes(winner.batch.qty), `成功者余量扣减正确：${winner?.batch.qty}`);
  assert(!!winner && winner.batch.rev === 2, `成功者 rev=2：${winner?.batch.rev}`);

  console.log('3) 超余量领用失败');
  let errKind = '';
  try {
    await issueGlue(batchId, { qty: 999, operator: '甲', specimenNo: 'T-1', expectedRev: 2 });
  } catch (e: any) {
    errKind = e.kind;
  }
  assert(errKind === 'exceed', `超量报 exceed，实际 ${errKind}`);

  console.log('4) 最后一次领用把余量扣到 0：批次封档，其它关联工序失效，本次领用节点不失效');
  const r4 = await issueGlue(batchId2, {
    qty: 10,
    operator: '乙',
    specimenNo: 'T-1',
    expectedRev: 3,
    procedureId: procOther,
  });
  assert(r4.batch.status === 'sealed' && r4.batch.closedReason === 'empty', '批次因余量耗尽封档');
  const doneAfter = await db.procedures.get(procDone);
  const pendAfter = await db.procedures.get(procPending);
  const otherAfter = await db.procedures.get(procOther);
  // 注意：procDone/procPending 关联的是 batchId 不是 batchId2，所以这步不应失效；换成 batchId 耗尽再验证
  assert(doneAfter!.state === 'done' && pendAfter!.state === 'pending', '其它批次的节点不受影响');
  assert(otherAfter!.state === 'pending', '本次领用节点保持原状');

  console.log('5) 批次耗尽封档时（非领用触发），已完成与未完成节点都失效，已交付标本撤下');
  // 手工把 batchId 余量改成 0 再 sweep
  const b1 = await db.glueBatches.get(batchId)!;
  await db.glueBatches.put({ ...b1!, qty: 0 });
  const changed = await sweepGlueBatches();
  assert(changed, '巡检发现变化');
  const doneS = await db.procedures.get(procDone);
  const pendS = await db.procedures.get(procPending);
  assert(doneS!.state === 'invalid', '已完成节点被撤销为失效');
  assert(doneS!.stateBeforeInvalid === 'done', '记录失效前状态 done');
  assert(pendS!.state === 'invalid', '未完成节点也被撤销为失效');
  assert(pendS!.stateBeforeInvalid === 'pending', '记录失效前状态 pending');
  const sp = await db.specimens.get(specimenId);
  assert(sp!.status === '待交付', `已交付标本撤回到待交付，实际 ${sp!.status}`);
  assert(!!sp!.withdrawReason, '写入撤回原因');

  console.log('6) 适用期到期巡检封档');
  const expId = 'glu_exp';
  await db.glueBatches.put({
    id: expId,
    lotNo: 'LOT-EXP',
    adhesive: 'Paraloid B-72',
    concentration: 5,
    initialQty: 50,
    qty: 40,
    unit: 'ml',
    preparedAt: now - 300 * 60000,
    potLifeMin: 240,
    owner: '丙',
    status: 'active',
    rev: 0,
    issues: [],
  });
  await sweepGlueBatches();
  const exp = await db.glueBatches.get(expId);
  assert(exp!.status === 'sealed' && exp!.closedReason === 'potlife', '到期封档原因为 potlife');

  console.log('7) 人工封档返回失效节点数');
  const manualId = 'glu_man';
  const manualProc = 'prc_manual';
  await db.glueBatches.put({
    id: manualId,
    lotNo: 'LOT-MAN',
    adhesive: '氰基丙烯酸酯',
    concentration: 100,
    initialQty: 10,
    qty: 5,
    unit: 'ml',
    preparedAt: now,
    potLifeMin: 60,
    owner: '丁',
    status: 'active',
    rev: 0,
    issues: [],
  });
  await db.procedures.put({
    id: manualProc,
    specimenId,
    stepType: '粘接',
    nodeName: '人工封档节点',
    seq: 4,
    tools: [],
    abrasive: '',
    adhesive: '氰基丙烯酸酯',
    glueBatchId: manualId,
    glueLotNo: 'LOT-MAN',
    adhesiveConc: 100,
    durationMin: 5,
    tempC: 20,
    rh: 50,
    photoBeforeIds: [],
    photoAfterIds: [],
    operator: '丁',
    startedAt: now,
    state: 'done',
    finishedAt: now,
  } as PrepProcedure);
  const invalidatedList = await sealBatch(manualId);
  assert(invalidatedList.length === 1, `人工封档失效 1 个节点，实际 ${invalidatedList.length}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
