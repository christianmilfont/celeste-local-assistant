import { AssistantEvent, EventType } from './types';

type EventCallback = (event: AssistantEvent) => void | Promise<void>;

export class EventBus {
  private listeners: Map<EventType, Set<EventCallback>> = new Map();

  on(eventType: EventType, callback: EventCallback): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);
  }

  off(eventType: EventType, callback: EventCallback): void {
    const callbacks = this.listeners.get(eventType);
    if (callbacks) {
      callbacks.delete(callback);
    }
  }

  async emit(eventType: EventType, data?: any): Promise<void> {
    const event: AssistantEvent = {
      type: eventType,
      data,
      timestamp: new Date(),
    };

    const callbacks = this.listeners.get(eventType);
    if (callbacks) {
      const promises = Array.from(callbacks).map((callback) => callback(event));
      await Promise.allSettled(promises);
    }
  }

  removeAllListeners(eventType?: EventType): void {
    if (eventType) {
      this.listeners.delete(eventType);
    } else {
      this.listeners.clear();
    }
  }
}
