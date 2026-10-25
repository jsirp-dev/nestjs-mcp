import { Controller, Get, Logger, Module, Param, Query } from '@nestjs/common';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Handlers that log through Nest's `Logger` while they run. */
@Controller('logged')
export class LoggedController {
  private readonly logger = new Logger(LoggedController.name);

  /** Logs twice, across an await, and throws. */
  @Get('fail/:tag')
  async fail(@Param('tag') tag: string): Promise<never> {
    this.logger.log(`loading ${tag}`);
    await pause(1);
    this.logger.warn(`about to fail ${tag}`);
    throw new Error(`failed ${tag}`);
  }

  /** Logs `count` lines, `delay` ms apart, so concurrent requests interleave. */
  @Get('lines/:tag')
  async lines(
    @Param('tag') tag: string,
    @Query('count') count = '3',
    @Query('delay') delay = '0',
  ): Promise<{ lines: number }> {
    for (let index = 0; index < Number(count); index += 1) {
      if (Number(delay) > 0) await pause(Number(delay));
      this.logger.log(`${tag} line ${index}`);
    }
    return { lines: Number(count) };
  }
}

/** A controller that logs inside requests. Imported only when the fixture asks for it. */
@Module({ controllers: [LoggedController] })
export class LoggedModule {}
