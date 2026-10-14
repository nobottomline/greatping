import { describe, expect, it } from 'vitest';
import {
  buildCodeLink,
  buildPairDeepLink,
  buildSchemeCodeLink,
  codeLinkKindOf,
  parseCodeLink,
} from '../src';

describe('code links', () => {
  it('puts the code in the fragment of a site link', () => {
    expect(buildPairDeepLink('K7QM-X2ZP')).toBe('https://greatping.com/p#K7QMX2ZP');
    expect(buildCodeLink('link', 'k7qmx2zp')).toBe('https://greatping.com/l#K7QMX2ZP');
    // Nothing of the code may sit where a browser sends it to the server.
    const url = new URL(buildPairDeepLink('K7QM-X2ZP'));
    expect(url.pathname + url.search).toBe('/p');
  });

  it('fits a version 2 QR code (32 bytes in byte mode at level L)', () => {
    expect(buildCodeLink('pair', 'ABCD-EFGH')).toHaveLength(32);
    expect(buildCodeLink('link', 'ABCD-EFGH')).toHaveLength(32);
  });

  it('still builds the older scheme link', () => {
    expect(buildSchemeCodeLink('link', 'k7qmx2zp')).toBe('greatping://link?code=K7QM-X2ZP');
  });

  it('refuses to build a link for anything but a code', () => {
    for (const bad of ['', 'K7QM', 'K7QM-X2ZP0', 'K7QM-X2Z1', 'K7QM X2ZP', 'K7QM-X2Z/'])
      expect(() => buildCodeLink('pair', bad)).toThrow();
  });

  it('reads back what it builds', () => {
    for (const kind of ['pair', 'link'] as const) {
      expect(parseCodeLink(buildCodeLink(kind, 'ABCD-EFGH'))).toEqual({ kind, code: 'ABCDEFGH' });
      expect(parseCodeLink(buildSchemeCodeLink(kind, 'ABCD-EFGH'))).toEqual({
        kind,
        code: 'ABCDEFGH',
      });
    }
  });

  it('accepts the forms a scanner or the system may hand over', () => {
    for (const link of [
      'https://greatping.com/p#K7QMX2ZP',
      'https://greatping.com/p#k7qmx2zp',
      'https://greatping.com/p#K7QM-X2ZP',
      'HTTPS://GREATPING.COM/p#K7QMX2ZP',
      '  https://greatping.com/p#K7QMX2ZP\n',
      'greatping://pair?code=K7QM-X2ZP',
      'greatping://pair?code=k7qmx2zp',
      'greatping-qa://pair?code=K7QMX2ZP',
      'greatping:///pair?code=K7QM-X2ZP',
    ])
      expect(parseCodeLink(link), link).toEqual({ kind: 'pair', code: 'K7QMX2ZP' });
  });

  it('rejects look-alike hosts, extra parts and wrong codes', () => {
    for (const link of [
      'http://greatping.com/p#K7QMX2ZP',
      'https://www.greatping.com/p#K7QMX2ZP',
      'https://greatping.com.evil.example/p#K7QMX2ZP',
      'https://evil.example/greatping.com/p#K7QMX2ZP',
      'https://greatping.com@evil.example/p#K7QMX2ZP',
      'https://user@greatping.com/p#K7QMX2ZP',
      'https://greatping.com:8443/p#K7QMX2ZP',
      'https://greatping.com/p/x#K7QMX2ZP',
      'https://greatping.com/p/#K7QMX2ZP',
      'https://greatping.com/P#K7QMX2ZP',
      'HTTPS://GREATPING.COM/P#K7QMX2ZP',
      'https://greatping.com/p?code=K7QMX2ZP',
      'https://greatping.com/p?x=1#K7QMX2ZP',
      'https://greatping.com/p#code=K7QMX2ZP',
      'https://greatping.com/p#K7QMX2ZP#',
      'https://greatping.com/p#K7QM--X2ZP',
      'https://greatping.com/p#-K7QMX2ZP',
      'https://greatping.com/p#K7QMX2Z',
      'https://greatping.com/p#K7QMX2ZP0',
      'https://greatping.com/p#K7QMX2Z1',
      'https://greatping.com/p#K7QM%58X2ZP',
      'https://greatping.com/p#',
      'https://greatping.com/p',
      'https://greatping.com/pair#K7QMX2ZP',
      'https://greatping.com/x#K7QMX2ZP',
      'https://greatping.com/#K7QMX2ZP',
      'greatping://pair?code=K7QM-X2ZP&code=ABCD-EFGH',
      'greatping://pair?code=K7QM-X2ZP#x',
      'greatping://pair',
      'greatping://join?code=K7QM-X2ZP',
      'evil://pair?code=K7QM-X2ZP',
      'K7QM-X2ZP',
      '',
    ])
      expect(parseCodeLink(link), link).toBeNull();
  });

  it('recognises the code pages with or without a code', () => {
    expect(codeLinkKindOf('https://greatping.com/p')).toBe('pair');
    expect(codeLinkKindOf('https://greatping.com/l/#nonsense')).toBe('link');
    expect(codeLinkKindOf('https://greatping.com/docs')).toBeNull();
    expect(codeLinkKindOf('https://greatping.com/pair')).toBeNull();
    expect(codeLinkKindOf('https://greatping.com/P')).toBeNull();
    expect(codeLinkKindOf('https://greatping.com.evil.example/p')).toBeNull();
    expect(codeLinkKindOf('greatping://pair?code=K7QM-X2ZP')).toBeNull();
  });
});
