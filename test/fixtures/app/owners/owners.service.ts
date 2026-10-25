import { Injectable } from '@nestjs/common';

export interface Owner {
  id: number;
  name: string;
}

@Injectable()
export class OwnersService {
  private readonly owners: Owner[] = [
    { id: 1, name: 'Ada' },
    { id: 2, name: 'Grace' },
  ];

  findById(id: number): Owner | undefined {
    return this.owners.find((owner) => owner.id === id);
  }
}
