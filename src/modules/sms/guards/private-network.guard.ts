import { isIP } from 'node:net';

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

interface ParsedCidr extends ParsedIp {
  prefix: number;
}

/**
 * Restricts the internal send endpoint to callers inside a configured set of
 * private-network CIDRs (`PRIVATE_NETWORK_CIDRS`, comma-separated).
 *
 * The caller IP is read from the socket remote address (not `x-forwarded-for`)
 * so a spoofed header cannot bypass the check. IPv4 and IPv6 CIDR matching is
 * hand-rolled with BigInt to avoid an external dependency.
 */
@Injectable()
export class PrivateNetworkGuard implements CanActivate {
  private readonly allowedCidrs: ParsedCidr[];

  constructor(configService: ConfigService) {
    const raw = configService.getOrThrow<string>('PRIVATE_NETWORK_CIDRS');
    this.allowedCidrs = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => parseCidr(entry));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      socket?: { remoteAddress?: string | null };
      ip?: string;
    }>();

    const rawIp = request.socket?.remoteAddress ?? request.ip;
    const parsed = rawIp ? parseIp(rawIp) : null;

    if (parsed && this.allowedCidrs.some((cidr) => matches(parsed, cidr))) {
      return true;
    }

    throw new ForbiddenException('Caller is not within an allowed private network');
  }
}

function parseCidr(entry: string): ParsedCidr {
  const [address, prefixText] = entry.split('/');
  const parsed = parseIp(address ?? '');
  if (!parsed) {
    throw new Error(`Invalid CIDR entry: ${entry}`);
  }

  const maxPrefix = parsed.version === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`Invalid CIDR prefix: ${entry}`);
  }

  return { ...parsed, prefix };
}

function parseIp(address: string): ParsedIp | null {
  const withoutZone = address.split('%')[0] ?? '';

  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) to plain IPv4.
  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(withoutZone);
  const candidate = mappedMatch?.[1] ?? withoutZone;

  const version = isIP(candidate);
  if (version === 4) {
    return { version: 4, value: ipv4ToBigInt(candidate) };
  }
  if (version === 6) {
    return { version: 6, value: ipv6ToBigInt(candidate) };
  }
  return null;
}

function ipv4ToBigInt(address: string): bigint {
  return address
    .split('.')
    .reduce((accumulator, octet) => (accumulator << 8n) + BigInt(Number(octet)), 0n);
}

function ipv6ToBigInt(address: string): bigint {
  const [head, tail] = address.split('::');
  const headGroups = head ? head.split(':').filter((group) => group.length > 0) : [];
  const tailGroups = tail === undefined ? [] : tail.split(':').filter((group) => group.length > 0);

  const missing = 8 - (headGroups.length + tailGroups.length);
  const groups = [...headGroups, ...Array<string>(Math.max(missing, 0)).fill('0'), ...tailGroups];

  return groups.reduce(
    (accumulator, group) => (accumulator << 16n) + BigInt(parseInt(group, 16)),
    0n,
  );
}

function matches(ip: ParsedIp, cidr: ParsedCidr): boolean {
  if (ip.version !== cidr.version) {
    return false;
  }

  const totalBits = ip.version === 4 ? 32 : 128;
  const hostBits = BigInt(totalBits - cidr.prefix);
  const mask = hostBits === 0n ? (1n << BigInt(totalBits)) - 1n : ~((1n << hostBits) - 1n);

  return (ip.value & mask) === (cidr.value & mask);
}
