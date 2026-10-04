import { useEffect, useMemo, useState, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';
import Collapse from '@mui/material/Collapse';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import AddIcon from '@mui/icons-material/Add';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ScienceIcon from '@mui/icons-material/Science';
import { useGlueStore, suggestLotNo } from '../stores/glueStore';
import { useSpecimenStore } from '../stores/specimenStore';
import { MeasureField } from '../components/common/MeasureField';
import { STEP_FIELD_MAP, STEP_TYPES } from '../types/procedure';
import {
  GLUE_INVALID_REASON_LABEL,
  formatPotLifeLeft,
  formatTs,
  isGlueUsable,
  potLifeEndAt,
  potLifeLeftMin,
  type GlueBatch,
  type GlueBatchDraft,
} from '../types/glue';

/** 工序表里出现过的全部胶种候选 */
const ADHESIVE_OPTIONS = Array.from(
  new Set(STEP_TYPES.flatMap((t) => STEP_FIELD_MAP[t].adhesives)),
);

function toLocalInputValue(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface MixDraft {
  lotNo: string;
  adhesive: string;
  concPct: number;
  mixedAtText: string;
  potLifeMin: number;
  initialQty: number;
  unit: string;
  operator: string;
}

function emptyMixDraft(): MixDraft {
  return {
    lotNo: '',
    adhesive: ADHESIVE_OPTIONS[0] ?? '',
    concPct: 5,
    mixedAtText: toLocalInputValue(Date.now()),
    potLifeMin: 480,
    initialQty: 50,
    unit: 'mL',
    operator: '',
  };
}

/** /glue 胶液批次台账：配液登记、领用扣减、适用期倒计时与失效级联提醒 */
export default function GlueBatches() {
  const navigate = useNavigate();
  const batches = useGlueStore((s) => s.items);
  const addBatch = useGlueStore((s) => s.add);
  const issue = useGlueStore((s) => s.issue);
  const enforce = useGlueStore((s) => s.enforce);
  const specimens = useSpecimenStore((s) => s.items);

  const [now, setNow] = useState(Date.now());
  const [kw, setKw] = useState('');
  const [mixOpen, setMixOpen] = useState(false);
  const [mixDraft, setMixDraft] = useState<MixDraft>(emptyMixDraft);
  const [issueTarget, setIssueTarget] = useState<GlueBatch | null>(null);
  const [issueQty, setIssueQty] = useState(1);
  const [issueOperator, setIssueOperator] = useState('');
  const [issueSpecimen, setIssueSpecimen] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  // 每秒刷新倒计时；发现本地视角下「应失效」的批次时立即跑失效巡检（含级联 + 跨标签页广播）
  useEffect(() => {
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      const needEnforce = useGlueStore
        .getState()
        .items.some((b) => b.state === 'usable' && (t >= potLifeEndAt(b) || b.qty <= 0));
      if (needEnforce) void enforce();
    }, 1000);
    const safety = window.setInterval(() => void enforce(), 20000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void enforce();
    };
    document.addEventListener('visibilitychange', onVisible);
    void enforce();
    return () => {
      window.clearInterval(timer);
      window.clearInterval(safety);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enforce]);

  const filtered = useMemo(() => {
    const k = kw.trim();
    return batches.filter((b) => !k || b.lotNo.includes(k) || b.adhesive.includes(k));
  }, [batches, kw]);

  const usableCount = batches.filter((b) => isGlueUsable(b, now)).length;
  const expiringCount = batches.filter(
    (b) => b.state === 'usable' && potLifeLeftMin(b, now) <= 30 && potLifeLeftMin(b, now) >= 0,
  ).length;
  const invalidCount = batches.length - batches.filter((b) => b.state === 'usable').length;
  const withdrawnSpecimens = specimens.filter((s) => s.status === '已撤下');

  const openMix = () => {
    setMixDraft({ ...emptyMixDraft(), lotNo: suggestLotNo(ADHESIVE_OPTIONS[0] ?? 'GLUE') });
    setError('');
    setMixOpen(true);
  };

  const submitMix = async () => {
    if (!mixDraft.lotNo.trim()) return setError('批号必填');
    if (!mixDraft.adhesive.trim()) return setError('胶种必填');
    if (!mixDraft.operator.trim()) return setError('配液责任人必填');
    if (!(mixDraft.initialQty > 0)) return setError('初始量必须大于 0');
    if (!(mixDraft.potLifeMin > 0)) return setError('适用期必须大于 0 分钟');
    const mixedAt = new Date(mixDraft.mixedAtText).getTime();
    if (!Number.isFinite(mixedAt)) return setError('配液时间格式不正确');
    if (batches.some((b) => b.lotNo === mixDraft.lotNo.trim())) return setError('批号已存在，请更换');

    const draft: GlueBatchDraft = {
      lotNo: mixDraft.lotNo.trim(),
      adhesive: mixDraft.adhesive.trim(),
      concPct: mixDraft.concPct,
      mixedAt,
      initialQty: mixDraft.initialQty,
      unit: mixDraft.unit.trim() || 'mL',
      potLifeMin: mixDraft.potLifeMin,
      operator: mixDraft.operator.trim(),
    };
    await addBatch(draft);
    setMixOpen(false);
    setError('');
    setToast(`胶液 ${draft.lotNo} 已登记，适用期至 ${formatTs(potLifeEndAt(draft))}`);
  };

  const openIssue = (batch: GlueBatch) => {
    setIssueTarget(batch);
    setIssueQty(1);
    setIssueOperator('');
    setIssueSpecimen('');
    setError('');
  };

  const submitIssue = async () => {
    if (!issueTarget) return;
    if (!issueOperator.trim()) return setError('领用人必填');
    if (!(issueQty > 0)) return setError('领用数量必须大于 0');
    // 失败时不关闭弹窗：数量 / 领用人 / 标本草稿全部保留，供改后重提
    const result = await issue(issueTarget.id, {
      qty: issueQty,
      operator: issueOperator.trim(),
      specimenNo: issueSpecimen || '未关联标本',
      purpose: '直接领用',
    });
    const fresh = useGlueStore.getState().items.find((b) => b.id === issueTarget.id);
    if (!result.ok) {
      setIssueTarget(fresh ?? issueTarget);
      setError(result.message);
      return;
    }
    setIssueTarget(null);
    setError('');
    setToast(result.message);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <ScienceIcon color="primary" />
        <Typography variant="h5" fontWeight={700}>
          胶液批次台账
        </Typography>
        <Chip size="small" label={`共 ${batches.length} 批`} />
        <Chip size="small" color="success" variant="outlined" label={`可用 ${usableCount}`} />
        <Chip size="small" color="warning" variant="outlined" label={`30 分钟内到期 ${expiringCount}`} />
        <Chip size="small" color="error" variant="outlined" label={`已失效 ${invalidCount}`} />
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" startIcon={<AddIcon />} onClick={openMix}>
          配液登记
        </Button>
      </Stack>

      <Alert severity="info">
        胶液按「批次 + 适用期」管理：配液时登记批号、初始量、适用期与责任人；工序领用即扣减余量。适用期到或余量扣完，未完成工序立即失效并须重新确认，已交付标本自动撤下。
      </Alert>

      {withdrawnSpecimens.length > 0 ? (
        <Alert
          severity="error"
          data-testid="glue-withdrawn-banner"
          action={
            <Button color="inherit" size="small" onClick={() => navigate('/specimens')}>
              查看标本
            </Button>
          }
        >
          有 {withdrawnSpecimens.length} 件已交付标本因胶液失效被撤下：
          {withdrawnSpecimens.map((s) => `${s.specimenNo}（${s.withdrawReason ?? '胶液失效'}）`).join('；')}
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <TextField
          size="small"
          label="批号 / 胶种检索"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          sx={{ minWidth: 260 }}
          helperText="按批号或胶种定位批次，展开可看全部领用流水"
        />
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell />
              <TableCell>批号</TableCell>
              <TableCell>胶种 / 浓度</TableCell>
              <TableCell>配液时间</TableCell>
              <TableCell align="right">初始量</TableCell>
              <TableCell align="right">剩余量</TableCell>
              <TableCell align="right">适用期</TableCell>
              <TableCell>责任人</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.map((batch) => {
              const usable = isGlueUsable(batch, now);
              const leftMin = potLifeLeftMin(batch, now);
              const urgent = usable && leftMin <= 30;
              const open = expanded === batch.id;
              return (
                <Fragment key={batch.id}>
                  <TableRow
                    hover
                    data-testid={`glue-row-${batch.lotNo}`}
                    sx={
                      batch.state === 'invalid'
                        ? { bgcolor: 'error.light' }
                        : urgent
                          ? { bgcolor: 'warning.light' }
                          : undefined
                    }
                  >
                    <TableCell>
                      <IconButton size="small" onClick={() => setExpanded(open ? null : batch.id)}>
                        <ExpandMoreIcon fontSize="small" sx={{ transform: open ? 'rotate(180deg)' : 'none' }} />
                      </IconButton>
                    </TableCell>
                    <TableCell>
                      {batch.lotNo}
                      {batch.state === 'invalid' ? (
                        <Chip
                          size="small"
                          color="error"
                          label={`已失效 · ${GLUE_INVALID_REASON_LABEL[batch.invalidReason ?? 'manual']}`}
                          sx={{ ml: 1 }}
                        />
                      ) : urgent ? (
                        <Chip size="small" color="warning" label="即将到期" sx={{ ml: 1 }} />
                      ) : (
                        <Chip size="small" color="success" label="可用" sx={{ ml: 1 }} />
                      )}
                    </TableCell>
                    <TableCell>
                      {batch.adhesive}
                      <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                        {batch.concPct}%
                      </Typography>
                    </TableCell>
                    <TableCell>{formatTs(batch.mixedAt)}</TableCell>
                    <TableCell align="right">
                      {batch.initialQty} {batch.unit}
                    </TableCell>
                    <TableCell align="right">
                      <b>{batch.qty}</b> {batch.unit}
                    </TableCell>
                    <TableCell align="right">
                      <Tooltip title={`适用期截止 ${formatTs(potLifeEndAt(batch))}`}>
                        <Box component="span" color={batch.state === 'invalid' || urgent ? 'error.main' : 'text.primary'}>
                          {formatPotLifeLeft(batch, now)}
                        </Box>
                      </Tooltip>
                    </TableCell>
                    <TableCell>{batch.operator}</TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        variant="contained"
                        disabled={!usable}
                        onClick={() => openIssue(batch)}
                      >
                        领用
                      </Button>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell sx={{ p: 0, border: 0 }} colSpan={9}>
                      <Collapse in={open} unmountOnExit>
                        <Box sx={{ py: 1, px: 2, bgcolor: 'grey.50' }}>
                          <Typography variant="caption" color="text.secondary">
                            适用期：{formatTs(batch.mixedAt)} → {formatTs(potLifeEndAt(batch))}（{batch.potLifeMin} 分钟）
                            {batch.invalidatedAt ? ` · 失效时间 ${formatTs(batch.invalidatedAt)}` : ''}
                          </Typography>
                          <Typography variant="body2" sx={{ mt: 0.5 }} fontWeight={700}>
                            领用流水（{batch.issues.length} 笔）
                          </Typography>
                          {batch.issues.length === 0 ? (
                            <Typography variant="caption" color="text.secondary">
                              暂无领用记录。
                            </Typography>
                          ) : (
                            <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                              {batch.issues.map((i) => (
                                <Typography key={i.id} variant="caption">
                                  {formatTs(i.issuedAt)} · {i.operator} 领 {i.qty} {batch.unit} → {i.specimenNo} ·{' '}
                                  {i.purpose}
                                  {i.procedureId ? ' · 随工序领用' : ''}
                                </Typography>
                              ))}
                            </Stack>
                          )}
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} align="center">
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                    暂无胶液批次，点右上「配液登记」开始。
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </Paper>

      {/* 配液登记 */}
      <Dialog open={mixOpen} onClose={() => setMixOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>配液登记</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error" data-testid="glue-mix-error">{error}</Alert> : null}
            <Stack direction="row" spacing={1.5}>
              <TextField
                size="small"
                fullWidth
                label="批号"
                required
                value={mixDraft.lotNo}
                onChange={(e) => setMixDraft({ ...mixDraft, lotNo: e.target.value })}
                helperText="配液批次唯一编号"
              />
              <Button
                onClick={() => setMixDraft({ ...mixDraft, lotNo: suggestLotNo(mixDraft.adhesive) })}
              >
                生成建议批号
              </Button>
            </Stack>
            <TextField
              select
              size="small"
              label="胶种"
              required
              value={mixDraft.adhesive}
              onChange={(e) => setMixDraft({ ...mixDraft, adhesive: e.target.value, lotNo: suggestLotNo(e.target.value) })}
            >
              {ADHESIVE_OPTIONS.map((a) => (
                <MenuItem key={a} value={a}>
                  {a}
                </MenuItem>
              ))}
            </TextField>
            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="胶液浓度"
                  unit="%"
                  min={0}
                  max={100}
                  step={0.5}
                  value={mixDraft.concPct}
                  onChange={(v) => setMixDraft({ ...mixDraft, concPct: v })}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="初始量"
                  unit={mixDraft.unit}
                  min={0.1}
                  max={100000}
                  step={1}
                  value={mixDraft.initialQty}
                  onChange={(v) => setMixDraft({ ...mixDraft, initialQty: v })}
                />
              </Box>
              <TextField
                size="small"
                sx={{ width: 110 }}
                label="单位"
                value={mixDraft.unit}
                onChange={(e) => setMixDraft({ ...mixDraft, unit: e.target.value })}
              />
            </Stack>
            <Stack direction="row" spacing={1.5}>
              <TextField
                size="small"
                fullWidth
                label="配液时间"
                type="datetime-local"
                InputLabelProps={{ shrink: true }}
                value={mixDraft.mixedAtText}
                onChange={(e) => setMixDraft({ ...mixDraft, mixedAtText: e.target.value })}
              />
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="适用期"
                  unit="min"
                  min={1}
                  max={10080}
                  step={10}
                  value={mixDraft.potLifeMin}
                  onChange={(v) => setMixDraft({ ...mixDraft, potLifeMin: v })}
                  hint="到期后未完成工序立即失效"
                />
              </Box>
            </Stack>
            <Stack direction="row" spacing={1}>
              {[120, 240, 480].map((m) => (
                <Chip
                  key={m}
                  size="small"
                  clickable
                  label={`适用期 ${m / 60} 小时`}
                  onClick={() => setMixDraft({ ...mixDraft, potLifeMin: m })}
                />
              ))}
            </Stack>
            <TextField
              size="small"
              label="配液责任人"
              required
              value={mixDraft.operator}
              onChange={(e) => setMixDraft({ ...mixDraft, operator: e.target.value })}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setMixOpen(false)}>取消</Button>
          <Button variant="contained" onClick={submitMix}>
            保存配液
          </Button>
        </DialogActions>
      </Dialog>

      {/* 领用（跨标签页只允许一人成功；失败保留草稿） */}
      <Dialog open={!!issueTarget} onClose={() => setIssueTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>胶液领用{issueTarget ? ` · ${issueTarget.lotNo}` : ''}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error ? <Alert severity="error" data-testid="glue-issue-error">{error}</Alert> : null}
            {issueTarget ? (
              <Alert severity={isGlueUsable(issueTarget, now) ? 'info' : 'error'}>
                {issueTarget.adhesive} {issueTarget.concPct}% · 现存 {issueTarget.qty} {issueTarget.unit} ·{' '}
                {formatPotLifeLeft(issueTarget, now)}
              </Alert>
            ) : null}
            <MeasureField
              label="领用数量"
              unit={issueTarget?.unit ?? 'mL'}
              min={0.1}
              max={issueTarget?.qty ?? 1}
              step={1}
              value={issueQty}
              onChange={setIssueQty}
            />
            <TextField
              size="small"
              label="领用人"
              required
              value={issueOperator}
              onChange={(e) => setIssueOperator(e.target.value)}
            />
            <TextField
              select
              size="small"
              label="用于标本"
              value={issueSpecimen}
              onChange={(e) => setIssueSpecimen(e.target.value)}
            >
              <MenuItem value="">未关联标本</MenuItem>
              {specimens.map((s) => (
                <MenuItem key={s.id} value={s.specimenNo}>
                  {s.specimenNo}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="caption" color="text.secondary">
              若另一个标签页正在领用同一批次，只有一人提交成功；失败时本表单内容保留，可按最新余量调整后重试。
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setIssueTarget(null)}>取消</Button>
          <Button variant="contained" onClick={submitIssue} data-testid="glue-issue-confirm">
            确认领用
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={2600} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}
