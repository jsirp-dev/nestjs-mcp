import { Inject, Injectable, NotFoundException, type CanActivate } from '@nestjs/common';
import { NEST_MCP_OPTIONS } from '../constants.js';
import type { ResolvedNestMcpOptions } from '../nest-mcp.options.js';

/**
 * Only for the `*Async` variants without a static `enabled`: the route exists before the factory
 * runs, so an instance the factory disables answers 404, as if it were not mounted.
 */
@Injectable()
export class EnabledGuard implements CanActivate {
  constructor(@Inject(NEST_MCP_OPTIONS) private readonly options: ResolvedNestMcpOptions) {}

  canActivate(): boolean {
    if (!this.options.enabled) throw new NotFoundException();
    return true;
  }
}
