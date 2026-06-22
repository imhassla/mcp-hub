import { EventEmitter } from 'events';
import type { StreamEvent } from './types.js';

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export type StreamEventNotification = Pick<StreamEvent, 'id' | 'stream' | 'target_agent_id'>;

export function notifyStreamEvent(event: StreamEventNotification): void {
  emitter.emit('stream_event', event);
}

export function onStreamEvent(listener: (event: StreamEventNotification) => void): () => void {
  emitter.on('stream_event', listener);
  return () => emitter.off('stream_event', listener);
}
