import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

/** A stack in the shape `ConsoleLogger` recognises, fixed so tests can compare it. */
export const FIXTURE_STACK =
  'Error: litter box overflow\n    at LoggingService.onApplicationBootstrap (/app/cats/logging.service.ts:21:7)';

/** Writes, through Nest's `Logger`, one `warn` and one `error` with a stack at bootstrap. */
@Injectable()
export class LoggingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LoggingService.name);

  onApplicationBootstrap(): void {
    this.logger.warn('Cats are running low on food');
    this.logger.error('Litter box overflow', FIXTURE_STACK);
  }
}
