import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('constructs a PostgreSQL-backed Prisma client from DATABASE_URL', () => {
    expect(() => new PrismaService()).not.toThrow();
  });
});
