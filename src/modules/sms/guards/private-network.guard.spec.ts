import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrivateNetworkGuard } from './private-network.guard';

function createGuard(cidrs = '127.0.0.1/32,::1/128,10.0.0.0/8'): PrivateNetworkGuard {
  const configService = {
    getOrThrow: jest.fn(() => cidrs),
  } as unknown as ConfigService;

  return new PrivateNetworkGuard(configService);
}

function contextForIp(remoteAddress: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ socket: { remoteAddress } }),
    }),
  } as unknown as ExecutionContext;
}

describe('PrivateNetworkGuard', () => {
  it('allows an exact IPv4 host match', () => {
    expect(createGuard().canActivate(contextForIp('127.0.0.1'))).toBe(true);
  });

  it('allows an IPv4 address inside a wider CIDR', () => {
    expect(createGuard().canActivate(contextForIp('10.42.7.9'))).toBe(true);
  });

  it('allows an IPv4-mapped IPv6 loopback address', () => {
    expect(createGuard().canActivate(contextForIp('::ffff:127.0.0.1'))).toBe(true);
  });

  it('allows an IPv6 loopback match', () => {
    expect(createGuard().canActivate(contextForIp('::1'))).toBe(true);
  });

  it('denies an address outside every configured CIDR', () => {
    expect(() => createGuard().canActivate(contextForIp('203.0.113.5'))).toThrow(
      ForbiddenException,
    );
  });

  it('denies a request with no resolvable caller address', () => {
    expect(() => createGuard().canActivate(contextForIp(undefined))).toThrow(ForbiddenException);
  });
});
