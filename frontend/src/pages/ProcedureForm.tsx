import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useGlueStore } from '../stores/glueStore';
import { usePrepProgress } from '../hooks/usePrepProgress';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { GlueActionDialog } from '../components/common/GlueActionDialog';
import { MeasureField } from '../components/common/MeasureField';
import { STEP_FIELD_MAP, STEP_TYPES, stepNeedsGlue, type PrepProcedure, type StepType } from '../types/procedure';
import {
  formatPotLifeLeft,
  isGlueUsable,
  type GlueBatch,
} from '../types/glue';
import { createGluedProcedure, reconfirmProcedureGlue, supplementProcedureGlue } from '../utils/glueService';
import { broadcastGlueChanged } from '../stores/glueStore';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';

/** /procedures/new 新建工序节点：选类型动态出字段，用胶工序绑定胶液批次并领用扣减 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const addProcedure = useProcedureStore((s) => s.add);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);
  const loadProcedures = useProcedureStore((s) => s.load);
  const glueBatches = useGlueStore((s) => s.items);
  const loadGlue = useGlueStore((s) => s.load);
  const loadSpecimens = useSpecimenStore((s) => s.load);

  const [specimenId, setSpecimenId] = useState(params.get('specimenId') ?? specimens[0]?.id ?? '');
  const [stepType, setStepType] = useState<StepType>('清修');
  const [nodeName, setNodeName] = useState('');
  const [seq, setSeq] = useState(1);
  const [tools, setTools] = useState<string[]>([]);
  const [abrasive, setAbrasive] = useState('');
  const [adhesive, setAdhesive] = useState('');
  const [durationMin, setDurationMin] = useState(60);
  const [tempC, setTempC] = useState(22);
  const [rh, setRh] = useState(50);
  const [operator, setOperator] = useState('');
  const [withPhotos, setWithPhotos] = useState(true);
  // 胶液绑定草稿：批次、领用量
  const [glueBatchId, setGlueBatchId] = useState('');
  const [glueQty, setGlueQty] = useState(5);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [glueDialog, setGlueDialog] = useState<{ mode: 'reconfirm' | 'supplement'; procedure: PrepProcedure } | null>(null);

  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const needsGlue = stepNeedsGlue(stepType);
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  // 仅展示与所选胶种一致且当前可用的批次；批次浓度、批号随工序留痕
  const glueCandidates = useMemo(
    () => glueBatches.filter((b) => b.adhesive === adhesive && isGlueUsable(b)),
    [glueBatches, adhesive],
  );
  const selectedGlue: GlueBatch | undefined = glueBatches.find((b) => b.id === glueBatchId);

  // 跨表写入后统一重载，保证另一个标签页的扣减/失效在本页可见
  const reloadAll = async () => {
    await Promise.all([loadGlue(), loadProcedures(), loadSpecimens()]);
  };

  const resetForm = (newNextSeq: number) => {
    setNodeName('');
    setTools([]);
    setSeq(newNextSeq);
    setGlueBatchId('');
    setGlueQty(5);
    setError('');
  };

  const submit = async () => {
    if (!specimenId) {
      setError('请先选择标本');
      return;
    }
    if (!nodeName.trim()) {
      setError('节点名称必填');
      return;
    }
    if (!operator.trim()) {
      setError('责任人必填');
      return;
    }
    const used = progress.list.map((it) => it.seq);
    if (used.includes(seq)) {
      setError(`序号 ${seq} 已被占用，请改用 ${nextSeq}`);
      return;
    }
    if (seq > nextSeq) {
      setError(`序号跳号：当前最大序号为 ${Math.max(0, nextSeq - 1)}，新节点必须用 ${nextSeq}`);
      return;
    }

    const baseDraft = {
      specimenId,
      stepType,
      nodeName: nodeName.trim(),
      seq,
      tools,
      abrasive,
      durationMin,
      tempC,
      rh,
      photoBeforeIds: [] as string[],
      photoAfterIds: [] as string[],
      operator: operator.trim(),
      startedAt: Date.now(),
      state: 'pending' as const,
    };

    if (needsGlue) {
      if (!adhesive) {
        setError('该工序必须选择胶种');
        return;
      }
      if (!glueBatchId) {
        setError('该工序必须选择有效胶液批次（含批号、适用期）；无可用批次时请先到「胶液批次」配液');
        return;
      }
      if (!(glueQty > 0)) {
        setError('胶液领用数量必须大于 0');
        return;
      }
      // 原子事务：校验适用期/余量 + 扣减 + 写工序；跨标签页竞争时只成功一人
      const result = await createGluedProcedure(
        {
          ...baseDraft,
          adhesive: '',
          adhesiveConc: 0,
          glue: null,
        },
        {
          batchId: glueBatchId,
          qty: glueQty,
          operator: operator.trim(),
          specimenNo: specimen?.specimenNo ?? '未关联标本',
        },
      );
      // 失败：错误回显，表单草稿（含批号/数量）原样保留
      if (!result.ok || !result.procedure) {
        setError(result.message);
        await reloadAll();
        return;
      }
      if (withPhotos && specimen && result.procedure) {
        const before: PrepPhoto = {
          id: newId('pho'),
          specimenId,
          procedureId: result.procedure.id,
          stage: 'before',
          caption: `${nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
          dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
          capturedAt: Date.now(),
        };
        const after: PrepPhoto = {
          id: newId('pho'),
          specimenId,
          procedureId: result.procedure.id,
          stage: 'after',
          caption: `${nodeName.trim()} · 修复后（${specimen.specimenNo}）`,
          dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
          capturedAt: Date.now() + 1,
        };
        await db.photos.bulkPut([before, after]);
      }
      await reloadAll();
      broadcastGlueChanged();
      setError('');
      setToast(`已保存 #${seq} ${stepType}，已从批号 ${result.procedure.glue?.lotNo} 领用 ${glueQty}`);
      resetForm(nextSeq + 1);
      return;
    }

    // 不用胶工序：直接写入
    const record = await addProcedure({
      ...baseDraft,
      adhesive: '',
      adhesiveConc: 0,
      glue: null,
    });

    if (withPhotos && specimen) {
      const before: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: record.id,
        stage: 'before',
        caption: `${nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
        capturedAt: Date.now(),
      };
      const after: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: record.id,
        stage: 'after',
        caption: `${nodeName.trim()} · 修复后（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
        capturedAt: Date.now() + 1,
      };
      await db.photos.bulkPut([before, after]);
    }

    setError('');
    setToast(`已追加工序节点 #${seq} ${stepType} · ${record.nodeName}`);
    resetForm(nextSeq + 1);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          新建工序节点
        </Typography>
        <Chip size="small" variant="outlined" label={`建议序号 ${nextSeq}`} />
        <Chip size="small" variant="outlined" label={`现有节点 ${progress.total} 个`} />
        {progress.pendingSupplement > 0 ? (
          <Chip size="small" color="warning" label={`待补配液 ${progress.pendingSupplement}`} />
        ) : null}
        {progress.glueInvalid > 0 ? (
          <Chip size="small" color="error" label={`胶液失效 ${progress.glueInvalid}`} />
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button onClick={() => navigate('/glue')}>去配液</Button>
        <Button onClick={() => navigate(`/specimens/${specimenId}`)} disabled={!specimenId}>
          查看标本详情
        </Button>
      </Stack>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 420px' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack spacing={1.5}>
            {error ? <Alert severity="error" data-testid="procedure-error">{error}</Alert> : null}
            <TextField
              select
              size="small"
              label="标本"
              value={specimenId}
              onChange={(e) => {
                setSpecimenId(e.target.value);
                setSeq(1);
              }}
            >
              {specimens.map((it) => (
                <MenuItem key={it.id} value={it.id}>
                  {it.specimenNo} · {it.taxon}
                </MenuItem>
              ))}
            </TextField>

            <Stack direction="row" spacing={1.5}>
              <TextField
                select
                size="small"
                fullWidth
                label="工序类型"
                value={stepType}
                onChange={(e) => {
                  const next = e.target.value as StepType;
                  setStepType(next);
                  setTools([]);
                  setAbrasive('');
                  setAdhesive('');
                  setGlueBatchId('');
                }}
              >
                {STEP_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                size="small"
                fullWidth
                label="节点名称"
                required
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
              />
              <Box sx={{ width: 120 }}>
                <MeasureField
                  label="序号"
                  unit="seq"
                  min={1}
                  max={999}
                  step={1}
                  value={seq}
                  onChange={setSeq}
                  hint={`不得跳号，建议 ${nextSeq}`}
                />
              </Box>
            </Stack>

            {fieldMap.tools.length > 0 ? (
              <TextField
                select
                size="small"
                label="使用工具"
                SelectProps={{ multiple: true }}
                value={tools}
                onChange={(e) => {
                  const v = e.target.value;
                  setTools(typeof v === 'string' ? v.split(',') : v);
                }}
                helperText="气动笔 / 剔针 / 超声波 等，可多选"
              >
                {fieldMap.tools.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Alert severity="info">该工序类型无需工具清单</Alert>
            )}

            {fieldMap.abrasives.length > 0 ? (
              <TextField
                select
                size="small"
                label="磨料目数"
                value={abrasive}
                onChange={(e) => setAbrasive(e.target.value)}
              >
                <MenuItem value="">不适用</MenuItem>
                {fieldMap.abrasives.map((a) => (
                  <MenuItem key={a} value={a}>
                    {a}
                  </MenuItem>
                ))}
              </TextField>
            ) : null}

            {fieldMap.adhesives.length > 0 ? (
              <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'primary.light', bgcolor: '#f6f3ef' }}>
                <Stack spacing={1.5}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Chip size="small" color="primary" label="用胶工序" />
                    <Typography variant="caption" color="text.secondary">
                      须选用「适用期内且有余量」的胶液批次，保存即扣减余量；批次到期或余量耗尽，节点自动失效。
                    </Typography>
                  </Stack>
                  <Stack direction="row" spacing={1.5}>
                    <TextField
                      select
                      size="small"
                      fullWidth
                      label="胶种"
                      value={adhesive}
                      onChange={(e) => {
                        setAdhesive(e.target.value);
                        setGlueBatchId('');
                      }}
                    >
                      <MenuItem value="">未选定</MenuItem>
                      {fieldMap.adhesives.map((a) => (
                        <MenuItem key={a} value={a}>
                          {a}
                        </MenuItem>
                      ))}
                    </TextField>
                    <TextField
                      select
                      size="small"
                      fullWidth
                      label="胶液批号（适用期 / 余量）"
                      value={glueBatchId}
                      onChange={(e) => setGlueBatchId(e.target.value)}
                      disabled={!adhesive}
                    >
                      {adhesive && glueCandidates.length === 0 ? (
                        <MenuItem value="">无可用批次，请先配液</MenuItem>
                      ) : null}
                      {glueCandidates.map((b) => (
                        <MenuItem key={b.id} value={b.id}>
                          {b.lotNo} · 余 {b.qty} {b.unit} · {b.concPct}% · {formatPotLifeLeft(b)}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Box sx={{ width: 150 }}>
                      <MeasureField
                        label="领用数量"
                        unit={selectedGlue?.unit ?? 'mL'}
                        min={0.1}
                        max={selectedGlue?.qty ?? 0}
                        step={1}
                        value={glueQty}
                        onChange={setGlueQty}
                      />
                    </Box>
                  </Stack>
                  {selectedGlue ? (
                    <Alert severity="success">
                      浓度随批次锁定为 {selectedGlue.concPct}% · 配液责任人 {selectedGlue.operator} ·{' '}
                      {formatPotLifeLeft(selectedGlue)} · 适用期截止后节点立即失效
                    </Alert>
                  ) : adhesive ? (
                    <Alert severity="warning" action={
                      <Button color="inherit" size="small" onClick={() => navigate('/glue')}>
                        去配液
                      </Button>
                    }>
                      「{adhesive}」当前没有适用期内且有余量的批次。
                    </Alert>
                  ) : null}
                </Stack>
              </Paper>
            ) : null}

            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="耗时"
                  unit="min"
                  min={1}
                  max={1440}
                  step={1}
                  value={durationMin}
                  onChange={setDurationMin}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="环境温度" unit="℃" min={-10} max={60} step={0.5} value={tempC} onChange={setTempC} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField label="相对湿度" unit="%" min={0} max={100} step={1} value={rh} onChange={setRh} />
              </Box>
            </Stack>

            <TextField
              size="small"
              label="责任人"
              required
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            />

            <FormControlLabel
              control={<Checkbox checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} />}
              label="同时挂接修复前 / 修复后留痕影像（本地生成）"
            />

            <Stack direction="row" spacing={1}>
              <Button variant="contained" onClick={submit} data-testid="procedure-submit">
                保存节点{needsGlue ? '并领用胶液' : ''}
              </Button>
              <Button onClick={() => navigate('/procedures/new')}>清空重填</Button>
            </Stack>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={700} gutterBottom>
            该标本现有工序
          </Typography>
          {specimen ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {specimen.specimenNo} · 完成度 {progress.percent}% · 待办{' '}
              {progress.current ? `#${progress.current.seq} ${progress.current.nodeName}` : '无'}
            </Typography>
          ) : null}
          <ProcedureTimeline
            items={progress.list}
            onFinish={async (pid) => {
              const r = await finish(pid);
              setToast(r.message);
            }}
            onRollback={async (pid) => {
              await rollback(pid);
              setToast('节点已回退');
            }}
            onReconfirmGlue={(p) => setGlueDialog({ mode: 'reconfirm', procedure: p })}
            onSupplementGlue={(p) => setGlueDialog({ mode: 'supplement', procedure: p })}
          />
        </Paper>
      </Box>

      <GlueActionDialog
        mode={glueDialog?.mode ?? 'reconfirm'}
        procedure={glueDialog?.procedure ?? null}
        batches={glueBatches}
        onClose={() => setGlueDialog(null)}
        onSubmit={async (payload) => {
          if (!glueDialog?.procedure) return { ok: false, message: '工序不存在' };
          if (glueDialog.mode === 'reconfirm') {
            const result = await reconfirmProcedureGlue(glueDialog.procedure.id, {
              batchId: payload.batchId,
              qty: payload.qty,
              operator: payload.operator,
              specimenNo: specimen?.specimenNo ?? '未关联标本',
            });
            if (result.ok) {
              await reloadAll();
              broadcastGlueChanged();
            } else {
              await reloadAll();
            }
            return result;
          }
          const result = await supplementProcedureGlue(glueDialog.procedure.id, payload);
          if (result.ok) {
            await reloadAll();
            broadcastGlueChanged();
          }
          return result;
        }}
        onDone={(msg) => setToast(msg)}
      />

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
