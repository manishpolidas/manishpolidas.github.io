import { EventEmitter } from 'node:events';
import type { LogEntry, TestSnapshot } from '../domain/types.js';

export type ServerEvent =
  | { type: 'test.created'; payload: TestSnapshot }
  | { type: 'test.update'; payload: TestSnapshot }
  | { type: 'test.finished'; payload: TestSnapshot }
  | { type: 'test.deleted'; payload: { testId: string } }
  | { type: 'test.log'; payload: LogEntry };

/** Fan-out of domain events to real-time transports (WebSocket). */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A dashboard with many tabs open is normal; avoid the default warning.
    this.emitter.setMaxListeners(100);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
