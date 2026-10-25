import { Controller, Injectable, Logger, Module, Param, ParseIntPipe, Post } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, Interval, Timeout } from '@nestjs/schedule';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Jobs and listeners whose runs the tests read; each logs through Nest's `Logger`. */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  readonly marker = 'jobs';
  /** Payloads `onDone` received, to show the wrapper passes them through. */
  readonly received: unknown[] = [];

  /** Never due within a test: the tests fire it through the registry. */
  @Cron('0 5 1 1 *', { name: 'purge' })
  purge(): void {
    this.logger.log('purging');
    throw new Error('purge failed');
  }

  @Timeout('warm', 10)
  async warm(): Promise<void> {
    await delay(20);
    this.logger.log('warmed');
  }

  @Interval('beat', 30)
  beat(): void {}

  @OnEvent('job.failed')
  onFailed(): void {
    throw new Error('listener failed');
  }

  @OnEvent('job.failed.async')
  async onFailedAsync(): Promise<void> {
    await delay(1);
    throw new Error('async listener failed');
  }

  @OnEvent('job.strict', { suppressErrors: false })
  async onStrict(): Promise<void> {
    await delay(1);
    throw new TypeError('strict failed');
  }

  /** Called by eventemitter2 on a later tick (`setImmediate`), outside `emit` itself. */
  @OnEvent('job.later', { async: true })
  later(): void {
    this.logger.log('later');
  }

  @OnEvent('job.done')
  async onDone(payload: { n: number }): Promise<string> {
    this.received.push(payload);
    this.logger.log(`done ${payload.n}`);
    return `${this.marker}:${payload.n}`;
  }
}

/** Emits `job.done` while the request is traced. */
@Controller('jobs')
export class JobsController {
  constructor(private readonly events: EventEmitter2) {}

  @Post('done/:n')
  async done(@Param('n', ParseIntPipe) n: number): Promise<unknown[]> {
    return this.events.emitAsync('job.done', { n });
  }
}

/** Outside `CatsModule`'s closure. Imported only when the fixture asks for it. */
@Module({ controllers: [JobsController], providers: [JobsService] })
export class RunsModule {}
