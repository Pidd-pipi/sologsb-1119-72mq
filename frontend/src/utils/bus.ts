/**
 * 跨标签页数据变更通知：胶液领用成功 / 批次封档后通知其它标签页重新装载本地数据。
 * 优先用 BroadcastChannel；不支持时退化为 localStorage storage 事件（同源其它标签页可收到）。
 */
export type DataBusMessage = 'glue-changed';

const CHANNEL_NAME = 'gbfossilprep:data-bus';
const STORAGE_KEY = 'gbfossilprep:bus-tick';

let channel: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel(CHANNEL_NAME);
}

export function postDataChange(message: DataBusMessage): void {
  try {
    if (channel) {
      channel.postMessage(message);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ message, at: Date.now() }));
  } catch {
    /* 通知不可用时忽略，目标标签页定时巡检仍会兜底 */
  }
}

export function onDataChange(handler: (message: DataBusMessage) => void): () => void {
  let offStorage: (() => void) | null = null;
  if (channel) {
    const listener = (e: MessageEvent<DataBusMessage>) => handler(e.data);
    channel.addEventListener('message', listener);
    return () => channel?.removeEventListener('message', listener);
  }
  if (typeof window !== 'undefined') {
    const listener = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue) as { message?: DataBusMessage };
          if (parsed.message) handler(parsed.message);
        } catch {
          /* 忽略无法解析的旧值 */
        }
      }
    };
    window.addEventListener('storage', listener);
    offStorage = () => window.removeEventListener('storage', listener);
  }
  return () => offStorage?.();
}
