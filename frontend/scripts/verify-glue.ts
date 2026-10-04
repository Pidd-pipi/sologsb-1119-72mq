import 'fake-indexeddb/auto';
import { db, ensureSeedData } from '../src/utils/db';
import { useGlueStore } from '../src/stores/glueStore';
import {
  enforceGlueValidity,
  issueGlue,
  createGluedProcedure,
  reconfirmProcedureGlue,
  supplementProcedureGlue,
} from '../src/utils/glueService';

let passed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) {
    console.error('FAIL:', name, extra ?? '');
    process.exit(1);
  }
  passed += 1;
  console.log('PASS:', name);
}

async function main() {
  await ensureSeedData();

  const specimens = await db.specimens.toArray();
  const procedures = await db.procedures.toArray();
  const glue = await db.glueBatches.toArray();

  check('3 件示范标本', specimens.length === 3, specimens.map((s) => s.status));
  const withdrawn = specimens.find((s) => s.specimenNo === 'FP-2024-0077')!;
  check('0077 已撤下', withdrawn.status === '已撤下', withdrawn.status);
  check('撤下原因含批号', (withdrawn.withdrawReason ?? '').includes('PB72-260927-05'));

  const expired = glue.find((b) => b.lotNo === 'PB72-260927-05')!;
  check('过期批次已失效', expired.state === 'invalid' && expired.invalidReason === 'potlife');
  const bond = procedures.find((p) => p.id === expired.issues[0].procedureId)!;
  check('过期批次绑定工序胶液失效', bond.glue?.glueState === 'invalid', bond.glue);

  // 旧工序（0031 加固，pending）待补
  const oldProc = procedures.find((p) => p.specimenId === specimens.find((s) => s.specimenNo === 'FP-2024-0031')!.id && p.stepType === '加固')!;
  check('旧用胶工序待补', oldProc.glue?.glueState === 'pending_supplement', oldProc.glue);

  const clean = procedures.find((p) => p.stepType === '清修')!;
  check('清修工序无胶绑定', clean.glue === null);

  const now = Date.now();

  // ---- 1. 过期批次禁止领用 ----
  const r1 = await issueGlue(expired.id, { qty: 1, operator: '甲', specimenNo: 'T1' }, now);
  check('过期批次领用被拒', !r1.ok && r1.code === 'potlife', r1);

  // ---- 2. 超量领用被拒 ----
  const fresh = glue.find((b) => b.lotNo === 'PB72-261003-02')!;
  const r2 = await issueGlue(fresh.id, { qty: fresh.qty + 999, operator: '甲', specimenNo: 'T1' }, now);
  check('超量领用被拒', !r2.ok && r2.code === 'depleted', r2);
  const freshAfter = await db.glueBatches.get(fresh.id);
  check('被拒后余量不变', freshAfter!.qty === fresh.qty);

  // ---- 3. 并发领用：同一批次仅一笔成功 ----
  const ca = glue.find((b) => b.lotNo === 'CA-261003-01')!;
  const [a, b] = await Promise.all([
    issueGlue(ca.id, { qty: 15, operator: '甲', specimenNo: 'T1' }, now),
    issueGlue(ca.id, { qty: 15, operator: '乙', specimenNo: 'T2' }, now + 1),
  ]);
  check('并发领用仅一人成功', [a.ok, b.ok].filter(Boolean).length === 1, { a, b });
  const caAfter = await db.glueBatches.get(ca.id);
  check('成功方扣减余量', caAfter!.qty === 5, caAfter!.qty);
  check('扣完未失效（有余量）', caAfter!.state === 'usable');

  // ---- 4. 扣完自动失效 + 级联 ----
  // 造一个在用批次，绑定到一个未完成工序（0058），再全部领完
  const spm58 = specimens.find((s) => s.specimenNo === 'FP-2024-0058')!;
  const smallBatch = {
    id: 'glu_test_small',
    lotNo: 'TEST-SMALL-01',
    adhesive: 'Paraloid B-72',
    concPct: 5,
    mixedAt: now - 10 * 60000,
    initialQty: 3,
    qty: 3,
    unit: 'mL',
    potLifeMin: 480,
    operator: '甲',
    state: 'usable' as const,
    issues: [],
    createdAt: now - 10 * 60000,
  };
  await db.glueBatches.put(smallBatch);
  const procDraft = {
    specimenId: spm58.id,
    stepType: '加固' as const,
    nodeName: '测试加固',
    seq: 1,
    tools: ['渗透滴管'],
    abrasive: '',
    adhesive: '',
    adhesiveConc: 0,
    durationMin: 30,
    tempC: 22,
    rh: 50,
    photoBeforeIds: [],
    photoAfterIds: [],
    operator: '甲',
    startedAt: now,
    state: 'pending' as const,
    glue: null,
  };
  const created = await createGluedProcedure(procDraft, {
    batchId: smallBatch.id,
    qty: 3,
    operator: '甲',
    specimenNo: spm58.specimenNo,
  });
  check('工序保存并领用成功', created.ok && !!created.procedure, created);
  const smallAfter = await db.glueBatches.get(smallBatch.id);
  check('余量扣完自动失效', smallAfter!.state === 'invalid' && smallAfter!.invalidReason === 'depleted');
  const createdProc = await db.procedures.get(created.procedure!.id);
  check('同事务内后续节点不被级联（自身为最新绑定）', createdProc!.glue?.glueState === 'confirmed', createdProc!.glue);

  // 另建一个已绑定同批次的未完成工序（模拟另一件标本），再触发失效 → 应级联
  const smallBatch2 = {
    ...smallBatch,
    id: 'glu_test_small2',
    lotNo: 'TEST-SMALL-02',
    qty: 5,
    initialQty: 5,
    state: 'usable' as const,
  };
  await db.glueBatches.put(smallBatch2);
  const c2 = await createGluedProcedure(
    { ...procDraft, nodeName: '测试加固2', specimenId: spm58.id, seq: 2 },
    { batchId: smallBatch2.id, qty: 3, operator: '甲', specimenNo: spm58.specimenNo },
  );
  check('第二工序创建成功', c2.ok);
  // 再直接领完余量 → 级联：该工序回到 pending + invalid
  const drain = await issueGlue(smallBatch2.id, { qty: 2, operator: '甲', specimenNo: 'T' }, now);
  check('领余量成功', drain.ok, drain);
  const p2 = await db.procedures.get(c2.procedure!.id);
  check('级联：未完成工序胶液失效', p2!.glue?.glueState === 'invalid' && p2!.state === 'pending', p2);

  // ---- 5. 已交付标本因胶液过期撤下 ----
  // 用一件干净标本：新批次 + 已完成工序 + 标本设已交付，然后把适用期改短后跑巡检
  const cleanDelivered = {
    id: 'spm_test_delivered',
    specimenNo: 'FP-TEST-0099',
    taxon: '测试种',
    horizon: '测试层',
    locality: '测试产地',
    lithology: '测试岩性',
    matrixHardness: 3,
    dimensions: '100×100×100',
    weight: 1000,
    storageBox: 'Z 区',
    status: '待交付' as const,
    createdAt: now,
  };
  await db.specimens.put(cleanDelivered);
  const deliveredId = cleanDelivered.id;
  const expBatch = {
    id: 'glu_test_exp',
    lotNo: 'TEST-EXP-01',
    adhesive: '氰基丙烯酸酯',
    concPct: 100,
    mixedAt: now - 200 * 60000,
    initialQty: 10,
    qty: 8,
    unit: 'mL',
    potLifeMin: 100, // 已过 100 分钟
    operator: '甲',
    state: 'usable' as const,
    issues: [],
    createdAt: now - 200 * 60000,
  };
  await db.glueBatches.put(expBatch);
  // 直接构造一条已完成、confirmed 的工序
  await db.procedures.put({
    id: 'prc_delivered_bond',
    specimenId: deliveredId,
    stepType: '粘接',
    nodeName: '交付前粘接',
    seq: 99,
    tools: [],
    abrasive: '',
    adhesive: '氰基丙烯酸酯',
    adhesiveConc: 100,
    durationMin: 20,
    tempC: 22,
    rh: 40,
    photoBeforeIds: [],
    photoAfterIds: [],
    operator: '甲',
    startedAt: now - 150 * 60000,
    state: 'done',
    finishedAt: now - 140 * 60000,
    glue: {
      batchId: expBatch.id,
      lotNo: expBatch.lotNo,
      issueQty: 2,
      boundAt: now - 150 * 60000,
      boundOperator: '甲',
      glueState: 'confirmed',
    },
  });
  await db.specimens.update(deliveredId, { status: '已交付' });
  const changed = await enforceGlueValidity(now);
  check('巡检发现失效并变更', changed === true);
  const deliveredAfter = await db.specimens.get(deliveredId);
  check('已交付标本被撤下', deliveredAfter!.status === '已撤下', deliveredAfter!.status);
  check('撤下原因记录批号', (deliveredAfter!.withdrawReason ?? '').includes('TEST-EXP-01'));
  const bondAfter = await db.procedures.get('prc_delivered_bond');
  check('已完成工序胶液标记失效', bondAfter!.glue?.glueState === 'invalid');

  // ---- 6. 重新确认：新批次领用 + 标本回待交付 ----
  const newBatch = {
    id: 'glu_test_new',
    lotNo: 'TEST-NEW-01',
    adhesive: '氰基丙烯酸酯',
    concPct: 100,
    mixedAt: now,
    initialQty: 20,
    qty: 20,
    unit: 'mL',
    potLifeMin: 120,
    operator: '乙',
    state: 'usable' as const,
    issues: [],
    createdAt: now,
  };
  await db.glueBatches.put(newBatch);
  const rc = await reconfirmProcedureGlue('prc_delivered_bond', {
    batchId: newBatch.id,
    qty: 2,
    operator: '乙',
    specimenNo: deliveredAfter!.specimenNo,
  });
  check('重新确认成功', rc.ok, rc);
  const bondRc = await db.procedures.get('prc_delivered_bond');
  check('绑定换成新批号', bondRc!.glue?.lotNo === 'TEST-NEW-01' && bondRc!.glue?.glueState === 'confirmed');
  const spmRc = await db.specimens.get(deliveredId);
  check('唯一失效项确认后标本回待交付', spmRc!.status === '待交付', spmRc!.status);
  const newAfter = await db.glueBatches.get(newBatch.id);
  check('重新确认扣减余量', newAfter!.qty === 18);

  // ---- 7. 待补旧工序补登：不扣余量、回待办 ----
  const supBatch = {
    id: 'glu_test_sup',
    lotNo: 'TEST-SUP-01',
    adhesive: 'Paraloid B-72',
    concPct: 5,
    mixedAt: now - 60 * 60000,
    initialQty: 30,
    qty: 30,
    unit: 'mL',
    potLifeMin: 480,
    operator: '丙',
    state: 'usable' as const,
    issues: [],
    createdAt: now - 60 * 60000,
  };
  await db.glueBatches.put(supBatch);
  const sp = await supplementProcedureGlue(oldProc.id, { batchId: supBatch.id, operator: '丙' });
  check('补登成功', sp.ok, sp);
  const oldAfter = await db.procedures.get(oldProc.id);
  check('补登后状态确认', oldAfter!.glue?.glueState === 'confirmed' && oldAfter!.state === 'pending', oldAfter);
  const supAfter = await db.glueBatches.get(supBatch.id);
  check('补登不扣余量', supAfter!.qty === 30);

  // ---- 8. finish 拦截：待补节点不能完成 ----
  const { useProcedureStore } = await import('../src/stores/procedureStore');
  await useProcedureStore.getState().load();
  // 造一个新的待补节点
  await db.procedures.put({
    ...oldAfter!,
    id: 'prc_pending_test',
    glue: { glueState: 'pending_supplement' as const, glueNote: 'x' },
    state: 'pending',
    finishedAt: undefined,
  });
  const fr = await useProcedureStore.getState().finish('prc_pending_test');
  check('待补节点完成被拒', !fr.ok, fr);
  const fr2 = await useProcedureStore.getState().finish(p2!.id);
  check('失效节点完成被拒', !fr2.ok, fr2);
  const ir = await useProcedureStore.getState().finish(bondRc!.id);
  check('已确认节点完成成功', ir.ok, ir);

  // ---- 9. store.issue 载入与广播方法存在 ----
  await useGlueStore.getState().load();
  check('胶液 store 载入批次', useGlueStore.getState().items.length >= 5);

  console.log(`\n全部 ${passed} 项断言通过`);
  await db.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
