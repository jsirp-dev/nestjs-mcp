import { Controller, Get, Module } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { ok: true } {
    return { ok: true };
  }
}

/** A module outside `CatsModule`'s closure. Imported only when the fixture asks for it. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
