import { describe, expect, it } from 'vitest';
import {
  addMember,
  CeremonyError,
  createGenesis,
  finishCeremony,
  generateKeys,
  initiatorConfirmed,
  joinUserCode,
  manifestHash,
  newCodeHalf,
  respondToCeremony,
  splitUserCode,
  startCeremony,
} from '../src/crypto';

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const T0 = 1_790_000_000_000;

function setup(typedSecret?: string) {
  const phone = generateKeys(random);
  const mac = generateKeys(random);
  const genesis = createGenesis({
    account: 'acc_1',
    device: 'dev_phone',
    keys: phone.public,
    secret: phone.secret,
    createdAt: T0,
  });
  // Computer: draws the secret half and starts; the server only sees `lookup`.
  const secret = newCodeHalf(random);
  const code = joinUserCode('K7QM', secret);
  const start = startCeremony({
    kind: 'pair',
    sessionId: 'pair_1',
    secret,
    keys: mac.public,
    random,
  });
  // Phone: the user typed or scanned the code; it signs the version adding the
  // computer with the keys it received, and answers.
  const halves = splitUserCode(typedSecret ? `K7QM${typedSecret}` : code);
  if (!halves) throw new Error('code');
  const next = addMember(
    genesis,
    { id: 'dev_phone', secret: phone.secret },
    { kind: 'computer', id: 'mc_mac', ...start.keys },
    T0 + 1000,
  );
  const answer = respondToCeremony({
    kind: 'pair',
    sessionId: 'pair_1',
    secret: halves.secret,
    initiatorShare: start.share,
    initiatorKeys: start.keys,
    device: 'dev_phone',
    manifestHash: manifestHash(next),
    random,
  });
  const response = {
    share: answer.share,
    device: 'dev_phone',
    manifestHash: manifestHash(next),
    tag: answer.tag,
  };
  return { start, answer, response, mac, phone, secret };
}

describe('pairing ceremony', () => {
  it('confirms both sides with the same code', () => {
    const { start, answer, response } = setup();
    const { tag } = finishCeremony(start, response);
    expect(initiatorConfirmed(answer.expectedInitiatorTag, tag)).toBe(true);
  });

  it('fails on a mistyped secret half', () => {
    const { start, response, secret } = setup();
    const typo = secret === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
    const wrong = setup(typo);
    expect(() =>
      finishCeremony(start, { ...response, share: wrong.response.share, tag: wrong.response.tag }),
    ).toThrow(CeremonyError);
  });

  it('fails when a relay swaps the computer keys the phone sees', () => {
    const { start } = setup();
    const evil = generateKeys(random).public;
    // The phone approved keys a relay substituted; the computer's own keys differ.
    const answer = respondToCeremony({
      kind: 'pair',
      sessionId: 'pair_1',
      secret: start.secret,
      initiatorShare: start.share,
      initiatorKeys: evil,
      device: 'dev_phone',
      manifestHash: 'h',
      random,
    });
    expect(() =>
      finishCeremony(start, {
        share: answer.share,
        device: 'dev_phone',
        manifestHash: 'h',
        tag: answer.tag,
      }),
    ).toThrow(CeremonyError);
  });

  it('fails when a relay swaps the manifest version or the device', () => {
    const { start, response } = setup();
    expect(() => finishCeremony(start, { ...response, manifestHash: 'other' })).toThrow(
      CeremonyError,
    );
    expect(() => finishCeremony(start, { ...response, device: 'dev_evil' })).toThrow(CeremonyError);
  });

  it('fails across ceremony kinds and sessions', () => {
    const { start, response } = setup();
    // A link started with the same secret cannot complete a pairing answer.
    const link = startCeremony({ ...start, kind: 'link', random });
    expect(() => finishCeremony(link, response)).toThrow(CeremonyError);
    expect(() => finishCeremony({ ...start, sessionId: 'pair_2' }, response)).toThrow(
      CeremonyError,
    );
  });

  it('rejects a forged initiator tag on the phone', () => {
    const { answer } = setup();
    expect(initiatorConfirmed(answer.expectedInitiatorTag, answer.tag)).toBe(false);
    expect(initiatorConfirmed(answer.expectedInitiatorTag, 'not base64!')).toBe(false);
  });
});

describe('user codes', () => {
  it('split into lookup and secret, in any case and with separators', () => {
    expect(splitUserCode('k7qm-x2zp')).toEqual({ lookup: 'K7QM', secret: 'X2ZP' });
    expect(splitUserCode(' K7QM X2ZP ')).toEqual({ lookup: 'K7QM', secret: 'X2ZP' });
    expect(splitUserCode('K7QM')).toBeNull();
    expect(splitUserCode('K7QM-X2Z0')).toBeNull(); // 0 is not in the alphabet
  });

  it('draws secrets from the alphabet only', () => {
    for (let i = 0; i < 200; i++) expect(newCodeHalf(random)).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
  });
});
