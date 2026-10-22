// Runtime validation for everything a client can send.
import { z } from 'zod';
import type { ClientMsg } from '../shared/protocol';
import { MAX_EVENTS_PER_BATCH } from './match';

const int = z.number().int();
const handling = z.object({ das: z.number(), arr: z.number(), sdf: z.number() });
const name = z.string().max(64);

const schema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('create'), name, handling, v: int }),
  z.object({
    t: z.literal('join'),
    room: z.string().max(16),
    name,
    handling,
    token: z.string().max(64).optional(),
    v: int,
  }),
  z.object({ t: z.literal('leave') }),
  z.object({ t: z.literal('ready'), ready: z.boolean() }),
  z.object({ t: z.literal('name'), name }),
  z.object({
    t: z.literal('settings'),
    settings: z
      .object({
        attacks: z.boolean(),
        targeting: z.enum(['random', 'roundRobin']),
        attackPercent: int,
        maxPlayers: int,
      })
      .partial(),
  }),
  z.object({ t: z.literal('start') }),
  z.object({ t: z.literal('kick'), id: z.string().max(32) }),
  z.object({ t: z.literal('ping'), c: z.number() }),
  z.object({
    t: z.literal('in'),
    m: int,
    e: int.nonnegative(),
    seq: int.positive(),
    upto: int.nonnegative(),
    ev: z
      .array(z.union([z.tuple([int.nonnegative(), int]), z.tuple([int.nonnegative(), int, int])]))
      .max(MAX_EVENTS_PER_BATCH),
    h: int,
  }),
]);

export function parseClientMsg(raw: string): ClientMsg | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = schema.safeParse(data);
  return r.success ? (r.data as ClientMsg) : null;
}

export function cleanName(raw: string): string {
  // strip control / bidi characters, collapse whitespace
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, 16).join('') || 'プレイヤー';
}
