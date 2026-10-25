import { Controller, Get, Module } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Timeout } from '@nestjs/schedule';

@Controller('health')
export class HealthController {
  @Get()
  check(): { ok: true } {
    return { ok: true };
  }

  /** A listener outside `CatsModule`'s closure. */
  @OnEvent('app.ready')
  onAppReady(): void {}

  /** A job outside `CatsModule`'s closure. */
  @Timeout('warmup', 3_600_000)
  warmup(): void {}
}

/** A module outside `CatsModule`'s closure. Imported only when the fixture asks for it. */
@Module({ controllers: [HealthController] })
export class HealthModule {}
