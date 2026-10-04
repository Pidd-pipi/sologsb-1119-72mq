import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { DB_NAME } from '../src/utils/db';

function check(name: string, cond: boolean, extra?: unknown) {
  if (!cond) {
    console.error('FAIL:', name, extra ?? '');
    process.exit(1);
  }
  console.log('PASS:', name);
}

async function main() {
  // 1) 用旧应用（v2）的形态建库并灌入老数据：用胶工序无 glue 字段、一条已完成
  const old = new Dexie(DB_NAME);
  old.version(2).stores({
    specimens: 'id, specimenNo, taxon, locality, status, createdAt',
    procedures: 'id, specimenId, seq, stepType, state, startedAt',
    supplies: 'id, kind, lotNo, name, openedAt',
    photos: 'id, specimenId, procedureId, stage, capturedAt',
  });
  await old.table('specimens').put({ id: 's1', specimenNo: 'OLD-1', status: '已交付', createdAt: 1 });
  await old.table('procedures').bulkPut([
    { id: 'p-glue-done', specimenId: 's1', stepType: '加固', nodeName: '老加固', seq: 1, state: 'done', finishedAt: 123, adhesive: 'Paraloid B-72', adhesiveConc: 5, tools: [], photoBeforeIds: [], photoAfterIds: [], operator: '甲', startedAt: 100 },
    { id: 'p-glue-pending', specimenId: 's1', stepType: '粘接', nodeName: '老粘接', seq: 2, state: 'pending', adhesive: '动物胶', adhesiveConc: 0, tools: [], photoBeforeIds: [], photoAfterIds: [], operator: '甲', startedAt: 200 },
    { id: 'p-clean', specimenId: 's1', stepType: '清修', nodeName: '老清修', seq: 3, state: 'done', finishedAt: 300, adhesive: '', tools: ['剔针'], photoBeforeIds: [], photoAfterIds: [], operator: '甲', startedAt: 250 },
  ]);
  await old.close();

  // 2) 用新代码打开（db.ts 中的 v1→v2→v3 注册触发真实升级）
  const { db } = await import('../src/utils/db');
  const procs = await db.procedures.toArray();

  const doneGlue = procs.find((p) => p.id === 'p-glue-done')!;
  const pendingGlue = procs.find((p) => p.id === 'p-glue-pending')!;
  const clean = procs.find((p) => p.id === 'p-clean')!;

  check('已完成老用胶工序回到待办', doneGlue.state === 'pending' && doneGlue.finishedAt === undefined, doneGlue);
  check('已完成老用胶工序标待补', doneGlue.glue?.glueState === 'pending_supplement');
  check('待办老用胶工序仍待办且待补', pendingGlue.state === 'pending' && pendingGlue.glue?.glueState === 'pending_supplement');
  check('非用胶工序 glue=null', clean.glue === null);
  check('非用胶工序完成结论保留', clean.state === 'done');
  check('glueBatches 表在 v3 可用', db.tables.some((t) => t.name === 'glueBatches'));

  await db.close();
  console.log('\n迁移断言全部通过（真实 db.ts 升级路径）');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
