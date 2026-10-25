import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OwnersService } from '../owners/owners.service.js';

export interface Cat {
  id: number;
  name: string;
  owner: string | null;
}

@Injectable()
export class CatsService {
  private readonly cats = [
    { id: 1, name: 'Tom', ownerId: 1 },
    { id: 2, name: 'Felix', ownerId: 2 },
  ];

  constructor(private readonly owners: OwnersService) {}

  findAll(): Cat[] {
    return this.cats.map((cat) => this.present(cat));
  }

  findById(id: number): Cat | undefined {
    const cat = this.cats.find((candidate) => candidate.id === id);
    return cat ? this.present(cat) : undefined;
  }

  /** Listens only when the app imports `EventEmitterModule`; the payload is never recorded. */
  @OnEvent('cat.adopted')
  onCatAdopted(_event: { id: number; owner: string }): void {}

  /** A wildcard pattern: it matches `cat.adopted` only when the emitter has `wildcard: true`. */
  @OnEvent('cat.*', { async: true })
  onAnyCatEvent(_event: unknown): void {}

  private present(cat: { id: number; name: string; ownerId: number }): Cat {
    return { id: cat.id, name: cat.name, owner: this.owners.findById(cat.ownerId)?.name ?? null };
  }
}
