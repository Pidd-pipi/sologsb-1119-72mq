import { useEffect, useMemo, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useGlueStore } from '../../stores/glueStore';
import { useSpecimenStore } from '../../stores/specimenStore';
import { MeasureField } from '../common/MeasureField';
import { isGlueUsable, potLifeLeftMin, type GlueBatch } from '../../types/glue';
import type { PrepProcedure } from '../../types/procedure';

export interface GlueLinkDialogProps {
  /** 待补录 / 重新确认的工序节点 */
  node: PrepProcedure | null;
  mode: 'supplement' | 'reconfirm';
  onClose: () => void;
}

/** 为老工序补录配液，或为胶液失效节点重新确认批次；绑定后恢复节点结论 */
export function GlueLinkDialog({ node, mode, onClose }: GlueLinkDialogProps) {
  const glueBatches = useGlueStore((s) => s.items);
  const specimens = useSpecimenStore((s) => s.items);
  const linkProcedure = useGlueStore((s) => s.linkProcedure);

  const [batchId, setBatchId] = useState('');
  const [qty, setQty] = useState(5);
  const [operator, setOperator] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!node) return;
    setError('');
    setBusy(false);
    setBatchId(node.glueBatchId ?? '');
    setQty(node.glueQty ?? 5);
    setOperator(node.operator ?? '');
  }, [node]);

  const candidates = useMemo<GlueBatch[]>(() => {
    if (!node) return [];
    return glueBatches.filter((b) => b.adhesive === node.adhesive && isGlueUsable(b));
  }, [glueBatches, node]);

  if (!node) return null;
  const specimen = specimens.find((s) => s.id === node.specimenId);
  const selected = glueBatches.find((b) => b.id === batchId);

  const submit = async () => {
    if (!batchId) {
      setError('请选择在用胶液批次');
      return;
    }
    const batch = glueBatches.find((b) => b.id === batchId);
    if (!batch || !isGlueUsable(batch)) {
      setError('所选批次已封档或过适用期，请另选');
      return;
    }
    if (!(qty > 0)) {
      setError('领用量必须大于 0');
      return;
    }
    if (qty > batch.qty) {
      setError(`领用量超出余量（现存 ${batch.qty} ${batch.unit}）`);
      return;
    }
    if (!operator.trim()) {
      setError('确认人必填');
      return;
    }
    setBusy(true);
    try {
      await linkProcedure({
        procedureId: node.id,
        glueBatchId: batchId,
        glueQty: qty,
        operator: operator.trim(),
        specimenNo: specimen?.specimenNo ?? '未关联标本',
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '写入失败，请重试（表单内容已保留）');
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!node} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {mode === 'supplement' ? '补录配液信息' : '重新确认胶液'} · #{node.seq} {node.nodeName}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          {error ? <Alert severity="error" data-testid="glue-link-error">{error}</Alert> : null}
          <Alert severity={mode === 'supplement' ? 'warning' : 'error'}>
            {mode === 'supplement'
              ? '该节点为旧工序记录，只登记了胶种、没有配液批次，完成结论暂不生效，请补录当时所用胶液。'
              : `该节点所用胶液${node.invalidReason ? `（${node.invalidReason}）` : ''}已失效，选择新批次重新确认后方可恢复。`}
          </Alert>
          <Typography variant="body2" color="text.secondary">
            胶种：{node.adhesive}
            {node.adhesiveConc > 0 ? `（原浓度 ${node.adhesiveConc} %）` : ''} · 标本 {specimen?.specimenNo ?? '—'}
          </Typography>
          <TextField
            select
            size="small"
            label="在用胶液批次"
            value={batchId}
            onChange={(e) => {
              setBatchId(e.target.value);
              setError('');
            }}
            helperText={candidates.length === 0 ? '当前没有同胶种的可调批次，请先到材料台账配制胶液' : '仅列出未过适用期且有余量的批次'}
          >
            {candidates.map((b) => {
              const left = potLifeLeftMin(b);
              return (
                <MenuItem key={b.id} value={b.id}>
                  {b.lotNo} · {b.concentration}% · 余 {b.qty} {b.unit} · 适用期剩 {left >= 60 ? `${Math.floor(left / 60)} h` : `${left} min`} · {b.owner}
                </MenuItem>
              );
            })}
          </TextField>
          {selected ? (
            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Chip size="small" label={`批号 ${selected.lotNo}`} />
              <Chip size="small" label={`浓度 ${selected.concentration} %`} />
              <Chip size="small" color="info" variant="outlined" label={`余量 ${selected.qty} ${selected.unit}`} />
              <Chip size="small" label={`责任人 ${selected.owner}`} />
            </Stack>
          ) : null}
          <MeasureField
            label="本节点领用量"
            unit="ml"
            min={0.1}
            max={selected?.qty ?? 100000}
            step={0.5}
            value={qty}
            onChange={setQty}
            hint="补录 / 重新确认会按该数量扣减余量并写入领用流水"
          />
          <TextField
            size="small"
            label="确认人"
            required
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button variant="contained" onClick={submit} disabled={busy || candidates.length === 0}>
          {busy ? '写入中…' : mode === 'supplement' ? '补录并恢复' : '重新确认'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default GlueLinkDialog;
