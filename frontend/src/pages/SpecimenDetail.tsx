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
import { usePrepProgress } from '../hooks/usePrepProgress';
import { SpecimenCard } from '../components/common/SpecimenCard';
import { ProcedureTimeline } from '../components/common/ProcedureTimeline';
import { GlueActionDialog } from '../components/common/GlueActionDialog';
import { db } from '../utils/db';
import { PHOTO_STAGE_LABEL, type PrepPhoto } from '../types/photo';
import { SPECIMEN_STATUSES, type SpecimenStatus } from '../types/specimen';
import type { PrepProcedure } from '../types/procedure';
import { reconfirmProcedureGlue, supplementProcedureGlue } from '../utils/glueService';
import { broadcastGlueChanged } from '../stores/glueStore';

/** /specimens/:id 详情 + 工序时间线 + 影像 */
export default function SpecimenDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const specimen = useSpecimenStore((s) => s.items.find((it) => it.id === id));
  const setStatus = useSpecimenStore((s) => s.setStatus);
  const finish = useProcedureStore((s) => s.finish);
  const rollback = useProcedureStore((s) => s.rollback);
  const glueBatches = useGlueStore((s) => s.items);
  const loadGlue = useGlueStore((s) => s.load);
  const loadProcedures = useProcedureStore((s) => s.load);
  const loadSpecimens = useSpecimenStore((s) => s.load);
  const progress = usePrepProgress(id);
  const [photos, setPhotos] = useState<PrepPhoto[]>([]);
  const [toast, setToast] = useState('');
  const [statusError, setStatusError] = useState('');
  const [glueDialog, setGlueDialog] = useState<{ mode: 'reconfirm' | 'supplement'; procedure: PrepProcedure } | null>(null);

  const loadPhotos = useCallback(async () => {
    if (!id) return;
    const rows = await db.photos.where('specimenId').equals(id).toArray();
    rows.sort((a, b) => b.capturedAt - a.capturedAt);
    setPhotos(rows);
  }, [id]);

  useEffect(() => {
    void loadPhotos();
  }, [loadPhotos]);

  const reloadAll = async () => {
    await Promise.all([loadGlue(), loadProcedures(), loadSpecimens()]);
  };

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

  const beforePhotos = photos.filter((p) => p.stage === 'before');
  const afterPhotos = photos.filter((p) => p.stage === 'after');
  const hasUnfinished = progress.list.some((it) => it.state !== 'done');
  const glueBlocked = progress.pendingSupplement + progress.glueInvalid;

  const changeStatus = async (next: SpecimenStatus) => {
    setStatusError('');
    if (next === '已交付') {
      // 交付卡口：待补 / 失效 / 未完成工序存在时一律拒绝，避免过期胶液标本流出
      if (glueBlocked > 0) {
        setStatusError(`不能交付：仍有 ${glueBlocked} 个工序的胶液待补或已失效，请重新确认后再交付`);
        return;
      }
      if (hasUnfinished) {
        setStatusError('不能交付：尚有未完成工序节点');
        return;
      }
    }
    await setStatus(specimen.id, next);
    setToast(`状态已更新为「${next}」`);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="h5" fontWeight={700}>
          标本详情 · {specimen.specimenNo}
        </Typography>
        {specimen.status === '已撤下' ? <Chip size="small" color="error" label="已撤下" /> : null}
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

      {specimen.status === '已撤下' ? (
        <Alert severity="error" data-testid="specimen-withdrawn-banner">
          该标本已从交付状态撤下（{specimen.withdrawnAt ? new Date(specimen.withdrawnAt).toLocaleString('zh-CN') : '时间未记录'}）。
          {specimen.withdrawReason ? `原因：${specimen.withdrawReason}。` : ''}
          请对失效工序用新批次重新确认，全部完成后再重新交付。
        </Alert>
      ) : null}
      {progress.glueInvalid > 0 ? (
        <Alert severity="error">有 {progress.glueInvalid} 个工序所用胶液已过适用期或余量耗尽，须重新确认后方可交付。</Alert>
      ) : null}
      {progress.pendingSupplement > 0 ? (
        <Alert severity="warning">有 {progress.pendingSupplement} 个旧工序缺配液信息（待补），原完成结论未沿用。</Alert>
      ) : null}
      {statusError ? <Alert severity="error">{statusError}</Alert> : null}

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
              onChange={(e) => void changeStatus(e.target.value as SpecimenStatus)}
            >
              {SPECIMEN_STATUSES.map((s) => (
                <MenuItem key={s} value={s}>
                  {s}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              存在未完成工序或胶液待补 / 失效节点时，「已交付」会被拦截；胶液失效的已交付标本会自动撤下。
            </Typography>
          </Paper>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
              <Typography variant="subtitle2">工序完成度</Typography>
              <Chip size="small" label={`${progress.done}/${progress.total}`} />
              {progress.pendingSupplement > 0 ? (
                <Chip size="small" color="warning" label={`待补 ${progress.pendingSupplement}`} />
              ) : null}
              {progress.glueInvalid > 0 ? (
                <Chip size="small" color="error" label={`胶液失效 ${progress.glueInvalid}`} />
              ) : null}
              {progress.gaps.length > 0 ? (
                <Chip size="small" color="error" label={`跳号 ${progress.gaps.join(',')}`} />
              ) : (
                <Chip size="small" color="success" variant="outlined" label="序号连续" />
              )}
            </Stack>
            <LinearProgress variant="determinate" value={progress.percent} sx={{ height: 10, borderRadius: 5 }} />
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              当前待办：
              {progress.current ? `#${progress.current.seq} ${progress.current.stepType} · ${progress.current.nodeName}` : '全部节点已完成'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              已回退节点 {progress.rolledback} 个 · 完成率 {progress.percent}%
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
              onFinish={async (pid) => {
                const r = await finish(pid);
                setToast(r.message);
                if (!r.ok) setStatusError(r.message);
              }}
              onRollback={async (pid) => {
                await rollback(pid);
                setToast('节点已回退');
              }}
              onReconfirmGlue={(p) => setGlueDialog({ mode: 'reconfirm', procedure: p })}
              onSupplementGlue={(p) => setGlueDialog({ mode: 'supplement', procedure: p })}
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
              specimenNo: specimen.specimenNo,
            });
            await reloadAll();
            if (result.ok) broadcastGlueChanged();
            return result;
          }
          const result = await supplementProcedureGlue(glueDialog.procedure.id, payload);
          await reloadAll();
          if (result.ok) broadcastGlueChanged();
          return result;
        }}
        onDone={(msg) => setToast(msg)}
      />

      <Snackbar open={!!toast} autoHideDuration={2400} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
