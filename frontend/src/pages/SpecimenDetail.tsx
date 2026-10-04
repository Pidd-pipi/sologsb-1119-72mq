import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import LinearProgress from '@mui/material/LinearProgress';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import AddIcon from '@mui/icons-material/Add';
import CompareIcon from '@mui/icons-material/Compare';
import { useSpecimenStore } from '../stores/specimenStore';
import { useProcedureStore } from '../stores/procedureStore';
import { useGlueStore } from '../stores/glueStore';
import { usePrepProgress, deliveryBlockers } from '../hooks/usePrepProgress';
import { SpecimenCard } from '../components/common/SpecimenCard';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { GlueLinkDialog } from '../components/glue/GlueLinkDialog';
import { db } from '../utils/db';
import { PHOTO_STAGE_LABEL, type PrepPhoto } from '../types/photo';
import { SPECIMEN_STATUSES, type SpecimenStatus } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import { isGlueUsable } from '../types/glue';

/** /specimens/:id 详情 + 工序时间线 + 影像 */
export default function SpecimenDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const specimen = useSpecimenStore((s) => s.items.find((it) => it.id === id));
  const setStatus = useSpecimenStore((s) => s.setStatus);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);
  const sweep = useGlueStore((s) => s.sweep);
  const progress = usePrepProgress(id);
  const [photos, setPhotos] = useState<PrepPhoto[]>([]);
  const [toast, setToast] = useState('');
  const [notice, setNotice] = useState<{ severity: 'error' | 'warning' | 'success'; text: string } | null>(null);
  const [glueDialog, setGlueDialog] = useState<{ node: PrepProcedure; mode: 'supplement' | 'reconfirm' } | null>(null);

  const loadPhotos = useCallback(async () => {
    if (!id) return;
    const rows = await db.photos.where('specimenId').equals(id).toArray();
    rows.sort((a, b) => b.capturedAt - a.capturedAt);
    setPhotos(rows);
  }, [id]);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  if (!specimen) {
    return (
      <Stack spacing={2}>
        <Alert severity="warning">未找到该标本（可能已被删除）。</Alert>
        <Button component={RouterLink} to="/specimens" variant="outlined">
          返回标本台账
        </Button>
      </Stack>
    );
  }

  const blockers = deliveryBlockers(progress);

  const changeStatus = async (next: SpecimenStatus) => {
    // 交付是强提醒节点：未完成 / 已失效 / 待补配液一律拦下，不允许只看胶种直接交付
    if (next === '已交付') {
      await sweep();
      const list = computeBlockers(id);
      if (list.length > 0) {
        setNotice({
          severity: 'error',
          text: `交付被阻断：${list.join('；')}。请处理后再交付。`,
        });
        return;
      }
    }
    await setStatus(specimen.id, next);
    if (next === '已交付') {
      // 重新交付成功：清掉历史撤回标记
      await useSpecimenStore.getState().update(specimen.id, { withdrawReason: undefined, withdrawnAt: undefined });
    }
    setNotice(null);
    setToast(`状态已更新为「${next}」`);
  };

  const handleFinish = async (pid: string) => {
    // 完成节点前先巡检并核对关联胶液：过期 / 耗尽的节点已经被置失效，不允许沿用完成
    await sweep();
    const proc = useProcedureStore.getState().items.find((p) => p.id === pid);
    if (!proc) return;
    if (proc.state === 'invalid') {
      setNotice({ severity: 'error', text: '该节点所用胶液已失效，请先重新确认。' });
      return;
    }
    if (proc.adhesive && !proc.glueBatchId) {
      setNotice({ severity: 'warning', text: '该节点缺配液批次信息，请先补录配液再完成。' });
      return;
    }
    if (proc.glueBatchId) {
      const batch = useGlueStore.getState().items.find((b) => b.id === proc.glueBatchId);
      if (!batch || !isGlueUsable(batch)) {
        setNotice({ severity: 'error', text: '关联胶液已封档或过适用期，不能标记完成。' });
        return;
      }
    }
    await finish(pid);
    setToast('节点已完成');
  };

  const beforePhotos = photos.filter((p) => p.stage === 'before');
  const afterPhotos = photos.filter((p) => p.stage === 'after');

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          标本详情 · {specimen.specimenNo}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => navigate(`/procedures/new?specimenId=${specimen.id}`)}
        >
          追加工序节点
        </Button>
        <Button
          variant="outlined"
          startIcon={<CompareIcon />}
          onClick={() => navigate(`/compare/${specimen.id}`)}
        >
          前后对照
        </Button>
      </Stack>

      {specimen.withdrawReason ? (
        <Alert
          severity="error"
          variant="filled"
          data-testid="withdrawn-banner"
          action={
            <Button color="inherit" size="small" onClick={() => navigate(`/procedures/new?specimenId=${specimen.id}`)}>
              去处理
            </Button>
          }
        >
          该标本已从「已交付」撤下：{specimen.withdrawReason}
          {specimen.withdrawnAt ? `（${new Date(specimen.withdrawnAt).toLocaleString('zh-CN', { hour12: false })}）` : ''}
        </Alert>
      ) : null}
      {notice ? <Alert severity={notice.severity} onClose={() => setNotice(null)}>{notice.text}</Alert> : null}
      {specimen.status === '待交付' && blockers.length > 0 ? (
        <Alert severity="warning" data-testid="delivery-blockers">
          交付前仍有 {blockers.length} 项未处理：{blockers.join('；')}
        </Alert>
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '380px 1fr' }, gap: 2 }}>
        <Stack spacing={1.5}>
          <SpecimenCard item={specimen} />
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="subtitle2" gutterBottom>
              修复状态
            </Typography>
            <TextField
              select
              size="small"
              fullWidth
              value={specimen.status}
              onChange={(e) => {
                void changeStatus(e.target.value as SpecimenStatus);
              }}
            >
              {SPECIMEN_STATUSES.map((s) => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              交付会校验全部胶液节点：缺配液、已失效、未完成均阻断。
            </Typography>
          </Paper>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }} flexWrap="wrap">
              <Typography variant="subtitle2">工序完成度</Typography>
              <Chip size="small" label={`有效 ${progress.effectiveDone}/${progress.total}`} />
              {progress.invalid > 0 ? <Chip size="small" color="error" label={`失效 ${progress.invalid}`} /> : null}
              {progress.needInfo > 0 ? <Chip size="small" color="warning" label={`待补 ${progress.needInfo}`} /> : null}
              {progress.gaps.length > 0 ? (
                <Chip size="small" color="error" label={`跳号 ${progress.gaps.join(',')}`} />
              ) : (
                <Chip size="small" color="success" variant="outlined" label="序号连续" />
              )}
            </Stack>
            <LinearProgress variant="determinate" value={progress.percent} sx={{ height: 10, borderRadius: 5 }} />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              当前待办：
              {progress.current
                ? `#${progress.current.seq} ${progress.current.stepType} · ${progress.current.nodeName}`
                : progress.invalid > 0
                  ? `${progress.invalid} 个节点待重新确认`
                  : progress.needInfo > 0
                    ? `${progress.needInfo} 个节点待补录配液`
                    : '全部节点已完成'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              已回退节点 {progress.rolledback} 个 · 有效完成率 {progress.percent}%
            </Typography>
          </Paper>
        </Stack>

        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              工序时间线
            </Typography>
            <ProcedureTimeline
              items={progress.list}
              deriveState={progress.stateOf}
              glueMap={progress.glueMap}
              onFinish={(pid) => void handleFinish(pid)}
              onRollback={async (pid) => {
                await rollback(pid);
                setToast('节点已回退');
              }}
              onReconfirm={(node) => setGlueDialog({ node, mode: 'reconfirm' })}
              onSupplement={(node) => setGlueDialog({ node, mode: 'supplement' })}
            />
          </Paper>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={700} gutterBottom>
              修复影像留痕（{photos.length} 张）
            </Typography>
            {photos.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                暂无影像条目，可在工序录入时挂接。
              </Typography>
            ) : (
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 1.5 }}>
                {photos.map((p) => (
                  <Paper key={p.id} variant="outlined" sx={{ overflow: 'hidden' }}>
                    <Box component="img" src={p.dataUrl} alt={p.caption} sx={{ width: '100%', display: 'block' }} />
                    <Box sx={{ p: 1 }}>
                      <Chip size="small" label={PHOTO_STAGE_LABEL[p.stage]} />
                      <Typography variant="caption" display="block" noWrap title={p.caption}>
                        {p.caption}
                      </Typography>
                    </Box>
                  </Paper>
                ))}
              </Box>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              修复前 {beforePhotos.length} 张 / 修复后 {afterPhotos.length} 张，全部存于浏览器本地 IndexedDB 影像表。
            </Typography>
          </Paper>
        </Stack>
      </Box>

      <GlueLinkDialog node={glueDialog?.node ?? null} mode={glueDialog?.mode ?? 'supplement'} onClose={() => setGlueDialog(null)} />

      <Snackbar open={!!toast} autoHideDuration={2400} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

/** 在事件回调里拿一次最新的阻断项（sweep 后 store 已刷新） */
function computeBlockers(specimenId: string): string[] {
  const procs = useProcedureStore.getState().items.filter((p) => p.specimenId === specimenId);
  const glueMap = new Map(useGlueStore.getState().items.map((b) => [b.id, b]));
  const out: string[] = [];
  for (const proc of procs) {
    if (proc.state === 'invalid') {
      out.push(`#${proc.seq} ${proc.nodeName} 所用胶液已失效，需重新确认`);
      continue;
    }
    if (proc.state === 'rolledback') continue;
    if (proc.adhesive && !proc.glueBatchId) {
      out.push(`#${proc.seq} ${proc.nodeName} 缺配液批次信息，需补录后才能交付`);
      continue;
    }
    if (proc.state === 'pending') out.push(`#${proc.seq} ${proc.nodeName} 尚未完成`);
    if (proc.glueBatchId) {
      const batch = glueMap.get(proc.glueBatchId);
      if (proc.state === 'done' && (!batch || !isGlueUsable(batch))) {
        out.push(`#${proc.seq} ${proc.nodeName} 关联胶液不可用，需重新确认`);
      }
    }
  }
  return out;
}
