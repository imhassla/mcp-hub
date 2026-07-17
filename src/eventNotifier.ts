import { EventEmitter } from 'events';
import type { StreamEvent } from './types.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
let deferredNotifications: StreamEventNotification[] | null = null;
let transactionRollbackEffects: Array<() => void> | null = null;

export type StreamEventNotification = Pick<StreamEvent, 'id' | 'stream' | 'agent_id' | 'target_agent_id'>;

export function notifyStreamEvent(event: StreamEventNotification): void {
  if (deferredNotifications) {
    deferredNotifications.push(event);
    return;
  }
  emitter.emit('stream_event', event);
}

export function registerTransactionRollbackEffect(effect: () => void): boolean {
  if (!transactionRollbackEffects) return false;
  transactionRollbackEffects.push(effect);
  return true;
}

export function runWithDeferredStreamNotifications<T>(work: () => T): T {
  if (deferredNotifications) return work();

  const notifications: StreamEventNotification[] = [];
  const rollbackEffects: Array<() => void> = [];
  deferredNotifications = notifications;
  transactionRollbackEffects = rollbackEffects;
  let result: T;
  try {
    result = work();
  } catch (error) {
    deferredNotifications = null;
    transactionRollbackEffects = null;
    for (let index = rollbackEffects.length - 1; index >= 0; index -= 1) {
      try {
        rollbackEffects[index]();
      } catch {
        // Preserve the transaction error; rollback effects are best-effort cleanup only.
      }
    }
    throw error;
  }
  deferredNotifications = null;
  transactionRollbackEffects = null;
  for (const event of notifications) emitter.emit('stream_event', event);
  return result;
}

export function onStreamEvent(listener: (event: StreamEventNotification) => void): () => void {
  emitter.on('stream_event', listener);
  return () => emitter.off('stream_event', listener);
}
