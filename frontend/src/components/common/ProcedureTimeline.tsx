import { useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import UndoIcon from '@mui/icons-material/Undo';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ScienceIcon from '@mui/icons-material/Science';
import { glueStateOf, procedureViewState, type PrepProcedure } from '../../types/procedure';
import { GLUE_INVALID_REASON_LABEL, formatTs } from '../../types/glue';

export interface ProcedureTimelineProps {
  items: PrepProcedure[];
  onFinish?: (id: string) => void;
  onRollback?: (id: string) => void;
  onOpenPhoto?: (procedureId: string) => void;
  /** 胶液失效 → 用新批次重新确认（扣减余量） */
  onReconfirmGlue?: (procedure: PrepProcedure) => void;
  /** 旧工序缺配液 → 补登批号（不扣余量） */
  onSupplementGlue?: (procedure: PrepProcedure) => void;
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 纵向工序节点流：步骤图标、状态、耗时、环境参数折叠区。
 * 被标本详情页、工序录入页消费。
 */
export function ProcedureTimeline({
  items,
  onFinish,
  onRollback,
  onOpenPhoto,
  onReconfirmGlue,
  onSupplementGlue,
}: ProcedureTimelineProps) {
  const [expanded, setExpanded] = useState<string | null>(items[0]?.id ?? null);

  if (items.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          该标本暂无工序节点，请到「新建工序节点」登记。
        </Typography>
      </Paper>
    );
  }

  return (
    <Stack spacing={1} data-testid="procedure-timeline">
      {items.map((node, index) => {
        const gs = glueStateOf(node);
        const blocked = gs === 'pending_supplement' || gs === 'invalid';
        const isDone = node.state === 'done';
        const view = procedureViewState(node);
        const open = expanded === node.id;
        return (
          <Box key={node.id} sx={{ display: 'flex', gap: 1.5 }}>
            <Stack alignItems="center" sx={{ pt: 0.5 }}>
              {isDone && !blocked ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : (
                <RadioButtonUncheckedIcon
                  color={node.state === 'rolledback' || blocked ? 'error' : 'disabled'}
                  fontSize="small"
                />
              )}
              {index < items.length - 1 ? (
                <Box sx={{ flex: 1, width: '2px', minHeight: 32, bgcolor: 'divider', my: 0.5 }} />
              ) : null}
            </Stack>
            <Paper
              variant="outlined"
              sx={{
                p: 1.5,
                flex: 1,
                mb: 0.5,
                ...(gs === 'invalid' ? { borderColor: 'error.main', borderWidth: 1.5 } : {}),
                ...(gs === 'pending_supplement' ? { borderColor: 'warning.main', borderWidth: 1.5 } : {}),
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Chip size="small" label={`#${node.seq}`} color="primary" variant="outlined" />
                <Typography variant="subtitle2" fontWeight={700}>
                  {node.stepType} · {node.nodeName}
                </Typography>
                <Chip size="small" label={view.label} color={view.tone} />
                {gs === 'confirmed' ? (
                  <Tooltip title={`批号 ${node.glue?.lotNo} · 领用量 ${node.glue?.issueQty} · 确认人 ${node.glue?.boundOperator}`}>
                    <Chip
                      size="small"
                      icon={<ScienceIcon />}
                      variant="outlined"
                      color="success"
                      label={`胶 ${node.glue?.lotNo}`}
                    />
                  </Tooltip>
                ) : null}
                <Typography variant="caption" color="text.secondary">
                  耗时 {node.durationMin} min · 责任人 {node.operator}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {gs === 'invalid' && onReconfirmGlue ? (
                  <Button
                    size="small"
                    color="error"
                    variant="contained"
                    onClick={() => onReconfirmGlue(node)}
                    data-testid={`reconfirm-${node.id}`}
                  >
                    重新确认胶液
                  </Button>
                ) : null}
                {gs === 'pending_supplement' && onSupplementGlue ? (
                  <Button
                    size="small"
                    color="warning"
                    variant="contained"
                    onClick={() => onSupplementGlue(node)}
                    data-testid={`supplement-${node.id}`}
                  >
                    补登配液
                  </Button>
                ) : null}
                {!isDone && !blocked && onFinish ? (
                  <Button size="small" variant="contained" onClick={() => onFinish(node.id)}>
                    完成节点
                  </Button>
                ) : null}
                {isDone && !blocked && onRollback ? (
                  <Button size="small" color="warning" startIcon={<UndoIcon />} onClick={() => onRollback(node.id)}>
                    回退节点
                  </Button>
                ) : null}
                <Tooltip title={open ? '收起环境参数' : '展开环境参数'}>
                  <IconButton size="small" onClick={() => setExpanded(open ? null : node.id)}>
                    <ExpandMoreIcon
                      fontSize="small"
                      sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: '0.2s' }}
                    />
                  </IconButton>
                </Tooltip>
              </Stack>

              {blocked && node.glue?.glueNote ? (
                <Typography variant="caption" color={gs === 'invalid' ? 'error.main' : 'warning.main'} sx={{ display: 'block', mt: 0.5 }}>
                  {node.glue.glueNote}
                  {gs === 'invalid' && node.glue.invalidReason
                    ? `（${GLUE_INVALID_REASON_LABEL[node.glue.invalidReason]}）`
                    : ''}
                </Typography>
              ) : null}

              <Collapse in={open} unmountOnExit>
                <Divider sx={{ my: 1 }} />
                <Stack direction="row" spacing={2} flexWrap="wrap" rowGap={0.5}>
                  <Typography variant="body2">工具：{node.tools.length ? node.tools.join('、') : '—'}</Typography>
                  <Typography variant="body2">磨料：{node.abrasive || '—'}</Typography>
                  <Typography variant="body2">
                    胶种：{node.adhesive || '—'}
                    {node.adhesiveConc > 0 ? `（浓度 ${node.adhesiveConc} %）` : ''}
                  </Typography>
                  <Typography variant="body2">
                    胶液：
                    {gs === 'none'
                      ? '不使用'
                      : gs === 'pending_supplement'
                        ? '待补配液信息'
                        : `批号 ${node.glue?.lotNo} · 领用 ${node.glue?.issueQty} · ${formatTs(node.glue?.boundAt)} 由 ${node.glue?.boundOperator} 确认`}
                  </Typography>
                  <Typography variant="body2">
                    环境：{node.tempC} ℃ / RH {node.rh} %
                  </Typography>
                  <Typography variant="body2">开始：{fmtTime(node.startedAt)}</Typography>
                  <Typography variant="body2">结束：{fmtTime(node.finishedAt)}</Typography>
                  <Typography variant="body2">
                    影像：前 {node.photoBeforeIds.length} 张 / 后 {node.photoAfterIds.length} 张
                  </Typography>
                  {onOpenPhoto ? (
                    <Button size="small" onClick={() => onOpenPhoto(node.id)}>
                      查看对照
                    </Button>
                  ) : null}
                </Stack>
              </Collapse>
            </Paper>
          </Box>
        );
      })}
    </Stack>
  );
}

export default ProcedureTimeline;
