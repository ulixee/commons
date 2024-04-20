// eslint-disable-next-line max-classes-per-file
import { inspect } from 'util';
import ILog, { ILogData } from '../interfaces/ILog';

declare global {
  function UlixeeLogCreator(module: NodeModule): {
    log: ILog;
  };

  // eslint-disable-next-line no-var,vars-on-top
  var UlxLogPrototype: Log;
  // eslint-disable-next-line no-var,vars-on-top
  var UlxLogFilters: any;
  // eslint-disable-next-line no-var,vars-on-top
  var UlxLoggerSessionIdNames: Map<string, string>;
  // eslint-disable-next-line no-var,vars-on-top
  var UlxSubscriptions: Map<number, (log: ILogEntry) => any>;
}

const hasBeenLoggedSymbol = Symbol.for('UlxHasBeenLogged');

global.UlxLogFilters ??= {
  envValue: null as string,
  active: [] as RegExp[],
  skip: [] as RegExp[],
  namespaces: { active: new Set<string>(), inactive: new Set<string>() },
  enabledNamesCache: {} as { [namespace: string]: boolean },
};

const logFilters = global.UlxLogFilters;

let logId = 0;
class Log implements ILog {
  public readonly level: LogLevel;
  public useColors =
    process.env.NODE_DISABLE_COLORS !== 'true' && process.env.NODE_DISABLE_COLORS !== '1';

  public readonly boundContext: any = {};
  private readonly module: string;
  private logtimeById: { [parentId: number]: number } = {};

  constructor(module: NodeModule, boundContext?: any) {
    this.module = module ? extractPathFromModule(module) : '';
    if (boundContext) this.boundContext = boundContext;
    this.level = isEnabled(this.module) ? 'stats' : 'error';
  }

  public stats(action: string, data?: ILogData): number {
    return this.log('stats', action, data);
  }

  public info(action: string, data?: ILogData): number {
    return this.log('info', action, data);
  }

  public warn(action: string, data?: ILogData): number {
    return this.log('warn', action, data);
  }

  public error(action: string, data?: ILogData | { error: Error }): number {
    return this.log('error', action, data);
  }

  public createChild(module, boundContext?: any): ILog {
    const Constructor = this.constructor;
    // @ts-ignore
    return new Constructor(module, {
      ...this.boundContext,
      ...boundContext,
    });
  }

  public flush(): void {
    // no-op
  }

  protected logToConsole(level: LogLevel, entry: ILogEntry): void {
    const printablePath = entry.module.replace('.js', '').replace('.ts', '').replace('build/', '');

    const { error, printData } = translateToPrintable(entry.data);

    if (level === 'warn' || level === 'error') {
      printData.sessionId = entry.sessionId;
      printData.sessionName = loggerSessionIdNames.get(entry.sessionId) ?? undefined;
    }

    const params = Object.keys(printData).length ? [printData] : [];
    if (error) params.push(error);

    const millisAddon = entry.millis ? ` ${entry.millis}ms` : '';
    // eslint-disable-next-line no-console
    console.log(
      `${entry.timestamp.toISOString()} ${entry.level.toUpperCase()} [${printablePath}] ${
        entry.action
      }${millisAddon}`,
      ...params.map(x => inspect(x, false, null, this.useColors)),
    );
  }

  private log(level: LogLevel, action: string, data?: ILogData | any): number {
    let logData: object;
    let sessionId: string = this.boundContext.sessionId;
    let parentId: number;
    const mergedData = { ...data, context: this.boundContext };
    if (mergedData) {
      for (const [key, val] of Object.entries(mergedData)) {
        if (key === 'parentLogId') parentId = val as number;
        else if (key === 'sessionId') sessionId = val as string;
        else {
          if (!logData) logData = {};
          logData[key] = val;
        }
      }
    }
    logId += 1;
    const id = logId;
    const timestamp = new Date();
    const now = timestamp.getTime();
    const startTime = parentId ? this.logtimeById[parentId] : now;
    this.logtimeById[id] = now;
    const entry: ILogEntry = {
      id,
      sessionId,
      parentId,
      timestamp,
      millis: now - startTime,
      action,
      data: logData,
      level,
      module: this.module,
    };
    if (logLevels[level] >= logLevels[this.level]) {
      this.logToConsole(level, entry);
    }
    LogEvents.broadcast(entry);
    return id;
  }
}

function translateValueToPrintable(key: string, value: any, depth = 0): any {
  if (value === undefined || value === null) return;

  if (key === 'password' || key === 'suri') {
    return '********';
  }

  if (value instanceof Error) {
    return value.toString();
  }
  if (value instanceof RegExp) {
    return `/${value.source}/${value.flags}`;
  }
  if (value instanceof BigInt || typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (Buffer.isBuffer(value)) {
    if ((value as Buffer).length <= 256) return `b64\\${value.toString('base64')}`;
    return `<Buffer: ${(value as Buffer).byteLength} bytes>`;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (depth > 2) return value;

  if ((value as any).toJSON) {
    return (value as any).toJSON();
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((x, i) => translateValueToPrintable(i as any, x, depth + 1));
    }
    const result: any = {};
    for (const [subKey, subValue] of Object.entries(value)) {
      result[subKey] = translateValueToPrintable(subKey, subValue, depth + 1);
    }
    return result;
  }
}

export function translateToPrintable(
  data: any,
  result?: { error?: Error; printData: any },
): { error?: Error; printData: any } {
  result ??= { printData: {} };
  const { printData } = result;
  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Error) {
      Object.defineProperty(value, hasBeenLoggedSymbol, {
        enumerable: false,
        value: true,
      });
      result.error = value;
      continue;
    }
    if (key === 'error') {
      if (typeof value === 'object') {
        const { message, ...rest } = value as any;
        result.error = new Error(message);
        if ('stack' in value) result.error.stack = (value as any).stack;
        if ('name' in value) result.error.name = (value as any).name;
        Object.assign(result.error, rest);
      } else if (typeof value === 'string') {
        result.error = new Error(value as string);
      }
      continue;
    }

    const printable = translateValueToPrintable(key, value);
    if (printable === null || printable === undefined) continue;
    printData[key] = printable;
  }
  return result;
}

const logLevels = { stats: 0, info: 1, warn: 2, error: 3 };


if (!global.UlixeeLogCreator) {
  global.UlixeeLogCreator = (module: NodeModule): { log: ILog } => {
    const log: ILog = new Log(module);

    // This code ensures a single version of Log is used across all @ulixee/commons that are loaded into memory.
    // We don't update it if an injected logger is used.
    global.UlxLogPrototype ??= Log.prototype;
    Object.setPrototypeOf(log, global.UlxLogPrototype);

    return {
      log,
    };
  };
}

export default function logger(module: NodeModule): ILogBuilder {
  return global.UlixeeLogCreator(module);
}

global.UlxLoggerSessionIdNames ??= new Map<string, string>();
global.UlxSubscriptions ??= new Map();
const loggerSessionIdNames = global.UlxLoggerSessionIdNames;

class LogEvents {
  private static subscriptions = global.UlxSubscriptions;

  public static unsubscribe(subscriptionId: number): void {
    LogEvents.subscriptions.delete(subscriptionId);
  }

  public static subscribe(onLogFn: (log: ILogEntry) => any): number {
    const id = LogEvents.subscriptions.size + 1;
    LogEvents.subscriptions[id] = onLogFn;
    return id;
  }

  public static broadcast(entry: ILogEntry): void {
    LogEvents.subscriptions.forEach(x => x(entry));
  }
}

global.UlixeeLogInstances ??= { Log, LogEvents };
export { Log, LogEvents, loggerSessionIdNames, hasBeenLoggedSymbol };

export function injectLogger(builder: (module: NodeModule) => ILogBuilder): void {
  global.UlixeeLogCreator = builder;
}

export interface ILogEntry {
  id: number;
  timestamp: Date;
  action: string;
  module: string;
  sessionId?: string;
  parentId?: number;
  data?: any;
  level: LogLevel;
  millis?: number;
}

type LogLevel = keyof typeof logLevels;

interface ILogBuilder {
  log: ILog;
}

const moduleNamesByPath: { [fullPath: string]: string } = {};
function extractPathFromModule(module: NodeModule): string {
  const fullPath = typeof module === 'string' ? module : module.filename || module.id || '';
  if (!moduleNamesByPath[fullPath]) {
    moduleNamesByPath[fullPath] = fullPath
      .replace(/^(.*)[/\\]unblocked[/\\](.+)$/, '$2')
      .replace(/^(.*)[/\\]ulixee[/\\](.+)$/, '$2')
      .replace(/^(.*)[/\\]payments[/\\](.+)$/, '$2')
      .replace(/^(.*)[/\\]@ulixee[/\\](.+)$/, '$2')
      .replace(/^(.*)[/\\]commons[/\\](.+)$/, '$2')
      .replace(/^.*[/\\]packages[/\\](.+)$/, '$1');
  }
  return moduleNamesByPath[fullPath];
}

/// LOG FILTERING //////////////////////////////////////////////////////////////////////////////////////////////////////

export function registerNamespaceMapping(
  onNamespaceFn: (namespace: string, active: RegExp[], skip: RegExp[]) => void,
): void {
  loadNamespaces(process.env.DEBUG);
  for (const ns of logFilters.namespaces.active) {
    onNamespaceFn(ns, logFilters.active, logFilters.skip);
  }
}

function isEnabled(modulePath: string): boolean {
  if (
    process.env.ULX_DEBUG === '1' ||
    process.env.ULX_DEBUG === 'true' ||
    process.env.ULX_DEBUG === '*'
  )
    return true;

  if (modulePath in logFilters.enabledNamesCache) return logFilters.enabledNamesCache[modulePath];

  if (logFilters.namespaces.active.has('*')) return true;

  for (const ns of logFilters.skip) {
    if (ns.test(modulePath)) {
      logFilters.enabledNamesCache[modulePath] = false;
      return false;
    }
  }

  for (const ns of logFilters.active) {
    if (ns.test(modulePath)) {
      logFilters.enabledNamesCache[modulePath] = true;
      return true;
    }
  }

  logFilters.enabledNamesCache[modulePath] = false;
  return false;
}

function loadNamespaces(namespaces: string): void {
  if (logFilters.envValue === namespaces) return;

  namespaces ??= '';
  logFilters.envValue = namespaces;
  const split = namespaces.split(/[\s,]+/).map(x => x.trim());

  for (const part of split) {
    if (!part) continue;

    if (part[0] === '-') {
      logFilters.namespaces.inactive.add(part.slice(1));
    } else {
      logFilters.namespaces.active.add(part);
      if (part === 'ulx*' || part === 'ulx:*') logFilters.namespaces.active.add('*');
    }
  }
}

registerNamespaceMapping((ns, active, skip) => {
  if (ns.includes('ulx:*') || ns.includes('ulx*') || ns === '*') {
    active.push(/.*/);
  } else if (ns === 'ulx') {
    active.push(
      /hero[/-].*/,
      /agent\/.*/,
      /plugins\/.*/,
      /net\/.*/,
      /cloud\/.*/,
      /datastore[/-].*/,
      /mainchain[/-].*/,
      /sidechain[/-].*/,
      /ramps[/-].*/,
    );
    skip.push(/desktop[/-]?.*/, /DevtoolsSessionLogger/);
  } else if (ns.includes('ulx:desktop')) {
    active.push(/desktop[/-]?.*/);
  } else if (ns.includes('ulx:mitm')) {
    active.push(/agent[/-]mitm.*/);
  } else if (ns.includes('ulx:devtools')) {
    active.push(/DevtoolsSessionLogger/);
  } else if (ns.includes('hero')) {
    active.push(/^hero[/-].*/, /net\/.*/);
  } else if (ns.includes('datastore')) {
    active.push(/^datastore[/-].*/, /net\/.*/);
  }
});
