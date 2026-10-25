/** An entry as the buffer keeps it: what was pushed, numbered with a growing `seq` from 1. */
export type Sequenced<T> = { seq: number } & T;

/**
 * A fixed-size buffer that drops the oldest entry when full. `seq` never repeats and never goes
 * back, so a reader pages with "everything after the last `seq` I saw".
 */
export class RingBuffer<T extends object> {
  private readonly entries: Array<Sequenced<T>> = [];
  private start = 0;
  private seq = 0;

  constructor(readonly size: number) {}

  /** How many entries it holds now. */
  get length(): number {
    return this.entries.length;
  }

  /** The `seq` of the newest entry pushed; 0 before the first. */
  get lastSeq(): number {
    return this.seq;
  }

  push(value: T): Sequenced<T> {
    const entry = { seq: ++this.seq, ...value } as Sequenced<T>;
    if (this.entries.length < this.size) {
      this.entries.push(entry);
    } else {
      this.entries[this.start] = entry;
      this.start = (this.start + 1) % this.size;
    }
    return entry;
  }

  /** Every entry held, oldest first. */
  all(): Array<Sequenced<T>> {
    return [...this.entries.slice(this.start), ...this.entries.slice(0, this.start)];
  }

  /** The entries with a `seq` greater than the given one, oldest first. */
  since(seq: number): Array<Sequenced<T>> {
    return this.all().filter((entry) => entry.seq > seq);
  }

  /** The newest `n` entries, oldest first. */
  last(n: number): Array<Sequenced<T>> {
    return n <= 0 ? [] : this.all().slice(-n);
  }
}
