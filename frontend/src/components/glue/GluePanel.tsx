import { useEffect, useMemo, useState } from 'react';
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
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import AddIcon from '@mui/icons-material/Add';
import LockIcon from '@mui/icons-material/Lock';
import { useGlueStore } from '../../stores/glueStore';
import { useSpecimenStore } from '../../stores/specimenStore';
import { MeasureField } from '../common/MeasureField';
import {
  GLUE_CLOSE_REASON_LABEL,
  isGlueUsable,
  potLifeLeftMin,
  suggestGlueLotNo,
  type GlueBatch,
  type GlueBatchDraft,
} from '../../types/glue';
import { GlueIssueError } from '../../utils/glueService';
import { STEP_FIELD_MAP } from '../../types/procedure';

/** 领用草稿按批次存 localStorage，写入失败 / 重开对话框都能恢复 */
const draftKey = (batchId: string) => `gbfossilprep:glue-issue-draft:${batchId}`;

interface IssueDraft {
  qty: number;
  operator: string;
  specimenNo: string;
}

function readDraft(batchId: string): IssueDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(batchId));
    return raw ? (JSON.parse(raw) as IssueDraft) : null;
  } catch {
    return null;
  }
}

function writeDraft(batchId: string, draft: IssueDraft) {
  try {
    window.localStorage.setItem(draftKey(batchId), JSON.stringify(draft));
  } catch {
    /* 私密模式等场景忽略 */
  }
}

function clearDraft(batchId: string) {
  try {
    window.localStorage.removeItem(draftKey(batchId));
  } catch {
    /* ignore */
  }
}

/** 适用期剩余文案，<60 分钟显示分钟并变红 */
function potLifeText(batch: GlueBatch): { text: string; danger: boolean } {
  if (batch.status === 'sealed') {
    return { text: `已封档 · ${GLUE_CLOSE_REASON_LABEL[batch.closedReason ?? 'manual']}`, danger: true };
  }
  const left = potLifeLeftMin(batch);
  if (left < 0) return { text: '已到适用期', danger: true };
  if (left < 60) return { text: `剩 ${left} 分钟`, danger: true };
  return { text: `剩 ${Math.floor(left / 60)} 小时 ${left % 60} 分`, danger: false };
}

const ALL_ADHESIVES = Array.from(new Set(Object.values(STEP_FIELD_MAP).flatMap((m) => m.adhesives)));

/** 胶液配制与领用：批号 / 初始量 / 适用期 / 责任人登记，领用扣减余量 */
export function GluePanel() {
  const batches = useGlueStore((s) => s.items);
  const addBatch = useGlueStore((s) => s.add);
  const issueBatch = useGlueStore((s) => s.issue);
  const sealBatch = useGlueStore((s) => s.seal);
  const specimens = useSpecimenStore((s) => s.items);

  const [showSealed, setShowSealed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<GlueBatchDraft>({
    lotNo: suggestGlueLotNo(1),
    adhesive: ALL_ADHESIVES[0],
    concentration: 5,
    initialQty: 100,
    potLifeMin: 240,
    owner: '',
  });
  const [createError, setCreateError] = useState('');

  const [issueTarget, setIssueTarget] = useState<GlueBatch | null>(null);
  // expectedRev 为打开对话框时的版本；另一标签页先领用后 rev 改变，本次写入必失败
  const [expectedRev, setExpectedRev] = useState(0);
  const [issueQty, setIssueQty] = useState(5);
  const [issueOperator, setIssueOperator] = useState('');
  const [issueSpecimen, setIssueSpecimen] = useState('');
  const [issueError, setIssueError] = useState('');
  const [busy, setBusy] = useState(false);

  const [sealTarget, setSealTarget] = useState<GlueBatch | null>(null);
  const [toast, setToast] = useState('');

  // 30 秒跳一次，驱动适用期倒计时与「即将到期」渲染（到期失效由定时巡检兜底）
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((v) => v + 1), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // 批次列表会被其它标签页的领用刷新，对话框打开期间同步最新余量，rev 保持开窗口快照
  const liveTarget = useMemo(
    () => batches.find((b) => b.id === issueTarget?.id) ?? issueTarget,
    [batches, issueTarget],
  );

  const activeCount = batches.filter((b) => b.status === 'active').length;
  const dueSoon = batches.filter((b) => b.status === 'active' && potLifeLeftMin(b) < 60).length;
  const rows = batches.filter((b) => showSealed || b.status === 'active');

  const openCreate = () => {
    setDraft({
      lotNo: suggestGlueLotNo(batches.length + 1),
      adhesive: ALL_ADHESIVES[0],
      concentration: 5,
      initialQty: 100,
      potLifeMin: 240,
      owner: '',
    });
    setCreateError('');
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    if (!draft.lotNo.trim()) return setCreateError('批号必填');
    if (batches.some((b) => b.lotNo === draft.lotNo.trim())) return setCreateError('批号已存在，请更换');
    if (!(draft.initialQty > 0)) return setCreateError('初始量必须大于 0');
    if (!(draft.potLifeMin > 0)) return setCreateError('适用期必须大于 0 分钟');
    if (!draft.owner.trim()) return setCreateError('配液责任人必填');
    await addBatch({ ...draft, lotNo: draft.lotNo.trim(), owner: draft.owner.trim() });
    setCreateOpen(false);
    setToast('胶液已配液登记');
  };

  const openIssue = (batch: GlueBatch) => {
    const saved = readDraft(batch.id);
    setIssueTarget(batch);
    setExpectedRev(batch.rev);
    setIssueQty(saved?.qty ?? 5);
    setIssueOperator(saved?.operator ?? '');
    setIssueSpecimen(saved?.specimenNo ?? '');
    setIssueError('');
    setBusy(false);
  };

  const closeIssue = () => {
    setIssueTarget(null);
    setIssueError('');
    setBusy(false);
  };

  const submitIssue = async () => {
    if (!issueTarget) return;
    if (!(issueQty > 0)) {
      setIssueError('领用数量必须大于 0');
      return;
    }
    if (issueQty > (liveTarget?.qty ?? 0)) {
      setIssueError(`余量不足：当前仅剩 ${liveTarget?.qty ?? 0} ${issueTarget.unit}`);
      return;
    }
    if (!issueOperator.trim()) {
      setIssueError('领用人必填');
      return;
    }
    const payload: IssueDraft = {
      qty: issueQty,
      operator: issueOperator.trim(),
      specimenNo: issueSpecimen || '未关联标本',
    };
    // 先落草稿：写入失败（含另一标签页抢先领用）时表单原样恢复
    writeDraft(issueTarget.id, payload);
    setBusy(true);
    setIssueError('');
    try {
      const result = await issueBatch(issueTarget.id, {
        ...payload,
        expectedRev,
      });
      clearDraft(issueTarget.id);
      closeIssue();
      const extras: string[] = [];
      if (result.batch.status === 'sealed') extras.push('余量已耗尽，批次封档');
      if (result.invalidated.length > 0) extras.push(`${result.invalidated.length} 个工序节点已失效`);
      if (result.withdrawnSpecimenIds.length > 0) extras.push(`${result.withdrawnSpecimenIds.length} 件已交付标本已撤下`);
      setToast(`领用成功：${result.batch.lotNo} 余 ${result.batch.qty} ml${extras.length ? '；' + extras.join('，') : ''}`);
    } catch (e) {
      // 失败不关闭对话框、不清空输入：恢复草稿供修改后重试
      setBusy(false);
      if (e instanceof GlueIssueError) {
        setIssueError(e.message);
      } else {
        setIssueError('写入失败，已保留草稿，请重试');
      }
    }
  };

  const confirmSeal = async () => {
    if (!sealTarget) return;
    const n = await sealBatch(sealTarget.id);
    setSealTarget(null);
    setToast(`批次 ${sealTarget.lotNo} 已封档${n > 0 ? `，${n} 个关联节点失效` : ''}`);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
        <Typography variant="subtitle1" fontWeight={700}>
          胶液配制
        </Typography>
        <Chip size="small" label={`可调 ${activeCount} 批`} />
        <Chip size="small" color={dueSoon > 0 ? 'warning' : 'default'} label={`1 小时内到期 ${dueSoon} 批`} />
        <Box sx={{ flex: 1 }} />
        <Button size="small" onClick={() => setShowSealed((v) => !v)}>
          {showSealed ? '隐藏封档批次' : '查看封档批次'}
        </Button>
        <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={openCreate}>
          配液登记
        </Button>
      </Stack>

      <Alert severity="info">
        技师被叫走回来后，先看批次的适用期倒计时：到点或余量耗尽的批次自动封档，关联的未完成与已完成工序立即失效、需重新确认，已交付标本会被撤回到待交付。
      </Alert>

      <Paper variant="outlined" sx={{ p: 0 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>批号</TableCell>
              <TableCell>胶种</TableCell>
              <TableCell align="right">浓度</TableCell>
              <TableCell align="right">初始量</TableCell>
              <TableCell align="right">余量</TableCell>
              <TableCell>配制时间</TableCell>
              <TableCell>适用期</TableCell>
              <TableCell>责任人</TableCell>
              <TableCell>最近领用</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10}>
                  <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
                    暂无胶液批次，点「配液登记」记录批号、初始量、适用期与责任人。
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((b) => {
                const usable = isGlueUsable(b);
                const pl = potLifeText(b);
                const low = b.status === 'active' && b.qty <= 0.2 * b.initialQty;
                return (
                  <TableRow
                    key={b.id}
                    hover
                    data-testid={`glue-row-${b.lotNo}`}
                    sx={{
                      bgcolor: b.status === 'sealed' ? 'action.hover' : low ? 'warning.light' : undefined,
                    }}
                  >
                    <TableCell>
                      {b.lotNo}
                      {b.status === 'sealed' ? (
                        <Chip size="small" color="error" label="封档" sx={{ ml: 1 }} />
                      ) : !usable ? (
                        <Chip size="small" color="error" label="不可用" sx={{ ml: 1 }} />
                      ) : low ? (
                        <Chip size="small" color="warning" label="余量低" sx={{ ml: 1 }} />
                      ) : null}
                    </TableCell>
                    <TableCell>{b.adhesive}</TableCell>
                    <TableCell align="right">{b.concentration} %</TableCell>
                    <TableCell align="right">{b.initialQty} ml</TableCell>
                    <TableCell align="right" data-testid={`glue-qty-${b.lotNo}`}>
                      {b.qty} ml
                    </TableCell>
                    <TableCell>{new Date(b.preparedAt).toLocaleString('zh-CN', { hour12: false })}</TableCell>
                    <TableCell>
                      <Chip size="small" color={pl.danger ? 'error' : 'default'} label={pl.text} />
                    </TableCell>
                    <TableCell>{b.owner}</TableCell>
                    <TableCell>
                      {b.issues.length === 0
                        ? '—'
                        : `${b.issues[0].operator} 领 ${b.issues[0].qty} ml（${b.issues[0].specimenNo}）`}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Button size="small" disabled={!usable} onClick={() => openIssue(b)}>
                          领用
                        </Button>
                        {b.status === 'active' ? (
                          <Button size="small" color="warning" startIcon={<LockIcon />} onClick={() => setSealTarget(b)}>
                            封档
                          </Button>
                        ) : null}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Paper>

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Typography variant="subtitle2" gutterBottom>
          领用流水（批号追溯）
        </Typography>
        {batches.every((b) => b.issues.length === 0) ? (
          <Typography variant="body2" color="text.secondary">
            暂无领用记录。
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {batches
              .filter((b) => b.issues.length > 0)
              .map((b) => (
                <Typography key={b.id} variant="caption" color="text.secondary">
                  批号 {b.lotNo}（{b.adhesive}）：
                  {b.issues
                    .map((i) => `${i.operator} ${i.qty}ml→${i.specimenNo} · ${new Date(i.issuedAt).toLocaleString('zh-CN', { hour12: false })}`)
                    .join('；')}
                </Typography>
              ))}
          </Stack>
        )}
      </Paper>

      {/* 配液登记 */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>配液登记</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {createError ? <Alert severity="error">{createError}</Alert> : null}
            <TextField
              size="small"
              label="批号"
              required
              value={draft.lotNo}
              onChange={(e) => setDraft({ ...draft, lotNo: e.target.value })}
              helperText="建议格式 GL-日期-序号，可修改"
            />
            <TextField
              select
              size="small"
              label="胶种"
              value={draft.adhesive}
              onChange={(e) => setDraft({ ...draft, adhesive: e.target.value })}
            >
              {ALL_ADHESIVES.map((a) => (
                <MenuItem key={a} value={a}>
                  {a}
                </MenuItem>
              ))}
            </TextField>
            <Stack direction="row" spacing={1.5}>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="浓度"
                  unit="%"
                  min={0.5}
                  max={100}
                  step={0.5}
                  value={draft.concentration}
                  onChange={(v) => setDraft({ ...draft, concentration: v })}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="初始量"
                  unit="ml"
                  min={1}
                  max={10000}
                  step={5}
                  value={draft.initialQty}
                  onChange={(v) => setDraft({ ...draft, initialQty: v })}
                />
              </Box>
              <Box sx={{ flex: 1 }}>
                <MeasureField
                  label="适用期"
                  unit="min"
                  min={1}
                  max={10080}
                  step={10}
                  value={draft.potLifeMin}
                  onChange={(v) => setDraft({ ...draft, potLifeMin: v })}
                  hint={`到期后立即封档（${Math.round(draft.potLifeMin / 60)} h）`}
                />
              </Box>
            </Stack>
            <TextField
              size="small"
              label="配液责任人"
              required
              value={draft.owner}
              onChange={(e) => setDraft({ ...draft, owner: e.target.value })}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button variant="contained" onClick={submitCreate}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 领用：expectedRev 乐观锁，失败保留草稿 */}
      <Dialog open={!!issueTarget} onClose={busy ? undefined : closeIssue} fullWidth maxWidth="xs">
        <DialogTitle>领用胶液{liveTarget ? ` · ${liveTarget.lotNo}` : ''}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {issueError ? <Alert severity="error" data-testid="glue-issue-error">{issueError}</Alert> : null}
            {liveTarget ? (
              <Alert severity={liveTarget.rev !== expectedRev ? 'warning' : 'info'}>
                {liveTarget.adhesive} {liveTarget.concentration}% · 现存 {liveTarget.qty} {liveTarget.unit} ·{' '}
                {potLifeText(liveTarget).text}
                {liveTarget.rev !== expectedRev ? '（打开窗口后余量已被改动，直接提交将失败并保留草稿）' : ''}
              </Alert>
            ) : null}
            <MeasureField
              label="领用数量"
              unit="ml"
              min={0.1}
              max={liveTarget?.qty ?? 0.1}
              step={0.5}
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
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeIssue} disabled={busy}>
            取消
          </Button>
          <Button variant="contained" onClick={submitIssue} disabled={busy}>
            {busy ? '写入中…' : '确认领用'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 封档确认 */}
      <Dialog open={!!sealTarget} onClose={() => setSealTarget(null)} fullWidth maxWidth="xs">
        <DialogTitle>封档胶液批次</DialogTitle>
        <DialogContent dividers>
          <Alert severity="warning" sx={{ mb: 1 }}>
            封档后 {sealTarget?.lotNo} 不能再领用，关联的未完成与已完成工序将立即失效、需重新确认；
            若标本已交付会被撤回到待交付。
          </Alert>
          <Typography variant="body2" color="text.secondary">
            适用期到期与余量耗尽会自动封档，人工封档仅用于胶液被污染、弃用等场景。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSealTarget(null)}>取消</Button>
          <Button variant="contained" color="warning" onClick={confirmSeal}>
            确认封档
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!toast} autoHideDuration={3200} onClose={() => setToast('')} message={toast} />
    </Stack>
  );
}

export default GluePanel;
