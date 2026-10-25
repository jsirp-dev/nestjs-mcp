import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard.js';
import { Cat, CatsService } from './cats.service.js';
import { NotFoundFilter } from './not-found.filter.js';
import { TimingInterceptor } from './timing.interceptor.js';

@Controller('cats')
@UseGuards(ApiKeyGuard)
@UseInterceptors(TimingInterceptor)
@UseFilters(NotFoundFilter)
export class CatsController {
  constructor(private readonly cats: CatsService) {}

  @Get()
  findAll(): Cat[] {
    return this.cats.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number): Cat {
    const cat = this.cats.findById(id);
    if (!cat) throw new NotFoundException(`Cat ${id} not found`);
    return cat;
  }
}
