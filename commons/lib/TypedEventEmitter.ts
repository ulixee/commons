import { EventEmitter } from 'events';
import ITypedEventEmitter from '../interfaces/ITypedEventEmitter';
import { IBoundLog } from '../interfaces/ILog';
import IPendingWaitEvent, { CanceledPromiseError } from '../interfaces/IPendingWaitEvent';
import { createPromise } from './utils';
import IRegisteredEventListener from '../interfaces/IRegisteredEventListener';

export default class TypedEventEmitter<T> extends EventEmitter implements ITypedEventEmitter<T> {
  public storeEventsWithoutListeners = false;
  public EventTypes: T;

  public onEventListenerAdded?: <K extends keyof T & (string | symbol)>(event: K) => void;

  #logger?: IBoundLog;

  private pendingIdCounter = 0;
  private pendingWaitEventsById = new Map<number, IPendingWaitEvent>();

  private eventsToLog = new Set<string | symbol>();
  private storedEventsByType = new Map<keyof T & (string | symbol), any[]>();
  private reemitterCountByEventType: { [eventType: string]: number } = {};

  constructor() {
    super();
    this.defaultErrorLogger = this.defaultErrorLogger.bind(this);
    if ('captureRejections' in this) (this as any).captureRejections = true;
    // add an error logger as a backup
    super.on('error', this.defaultErrorLogger);
  }

  public cancelPendingEvents(message?: string, excludeEvents?: (keyof T & string)[]): void {
    this.storedEventsByType.clear();
    const events = [...this.pendingWaitEventsById.values()];
    this.pendingWaitEventsById.clear();
    while (events.length) {
      const event = events.shift();
      if (excludeEvents && excludeEvents.includes(event.event as any)) {
        this.pendingWaitEventsById.set(event.id, event);
        continue;
      }
      if (message) event.error.message = message;
      // catch unhandled rejections here: eslint-disable-next-line promise/no-promise-in-callback
      event.resolvable.promise.catch(() => null);
      event.resolvable.reject(event.error);
    }
  }

  public setEventsToLog<K extends keyof T & (string | symbol)>(
    logger: IBoundLog,
    events: K[],
  ): void {
    this.#logger = logger;
    this.eventsToLog = new Set<string | symbol>(events);
  }

  public waitOn<K extends keyof T & (string | symbol)>(
    eventType: K,
    listenerFn?: (this: this, event?: T[K]) => boolean,
    timeoutMillis = 30e3,
  ): Promise<T[K]> {
    const promise = createPromise<T[K]>(
      timeoutMillis ?? 30e3,
      `Timeout waiting for ${String(eventType)}`,
    );

    this.pendingIdCounter += 1;
    const id = this.pendingIdCounter;

    this.pendingWaitEventsById.set(id, {
      id,
      event: eventType,
      resolvable: promise,
      error: new CanceledPromiseError(`Event (${String(eventType)}) canceled`),
    });
    const messageId = this.#logger?.stats?.(`waitOn:${String(eventType)}`, {
      timeoutMillis,
    });
    const callbackFn = (result: T[K]): void => {
      // give the listeners a second to register
      if (!listenerFn || listenerFn.call(this, result)) {
        this.#logger?.stats?.(`waitOn.resolve:${String(eventType)}`, {
          parentLogId: messageId,
        });
        promise.resolve(result);
      }
    };
    this.on(eventType, callbackFn);

    return promise.promise.finally(() => {
      this.off(eventType, callbackFn);
      this.pendingWaitEventsById.delete(id);
    });
  }

  public addEventEmitter<Y, K extends keyof T & keyof Y & (string | symbol)>(
    emitter: TypedEventEmitter<Y>,
    eventTypes: K[],
  ): IRegisteredEventListener[] {
    const listeners: IRegisteredEventListener[] = [];
    for (const eventName of eventTypes) {
      const handler = emitter.emit.bind(emitter, eventName as any);
      listeners.push({ handler, eventName, emitter: this });
      super.on(eventName, handler);
      this.reemitterCountByEventType[eventName as string] ??= 0;
      this.reemitterCountByEventType[eventName as string] += 1;
    }
    return listeners;
  }

  public override on<K extends keyof T & (string | symbol)>(
    eventType: K,
    listenerFn: (this: this, event?: T[K]) => any,
    includeUnhandledEvents = false,
  ): this {
    super.on(eventType, listenerFn);
    // if we're adding an error logger, we can remove the default logger
    if (eventType === 'error' && listenerFn !== (this.defaultErrorLogger as any)) {
      super.off('error', this.defaultErrorLogger);
    }
    this.onEventListenerAdded?.(eventType);
    return this.replayOrClearMissedEvents(includeUnhandledEvents, eventType);
  }

  public override off<K extends keyof T & (string | symbol)>(
    eventType: K,
    listenerFn: (this: this, event?: T[K]) => any,
  ): this {
    // if we're removing an error logger, we should add back the default logger
    if (
      eventType === 'error' &&
      listenerFn !== (this.defaultErrorLogger as any) &&
      super.listenerCount(eventType) === 1
    ) {
      super.on('error', this.defaultErrorLogger);
    }
    return super.off(eventType, listenerFn);
  }

  public override once<K extends keyof T & (string | symbol)>(
    eventType: K,
    listenerFn: (this: this, event?: T[K]) => any,
    includeUnhandledEvents = false,
  ): this {
    super.once(eventType, listenerFn);
    this.onEventListenerAdded?.(eventType);
    return this.replayOrClearMissedEvents(includeUnhandledEvents, eventType);
  }

  public override emit<K extends keyof T & (string | symbol)>(
    eventType: K,
    event?: T[K],
    sendInitiator?: object,
  ): boolean {
    const listeners = super.listenerCount(eventType);
    if (this.storeEventsWithoutListeners && !listeners) {
      if (!this.storedEventsByType.has(eventType)) this.storedEventsByType.set(eventType, []);
      this.storedEventsByType.get(eventType).push(event);
      return false;
    }
    this.logEvent(eventType, event);
    if (sendInitiator) return super.emit(eventType, event, sendInitiator);
    return super.emit(eventType, event);
  }

  public override addListener<K extends keyof T & (string | symbol)>(
    eventType: K,
    listenerFn: (this: this, event?: T[K]) => any,
    includeUnhandledEvents = false,
  ): this {
    return this.on(eventType, listenerFn, includeUnhandledEvents);
  }

  public override removeListener<K extends keyof T & (string | symbol)>(
    eventType: K,
    listenerFn: (this: this, event?: T[K]) => any,
  ): this {
    return super.removeListener(eventType, listenerFn);
  }

  public override prependListener<K extends keyof T & (string | symbol)>(
    eventType: K,
    listenerFn: (this: this, event?: T[K]) => void,
    includeUnhandledEvents = false,
  ): this {
    super.prependListener(eventType, listenerFn);
    return this.replayOrClearMissedEvents(includeUnhandledEvents, eventType);
  }

  public override prependOnceListener<K extends keyof T & (string | symbol)>(
    eventType: K,
    listenerFn: (this: this, event?: T[K]) => void,
    includeUnhandledEvents = false,
  ): this {
    super.prependOnceListener(eventType, listenerFn);
    return this.replayOrClearMissedEvents(includeUnhandledEvents, eventType);
  }

  protected defaultErrorLogger(this: this, error: Error): void {
    if (this.#logger) this.#logger.error('EventListenerError', error);
    else console.warn('EventListenerError', error);
  }

  private replayOrClearMissedEvents<K extends keyof T & (string | symbol)>(
    shouldReplay: boolean,
    eventType: K,
  ): this {
    const events = this.storedEventsByType.get(eventType);
    if (!events || !events.length) return this;
    this.storedEventsByType.delete(eventType);
    if (shouldReplay) {
      for (const event of events) {
        this.logEvent(eventType, event);
        super.emit(eventType, event);
      }
    }
    return this;
  }

  private logEvent<K extends keyof T & (string | symbol)>(eventType: K, event?: T[K]): void {
    if (this.eventsToLog.has(eventType)) {
      let data: any = event;
      if (eventType) {
        if (typeof event === 'object') {
          if ((event as any).toJSON) {
            data = (event as any).toJSON();
          } else {
            data = { ...event };
            for (const [key, val] of Object.entries(data)) {
              if (!val) continue;
              if ((val as any).toJSON) {
                data[key] = (val as any).toJSON();
              }
            }
          }
        }
      }
      this.#logger?.stats?.(`emit:${String(eventType)}`, data);
    }
  }
}
