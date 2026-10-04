import { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import { MeasureField } from './MeasureField';
import {
  formatPotLifeLeft,
  isGlueUsable,
  type GlueBatch,
} from '../../types/glue';
import type { PrepProcedure } from '../../types/procedure';

export interface GlueActionDialogProps {
  /** reconfirm：失效后改用新批次，扣减余量；supplement：旧工序补登批号，不扣余量 */
  mode: 'reconfirm' | 'supplement';
  procedure: PrepProcedure | null;
  batches: GlueBatch[];
  onClose: () => void;
  onSubmit: (payload: { batchId: string; qty: number; operator: string; note?: string }) => Promise<{
    ok: boolean;
    message: string;
  }>;
  onDone?: (message: string) => void;
}

const TITLE: Record<GlueActionDialogProps['mode'], string> = {
  reconfirm: '重新确认胶液',
  supplement: '补登配液信息',
};

/** 工序时间线上「重新确认 / 补登配液」弹窗，写入失败时保留草稿与错误原因 */
export function GlueActionDialog({ mode, procedure, batches, onClose, onSubmit, onDone }: GlueActionDialogProps) {
  const [batchId, setBatchId] = useState('');
  const [qty, setQty] = useState(1);
  const [operator, setOperator] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (procedure) {
      setBatchId('');
      setQty(1);
      setOperator(procedure.operator ?? '');
      setNote('');
      setError('');
      setSubmitting(false);
    }
  }, [procedure]);

  // 重新确认只能选「同胶种 + 当前可用」批次；补登可选择任意历史批次（含已失效）
  const candidates = batches.filter((b) =>
    mode === 'reconfirm' ? b.adhesive === procedure?.adhesive && isGlueUsable(b) : b.adhesive === procedure?.adhesive,
  );
  const selected = batches.find((b) => b.id === batchId);

  const submit = async () => {
    if (!batchId) {
      setError('请选择胶液批次');
      return;
    }
    if (mode === 'reconfirm' && !(qty > 0)) {
      setError('领用数量必须大于 0');
      return;
    }
    if (!operator.trim()) {
      setError(mode === 'reconfirm' ? '领用人必填' : '补登责任人必填');
      return;
    }
    setSubmitting(true);
    const result = await onSubmit({ batchId, qty, operator: operator.trim(), note: note.trim() || undefined });
    setSubmitting(false);
    if (!result.ok) {
      // 写入失败：弹窗保留、草稿不丢
      setError(result.message);
      return;
    }
    onDone?.(result.message);
    onClose();
  };

  return (
    <Dialog open={!!procedure} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{TITLE[mode]}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          {procedure ? (
            <Typography variant="body2" color="text.secondary">
              工序 #{procedure.seq} {procedure.stepType} · {procedure.nodeName}（胶种 {procedure.adhesive}
              {procedure.adhesiveConc > 0 ? ` ${procedure.adhesiveConc}%` : ''}）
            </Typography>
          ) : null}
          {error ? <Alert severity="error" data-testid="glue-action-error">{error}</Alert> : null}
          {mode === 'reconfirm' ? (
            <Alert severity="warning">
              原胶液已到适用期或余量耗尽，确认后将从新批次扣减余量；若该标本此前被撤下，重新确认后转回待交付。
            </Alert>
          ) : (
            <Alert severity="info">补登为历史追溯操作，不扣减余量；补登后节点回到待办，不沿用原完成结论。</Alert>
          )}
          <TextField
            select
            size="small"
            label="胶液批次（批号）"
            required
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
          >
            {candidates.length === 0 ? (
              <MenuItem value="" disabled>
                {mode === 'reconfirm' ? '暂无同胶种可用批次，请先去「胶液批次」配液' : '暂无同胶种批次记录'}
              </MenuItem>
            ) : null}
            {candidates.map((b) => (
              <MenuItem key={b.id} value={b.id}>
                {b.lotNo} · 余 {b.qty} {b.unit} · {b.concPct}% · {formatPotLifeLeft(b)}
                {mode === 'supplement' && b.state !== 'usable' ? '（历史批次）' : ''}
              </MenuItem>
            ))}
          </TextField>
          {selected && mode === 'reconfirm' ? (
            <MeasureField
              label="领用数量"
              unit={selected.unit}
              min={0.1}
              max={selected.qty}
              step={1}
              value={qty}
              onChange={setQty}
              hint={`现存 ${selected.qty} ${selected.unit}，${formatPotLifeLeft(selected)}`}
            />
          ) : null}
          <TextField
            size="small"
            label={mode === 'reconfirm' ? '领用人 / 确认人' : '补登责任人'}
            required
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
          />
          <TextField
            size="small"
            label="备注"
            multiline
            minRows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={mode === 'reconfirm' ? '可记录重新加固范围等' : '可记录当时配液批号来源、核对情况'}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          取消
        </Button>
        <Button variant="contained" onClick={submit} disabled={submitting} data-testid="glue-action-confirm">
          {submitting ? '提交中…' : mode === 'reconfirm' ? '确认并领用' : '补登并回到待办'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default GlueActionDialog;
