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
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CancelScheduleSendIcon from '@mui/icons-material/CancelScheduleSend';
import ScienceIcon from '@mui/icons-material/Science';
import type { DerivedProcState, PrepProcedure } from '../../types/procedure';
import { isGlueUsable, potLifeLeftMin, type GlueBatch } from '../../types/glue';

export interface ProcedureTimelineProps {
  items: PrepProcedure[];
  onFinish?: (id: string) => void;
  onRollback?: (id: string) => void;
  /** 失效节点重新确认胶液 */
  onReconfirm?: (node: PrepProcedure) => void;
  /** 老工序缺配液信息，补录 */
  onSupplement?: (node: PrepProcedure) => void;
  /** 节点派生状态（含「待补」），不传时按记录原状态渲染 */
  deriveState?: (proc: PrepProcedure) => DerivedProcState;
  /** 胶液批次映射，用于回显批号与适用期 */
  glueMap?: Map<string, GlueBatch>;
  onOpenPhoto?: (procedureId: string) => void;
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATE_LABEL: Record<DerivedProcState, string> = {
  done: '已完成',
  pending: '待办',
  rolledback: '已回退',
  invalid: '已失效',
  needInfo: '待补配液',
};

/**
 * 纵向工序节点流：步骤图标、状态、耗时、环境参数折叠区。
 * 被标本详情页、工序录入页消费。
 */
export function ProcedureTimeline({
  items,
  onFinish,
  onRollback,
  onReconfirm,
  onSupplement,
  deriveState,
  glueMap,
  onOpenPhoto,
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
        const state: DerivedProcState = deriveState ? deriveState(node) : node.state;
        const isDone = state === 'done';
        const isInvalid = state === 'invalid';
        const isNeedInfo = state === 'needInfo';
        const open = expanded === node.id;
        const glueBatch = node.glueBatchId && glueMap ? glueMap.get(node.glueBatchId) : undefined;
        const glueStale = !!node.adhesive && (!glueBatch || !isGlueUsable(glueBatch)) && !isInvalid && !isNeedInfo;
        const potLeft = glueBatch && glueBatch.status === 'active' ? potLifeLeftMin(glueBatch) : undefined;

        return (
          <Box key={node.id} sx={{ display: 'flex', gap: 1.5 }} data-testid={`proc-node-${node.seq}`}>
            <Stack alignItems="center" sx={{ pt: 0.5 }}>
              {isDone ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : isInvalid ? (
                <CancelScheduleSendIcon color="error" fontSize="small" />
              ) : isNeedInfo ? (
                <WarningAmberIcon color="warning" fontSize="small" />
              ) : (
                <RadioButtonUncheckedIcon color={node.state === 'rolledback' ? 'error' : 'disabled'} fontSize="small" />
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
                bgcolor: isInvalid ? '#fdecea' : isNeedInfo ? '#fff4e5' : undefined,
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                <Chip size="small" label={`#${node.seq}`} color="primary" variant="outlined" />
                <Typography variant="subtitle2" fontWeight={700}>
                  {node.stepType} · {node.nodeName}
                </Typography>
                <Chip
                  size="small"
                  data-testid={`proc-state-${node.seq}`}
                  label={STATE_LABEL[state]}
                  color={isDone ? 'success' : isInvalid || node.state === 'rolledback' ? 'error' : isNeedInfo ? 'warning' : 'default'}
                />
                {node.adhesive ? (
                  <Tooltip title={glueBatch ? `关联胶液批次 ${glueBatch.lotNo}` : '未关联配液批次'}>
                    <Chip
                      size="small"
                      variant="outlined"
                      color={glueStale || isNeedInfo ? 'warning' : 'default'}
                      icon={<ScienceIcon />}
                      label={
                        glueBatch
                          ? `${glueBatch.lotNo} · 余 ${glueBatch.qty} ml${potLeft !== undefined ? ` · ${potLeft >= 60 ? `适用期剩 ${Math.floor(potLeft / 60)}h` : '即将到期'}` : ''}`
                          : '缺配液批次'
                      }
                    />
                  </Tooltip>
                ) : null}
                <Typography variant="caption" color="text.secondary">
                  耗时 {node.durationMin} min · 责任人 {node.operator}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {state === 'pending' && onFinish ? (
                  <Button
                    size="small"
                    variant="contained"
                    disabled={glueStale}
                    onClick={() => onFinish(node.id)}
                  >
                    完成节点
                  </Button>
                ) : null}
                {isInvalid && onReconfirm ? (
                  <Button size="small" color="error" variant="contained" onClick={() => onReconfirm(node)}>
                    重新确认
                  </Button>
                ) : null}
                {isNeedInfo && onSupplement ? (
                  <Button size="small" color="warning" variant="contained" onClick={() => onSupplement(node)}>
                    补录配液
                  </Button>
                ) : null}
                {isDone && onRollback ? (
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

              {isInvalid && node.invalidReason ? (
                <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 0.5 }}>
                  失效原因：{node.invalidReason}
                  {node.stateBeforeInvalid === 'done' ? '（原已完成结论已撤销，重新确认后恢复）' : ''}
                </Typography>
              ) : null}
              {isNeedInfo ? (
                <Typography variant="caption" color="warning.dark" sx={{ display: 'block', mt: 0.5 }}>
                  旧工序只登记了胶种「{node.adhesive}」，缺配液批号与领用量，不沿用「
                  {node.state === 'done' ? '已完成' : '待办'}」结论，补录后恢复。
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
                    配液批次：
                    {glueBatch
                      ? `${glueBatch.lotNo}（${glueBatch.adhesive} ${glueBatch.concentration}%）领 ${node.glueQty ?? 0} ml`
                      : node.glueLotNo
                        ? `${node.glueLotNo}（批次已不可查）`
                        : '待补'}
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
