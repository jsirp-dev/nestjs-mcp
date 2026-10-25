import { Controller, Get, Module } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

@Controller('health')
export class HealthController {
  @Get()
  check(): { ok: true } {
    return { ok: true };
  }

  /** A listener outside `CatsModule`'s closure. */
  @OnEvent('app.ready')
  onAppReady(): void {}
}

/** A module outside `CatsModule`'s closure. Imported only when the fixture asks for it. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
