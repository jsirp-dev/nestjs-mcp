import { Controller, Get, Module, Param, ParseIntPipe } from '@nestjs/common';

/** Calls itself `depth` times, then throws: a stack as deep as asked. */
function descend(depth: number): never {
  if (depth > 0) return descend(depth - 1);
  throw new Error('bottom reached');
}

/** Handlers that throw, for the stacks of failing steps. */
@Controller('failing')
export class FailingController {
  @Get('plain')
  plain(): never {
    throw new Error('plain failure');
  }

  @Get('deep/:depth')
  deep(@Param('depth', ParseIntPipe) depth: number): never {
    return descend(depth);
  }
}

/** Imported only when the fixture asks for it. */
@Module({ controllers: [FailingController] })
export class FailingModule {}
