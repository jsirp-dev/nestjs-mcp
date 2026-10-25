import { Controller, Get, Module, Param, ParseIntPipe } from '@nestjs/common';

/** Calls itself `depth` times, then throws: a stack as deep as asked. */
function descend(depth: number): never {
  if (depth > 0) return descend(depth - 1);
  throw new Error('bottom reached');
}

/** Calls of the getter on `FailingController.locals`'s local object: the inspector must make none. */
export const getterCalls = { count: 0 };

/** Handlers that throw, for the stacks of failing steps. */
@Controller('failing')
export class FailingController {
  @Get('plain')
  plain(): never {
    throw new Error('plain failure');
  }

  /** Throws with locals worth reading: a computed total, a 1 MB string, an object with a getter. */
  @Get('locals')
  locals(): never {
    const total = 41 + 1;
    const large = 'x'.repeat(1024 * 1024);
    const watched = {
      plain: 'kept',
      nested: { deeper: { deepest: { level: 3 } } },
      get counted(): number {
        getterCalls.count += 1;
        return getterCalls.count;
      },
    };
    throw new Error(`failed with ${total}, ${large.length}, ${watched.plain}`);
  }

  @Get('locals-async')
  async localsAsync(): Promise<never> {
    await Promise.resolve();
    const resumed = 'after await';
    throw new Error(`async failure ${resumed}`);
  }

  /** Throws and catches its own error, then answers: the app's own caught exceptions. */
  @Get('recovers')
  recovers(): string {
    try {
      const attempt = 'first';
      throw new Error(`could not ${attempt}`);
    } catch {
      return 'recovered';
    }
  }

  /** Catches `descend`'s error and throws the same one again. */
  @Get('rethrows')
  rethrows(): never {
    try {
      return descend(0);
    } catch (error) {
      const context = 'rethrown';
      if (context) throw error;
      throw new Error('unreachable');
    }
  }

  @Get('deep/:depth')
  deep(@Param('depth', ParseIntPipe) depth: number): never {
    return descend(depth);
  }
}

/** Imported only when the fixture asks for it. */
@Module({ controllers: [FailingController] })
export class FailingModule {}
