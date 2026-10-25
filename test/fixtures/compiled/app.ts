import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestMcpModule } from '@jsirp/nestjs-mcp';

/**
 * An app the debug spec compiles for real (to `.js`, with or without a `.js.map`) and runs in a
 * child process, so its stacks are those of compiled code and nothing maps them but the inspector
 * or Node's own source maps. Ports come from the environment; `ready` on stdout once it listens.
 */
@Controller('boom')
class BoomController {
  @Get()
  boom(): never {
    throw new Error('compiled failure');
  }
}

@Module({
  imports: [
    NestMcpModule.forRoot({
      debug: true,
      listen: { host: '127.0.0.1', port: Number(process.env.INSPECTOR_PORT) },
    }),
  ],
  controllers: [BoomController],
})
class CompiledAppModule {}

async function main(): Promise<void> {
  const app = await NestFactory.create(CompiledAppModule, { logger: false });
  await app.listen(Number(process.env.APP_PORT), '127.0.0.1');
  process.stdout.write('ready\n');
}

void main();
