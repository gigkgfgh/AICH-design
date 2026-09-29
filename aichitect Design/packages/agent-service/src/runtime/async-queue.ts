/**
 * 轻量异步队列：adapter 事件 → 网关 SSE 的推拉通道。
 * 支持：push（追加事件）、next（异步取下一个）、close（终止 + 终值）、重放缓冲（已完成运行）。
 */

export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | null) => void> = [];
  private closed = false;
  private finalValue: T | null = null;
  /** R6-13：全量事件存档（push 即记录，与消费进度无关）——终态快照用，消除"终态收集与实时消费争抢单消费者队列"的竞态。 */
  private readonly transcript: T[] = [];

  /** 追加事件；关闭后忽略。 */
  push(item: T): void {
    if (this.closed) return;
    this.transcript.push(item);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  /** 关闭队列；finalValue 作为最后一次 next() 的返回值（done 事件的哨兵可省）。 */
  close(finalValue?: T): void {
    if (this.closed) return;
    this.closed = true;
    if (finalValue !== undefined) this.finalValue = finalValue;
    while (this.waiters.length > 0) {
      this.waiters.shift()!(null);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 已缓冲事件副本（回放已完成运行用）。 */
  replay(): T[] {
    return this.items.slice();
  }

  /** R6-13：已推送事件的全量快照（无论是否已被实时消费；终态缓存/回放以它为准）。 */
  snapshot(): T[] {
    return this.transcript.slice();
  }

  next(): Promise<T | null> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift()!);
    }
    if (this.closed) {
      return Promise.resolve(this.finalValue ?? null);
    }
    return new Promise<T | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = await this.next();
        return value === null ? { done: true, value: undefined as unknown as T } : { done: false, value };
      },
    };
  }
}

/** 顺序执行版（测试/单线程场景可用）：同步取队列中下一条或等待。 */
export function createAsyncQueue<T>(): AsyncQueue<T> {
  return new AsyncQueue<T>();
}