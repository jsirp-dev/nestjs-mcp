import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NestMcpModule } from '@jsirp/nestjs-mcp';
import { MemoryLogger } from './support/memory-logger.js';
import { freePort } from './support/free-port.js';

/** The JSON a tool answered (the harness's `toolJson` lives next to the fixture, which needs the peer). */
function toolJson(result: unknown): unknown {
  const [block] = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(block!.text);
}

// The packages, as the inspector's guarded `require` sees them, are not installed.
jest.mock('@nestjs/event-emitter', () => {
  throw new Error("Cannot find module '@nestjs/event-emitter'");
});
jest.mock('@nestjs/schedule', () => {
  throw new Error("Cannot find module '@nestjs/schedule'");
});

/** Looks like the emitter `EventEmitterModule` provides, so only the missing peer keeps it out. */
@Injectable()
class EventEmitter2 {
  emit() {
    return false;
  }
  emitAsync() {
    return Promise.resolve([]);
  }
  listenerCount() {
    return 0;
  }
  listeners() {
    return [];
  }
}

/** Looks like the registry `ScheduleModule` provides, so only the missing peer keeps it out. */
@Injectable()
class SchedulerRegistry {
  getCronJobs() {
    return new Map();
  }
  getIntervals() {
    return [];
  }
  getTimeouts() {
    return [];
  }
  getInterval() {
    return undefined;
  }
  getTimeout() {
    return undefined;
  }
}

/** Carries the metadata the peers' decorators would write, so only the missing peers skip it. */
@Injectable()
class Jobs {
  tick() {}
}
Reflect.defineMetadata('EVENT_LISTENER_METADATA', [{ event: 'thing' }], Jobs.prototype.tick);
Reflect.defineMetadata('SCHEDULE_CRON_OPTIONS', { cronTime: '* * * * *' }, Jobs.prototype.tick);

@Module({ providers: [EventEmitter2, SchedulerRegistry, Jobs] })
class BareModule {}

describe('without the optional peers', () => {
  it('boots, registers no events_*, schedule_* or runs tool and app_info says they are off', async () => {
    const inspectorPort = await freePort();
    const app = await NestFactory.create(
      {
        module: BareModule,
        imports: [NestMcpModule.forRoot({ listen: { port: inspectorPort } })],
      },
      {
        snapshot: true,
        logger: new MemoryLogger(),
        abortOnError: false,
      },
    );
    await app.init();
    const client = new Client({ name: 'nestjs-mcp-test', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${inspectorPort}/`)),
      );
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('app_info');
      expect(names.filter((name) => name.startsWith('events_'))).toEqual([]);
      expect(names.filter((name) => name.startsWith('schedule_'))).toEqual([]);
      expect(names.filter((name) => name.startsWith('run'))).toEqual([]);
      const info = toolJson(await client.callTool({ name: 'app_info', arguments: {} })) as {
        tools: Record<string, boolean>;
      };
      expect(info.tools.events).toBe(false);
      expect(info.tools.schedule).toBe(false);
      expect(info.tools.runs).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(app.get(EventEmitter2), 'emit')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(app.get(Jobs), 'tick')).toBe(false);
    } finally {
      await client.close();
      await app.close();
    }
  });
});
