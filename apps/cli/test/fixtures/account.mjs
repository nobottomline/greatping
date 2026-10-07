// A test account that speaks the real end-to-end protocol: a phone and this
// computer with deterministic keys, the manifest holding both, and the
// phone's side of sealed content. Never use these keys outside tests.
import {
  addMember,
  createGenesis,
  generateKeys,
  openEnvelope,
  recipientsFor,
  sealEnvelope,
  toBase64Url,
} from '@greatping/protocol/crypto';

function stream(seed) {
  let counter = seed;
  return (n) =>
    Uint8Array.from({ length: n }, () => {
      counter = (counter * 1103515245 + 12345) >>> 0;
      return counter >>> 24;
    });
}

const random = (n) => crypto.getRandomValues(new Uint8Array(n));
export const ACCOUNT_ID = 'acc_test';
export const MACHINE_ID = 'test-machine';
export const phone = { id: 'dev_phone', ...generateKeys(stream(1)) };
export const stranger = { id: 'dev_phone', ...generateKeys(stream(9)) };
const computer = generateKeys(stream(2));
const T0 = Date.now() - 10 * 24 * 3600 * 1000;

const genesis = createGenesis({
  account: ACCOUNT_ID,
  device: phone.id,
  keys: phone.public,
  secret: phone.secret,
  createdAt: T0,
});
export const manifest = addMember(
  genesis,
  { id: phone.id, secret: phone.secret },
  { kind: 'computer', id: MACHINE_ID, ...computer.public },
  T0 + 1,
);

/** A paired config with keys and the verified manifest, as `greatping login` saves it. */
export function pairedConfig(apiUrl, extra = {}) {
  return {
    apiUrl,
    machineId: MACHINE_ID,
    machineToken: 'PRIVATE TOKEN',
    keys: { sign: toBase64Url(computer.secret.sign), enc: toBase64Url(computer.secret.enc) },
    manifest,
    ...extra,
  };
}

/** What the phone reads from an envelope the computer sealed. */
export function openAsPhone(envelope, purpose = 'request') {
  return openEnvelope({
    envelope,
    accountId: ACCOUNT_ID,
    me: { id: phone.id, encSecrets: [phone.secret.enc] },
    manifest,
    expect: { purpose },
  }).payload;
}

/** The phone's answer to a question envelope; `signer` may be a key the account does not hold. */
export function answerFor(question, payload, signer = phone) {
  return sealEnvelope({
    purpose: 'answer',
    accountId: ACCOUNT_ID,
    sender: { id: signer.id, secret: signer.secret },
    manifest,
    recipients: recipientsFor('answer', manifest, MACHINE_ID),
    meta: { kind: 'ask' },
    payload,
    ref: question.id,
    now: Date.now(),
    random,
  });
}

/** A project command from the phone (or a forger) for one of this computer's projects. */
export function projectCommand(projectKey, payload, signer = phone) {
  return sealEnvelope({
    purpose: 'project',
    accountId: ACCOUNT_ID,
    sender: { id: signer.id, secret: signer.secret },
    manifest,
    recipients: recipientsFor('project', manifest, MACHINE_ID),
    meta: { projectKey },
    payload,
    now: Date.now(),
    random,
  });
}
