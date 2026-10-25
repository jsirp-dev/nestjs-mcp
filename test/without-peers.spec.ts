import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { NestMcpModule } from '@jsirp/nestjs-mcp';
import type { AddressInfo } from 'node:net';
import { MemoryLogger } from './support/memory-logger.js';

/** The JSON a tool answered (the harness's `toolJson` lives next to the fixture, which needs the peer). */
function toolJson(result: unknown): unknown {
  const [block] = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(block!.text);
}

// The package, as the inspector's guarded `require` sees it, is not installed.
jest.mock('@nestjs/event-emitter', () => {
  throw new Error("Cannot find module '@nestjs/event-emitter'");
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

@Module({ imports: [NestMcpModule.forRoot()], providers: [EventEmitter2] })
class BareModule {}

describe('without the optional peers', () => {
  it('boots, registers no events_* tool and app_info says events is off', async () => {
    const app = await NestFactory.create(BareModule, {
      snapshot: true,
      logger: new MemoryLogger(),
      abortOnError: false,
    });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    const client = new Client({ name: 'nestjs-mcp-test', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/_mcp`)),
      );
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('app_info');
      expect(names.filter((name) => name.startsWith('events_'))).toEqual([]);
      const info = toolJson(await client.callTool({ name: 'app_info', arguments: {} })) as {
        tools: Record<string, boolean>;
      };
      expect(info.tools.events).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(app.get(EventEmitter2), 'emit')).toBe(false);
    } finally {
      await client.close();
      await app.close();
    }
  });
});
