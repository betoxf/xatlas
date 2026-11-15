/**
 * Work that must not interleave runs one at a time per key: a job's starts and final read, a
 * step's turn handling, a job's chair. Different keys run side by side. A failed item never
 * blocks the ones after it.
 */
export class SerialQueues {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
