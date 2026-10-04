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
import { MeasureField } from '../components/common/MeasureField';
import { STEP_FIELD_MAP, STEP_TYPES, type StepType } from '../types/procedure';
import { isGlueUsable, potLifeLeftMin } from '../types/glue';
import { GlueIssueError } from '../utils/glueService';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { makeSketchDataUrl, type PrepPhoto } from '../types/photo';

/** /procedures/new 新建工序节点：选类型动态出字段，序号跳号报错 */
export default function ProcedureForm() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const specimens = useSpecimenStore((s) => s.items);
  const addProcedure = useProcedureStore((s) => s.add);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);
  const issueGlue = useGlueStore((s) => s.issue);
  const glueBatches = useGlueStore((s) => s.items);

  const [specimenId, setSpecimenId] = useState(params.get('specimenId') ?? specimens[0]?.id ?? '');
  const [stepType, setStepType] = useState<StepType>('清修');
  const [nodeName, setNodeName] = useState('');
  const [seq, setSeq] = useState(1);
  const [tools, setTools] = useState<string[]>([]);
  const [abrasive, setAbrasive] = useState('');
  const [adhesive, setAdhesive] = useState('');
  const [glueBatchId, setGlueBatchId] = useState('');
  const [glueQty, setGlueQty] = useState(5);
  const [adhesiveConc, setAdhesiveConc] = useState(5);
  const [durationMin, setDurationMin] = useState(60);
  const [tempC, setTempC] = useState(22);
  const [rh, setRh] = useState(50);
  const [operator, setOperator] = useState('');
  const [withPhotos, setWithPhotos] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const progress = usePrepProgress(specimenId || undefined);
  const fieldMap = STEP_FIELD_MAP[stepType];
  const nextSeq = progress.list.length === 0 ? 1 : Math.max(...progress.list.map((it) => it.seq)) + 1;

  const specimen = useMemo(() => specimens.find((it) => it.id === specimenId), [specimens, specimenId]);

  /** 选定胶种后，只允许选择同胶种、未过适用期、有余量的在调批次 */
  const glueCandidates = useMemo(
    () => glueBatches.filter((b) => b.adhesive === adhesive && isGlueUsable(b)),
    [glueBatches, adhesive],
  );
  const selectedGlue = glueBatches.find((b) => b.id === glueBatchId);
  const gluePotLeft = selectedGlue && selectedGlue.status === 'active' ? potLifeLeftMin(selectedGlue) : undefined;

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
    if (!Number.isFinite(adhesiveConc) || adhesiveConc < 0 || adhesiveConc > 100) {
      setError('胶液浓度需在 0 ~ 100 % 之间');
      return;
    }
    const usesGlue = fieldMap.adhesives.length > 0 && !!adhesive;
    let glueSnapshot: { id: string; lotNo: string } | null = null;
    if (usesGlue) {
      if (!glueBatchId) {
        setError('该工序使用胶液，必须选择对应的在调胶液批次（登记批号 / 适用期 / 责任人）');
        return;
      }
      const batch = glueBatches.find((b) => b.id === glueBatchId);
      if (!batch || !isGlueUsable(batch)) {
        setError('所选胶液批次已封档或过适用期，请改选');
        return;
      }
      if (!(glueQty > 0)) {
        setError('胶液领用量必须大于 0');
        return;
      }
      if (glueQty > batch.qty) {
        setError(`胶液余量不足：当前仅剩 ${batch.qty} ml`);
        return;
      }
      glueSnapshot = { id: batch.id, lotNo: batch.lotNo };
    }

    setSubmitting(true);
    setError('');

    // 先扣胶液余量：跨标签页乐观锁失败时直接返回，表单作为草稿原样保留
    let glueIssueId: string | undefined;
    if (usesGlue && glueSnapshot) {
      try {
        const result = await issueGlue(glueSnapshot.id, {
          qty: glueQty,
          operator: operator.trim(),
          specimenNo: specimen?.specimenNo ?? '未关联标本',
          expectedRev: glueBatches.find((b) => b.id === glueSnapshot!.id)?.rev ?? 0,
        });
        glueIssueId = result.issue.id;
        glueSnapshot = { id: result.batch.id, lotNo: result.batch.lotNo };
      } catch (e) {
        setSubmitting(false);
        setError(
          e instanceof GlueIssueError
            ? `胶液领用失败：${e.message}`
            : '胶液领用写入失败，表单内容已保留，请重试',
        );
        return;
      }
    }

    let recordId = '';
    try {
      const record = await addProcedure({
        specimenId,
        stepType,
        nodeName: nodeName.trim(),
        seq,
        tools,
        abrasive,
        adhesive: usesGlue ? adhesive : '',
        adhesiveConc: fieldMap.needConc ? adhesiveConc : 0,
        glueBatchId: glueSnapshot?.id,
        glueLotNo: glueSnapshot?.lotNo,
        glueQty: glueSnapshot ? glueQty : undefined,
        durationMin,
        tempC,
        rh,
        photoBeforeIds: [],
        photoAfterIds: [],
        operator: operator.trim(),
        startedAt: Date.now(),
        state: 'pending',
      });
      recordId = record.id;
    } catch (e) {
      // 工序写入失败：回滚已扣的领用（流水标注撤回），保留整张表单草稿
      if (glueIssueId && glueSnapshot) {
        const batch = await db.glueBatches.get(glueSnapshot.id);
        if (batch) {
          await db.glueBatches.put({
            ...batch,
            qty: Number((batch.qty + glueQty).toFixed(3)),
            rev: batch.rev + 1,
            issues: batch.issues.map((i) =>
              i.id === glueIssueId ? { ...i, specimenNo: `${i.specimenNo}（写入失败已退回）` } : i,
            ),
          });
        }
      }
      setSubmitting(false);
      setError('工序写入失败，胶液余量已恢复，表单内容已保留，请重试');
      return;
    }

    if (withPhotos && specimen) {
      const before: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: recordId,
        stage: 'before',
        caption: `${nodeName.trim()} · 修复前（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复前 · ${specimen.specimenNo}`, '#6b5844'),
        capturedAt: Date.now(),
      };
      const after: PrepPhoto = {
        id: newId('pho'),
        specimenId,
        procedureId: recordId,
        stage: 'after',
        caption: `${nodeName.trim()} · 修复后（${specimen.specimenNo}）`,
        dataUrl: makeSketchDataUrl(`修复后 · ${specimen.specimenNo}`, '#3f5a4a'),
        capturedAt: Date.now() + 1,
      };
      await db.photos.bulkPut([before, after]);
    }

    setError('');
    setToast(`已追加工序节点 #${seq} ${stepType} · ${nodeName.trim()}`);
    setNodeName('');
    setTools([]);
    setGlueBatchId('');
    setSeq(nextSeq + 1);
    setSubmitting(false);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h5" fontWeight={700}>
          新建工序节点
        </Typography>
        <Chip size="small" variant="outlined" label={`建议序号 ${nextSeq}`} />
        <Chip size="small" variant="outlined" label={`现有节点 ${progress.total} 个`} />
        <Box sx={{ flex: 1 }} />
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
              <Stack spacing={1.5}>
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
                  {fieldMap.needConc ? (
                    <Box sx={{ flex: 1 }}>
                      <MeasureField
                        label="胶液浓度"
                        unit="%"
                        min={0}
                        max={100}
                        step={0.5}
                        value={adhesiveConc}
                        onChange={setAdhesiveConc}
                      />
                    </Box>
                  ) : null}
                </Stack>
                {adhesive ? (
                  <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'grey.50' }}>
                    <Stack spacing={1.5}>
                      <Stack direction="row" spacing={1.5}>
                        <TextField
                          select
                          size="small"
                          fullWidth
                          required
                          label="所用胶液批次（在调）"
                          value={glueBatchId}
                          onChange={(e) => setGlueBatchId(e.target.value)}
                          helperText={
                            glueCandidates.length === 0
                              ? '没有同胶种的可调批次（未过适用期且有余量），请先到「材料台账 · 胶液配制」配液'
                              : '只能选未到适用期、余量充足的批次；选过期批次会被拦下'
                          }
                        >
                          {glueCandidates.map((b) => {
                            const left = potLifeLeftMin(b);
                            return (
                              <MenuItem key={b.id} value={b.id}>
                                {b.lotNo} · {b.concentration}% · 余 {b.qty} ml · 适用期剩{' '}
                                {left >= 60 ? `${Math.floor(left / 60)} h` : `${left} min`} · {b.owner}
                              </MenuItem>
                            );
                          })}
                        </TextField>
                        <Box sx={{ width: 200 }}>
                          <MeasureField
                            label="胶液领用量"
                            unit="ml"
                            min={0.1}
                            max={selectedGlue?.qty ?? 100000}
                            step={0.5}
                            value={glueQty}
                            onChange={setGlueQty}
                          />
                        </Box>
                      </Stack>
                      {selectedGlue ? (
                        <Stack direction="row" spacing={1} flexWrap="wrap">
                          <Chip size="small" label={`批号 ${selectedGlue.lotNo}`} />
                          <Chip size="small" color="info" variant="outlined" label={`余量 ${selectedGlue.qty} ml`} />
                          <Chip
                            size="small"
                            color={gluePotLeft !== undefined && gluePotLeft < 60 ? 'error' : 'default'}
                            label={gluePotLeft !== undefined ? `适用期剩 ${gluePotLeft} 分钟` : '已封档'}
                          />
                          <Chip size="small" label={`责任人 ${selectedGlue.owner}`} />
                        </Stack>
                      ) : null}
                    </Stack>
                  </Paper>
                ) : null}
              </Stack>
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
              <Button variant="contained" onClick={submit} disabled={submitting}>
                {submitting ? '写入中…' : '保存节点'}
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
            deriveState={progress.stateOf}
            glueMap={progress.glueMap}
            onFinish={async (pid) => {
              await finish(pid);
              setToast('节点已完成');
            }}
            onRollback={async (pid) => {
              await rollback(pid);
              setToast('节点已回退');
            }}
          />
        </Paper>
      </Box>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
