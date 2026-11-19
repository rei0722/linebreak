// Aim mode: players choose who receives their garbage.

import { describe, expect, test } from 'bun:test';
import { Match, type MatchHost } from '../server/match';
import { parseClientMsg } from '../server/schema';
import { DEFAULT_HANDLING } from '../shared/engine/rules';
import { DEFAULT_SETTINGS, type RoomSettings, type ServerMsg } from '../shared/protocol';

function setup(settings: Partial<RoomSettings>) {
  const sent: ServerMsg[] = [];
  const host: MatchHost = {
    send: (_id, m) => sent.push(m),
    broadcast: (m) => sent.push(m),
    ended: () => {},
    roomChanged: () => {},
  };
  const ps = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), handling: DEFAULT_HANDLING }));
  const m = new Match(1, ps, { ...DEFAULT_SETTINGS, ...settings }, Date.now(), host, 42);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = m as any;
  const attack = (from: string) => {
    const before = sent.length;
    raw.attack(raw.players.get(from), 2, Date.now());
    const a = sent.slice(before).find((x) => x.t === 'attack') as Extract<ServerMsg, { t: 'attack' }> | undefined;
    return a?.to;
  };
  const kill = (id: string) => raw.eliminate(raw.players.get(id), 'topout', Date.now());
  const lastAims = () => [...sent].reverse().find((x) => x.t === 'aims') as Extract<ServerMsg, { t: 'aims' }> | undefined;
  return { m, attack, kill, lastAims };
}

describe('aim mode', () => {
  test('garbage goes to the chosen target, every time', () => {
    const { m, attack } = setup({ mode: 'aim' });
    m.setAim('a', 'c');
    for (let i = 0; i < 10; i++) expect(attack('a')).toBe('c');
  });

  test('no choice = hit back at whoever hit you last', () => {
    const { m, attack } = setup({ mode: 'aim' });
    m.setAim('d', 'b');
    expect(attack('d')).toBe('b');
    expect(attack('b')).toBe('d');
  });

  test('cannot aim at yourself or a missing player; null clears', () => {
    const { m, lastAims } = setup({ mode: 'aim' });
    m.setAim('a', 'a');
    m.setAim('a', 'zzz');
    expect(lastAims()).toBeUndefined();
    m.setAim('a', 'b');
    expect(lastAims()?.aims).toEqual({ a: 'b' });
    m.setAim('a', null);
    expect(lastAims()?.aims).toEqual({});
  });

  test('a knocked-out target is dropped and everyone is told', () => {
    const { m, attack, kill, lastAims } = setup({ mode: 'aim' });
    m.setAim('a', 'c');
    m.setAim('b', 'c');
    kill('c');
    expect(lastAims()?.aims).toEqual({});
    const to = attack('a');
    expect(to).not.toBe('c');
    expect(to).not.toBe('a');
  });

  test('normal mode ignores aims', () => {
    const { m, lastAims } = setup({ mode: 'normal' });
    m.setAim('a', 'b');
    expect(lastAims()).toBeUndefined();
  });

  test('schema accepts aim and mode, rejects junk', () => {
    expect(parseClientMsg('{"t":"aim","id":"abc"}')).toEqual({ t: 'aim', id: 'abc' });
    expect(parseClientMsg('{"t":"aim","id":null}')).toEqual({ t: 'aim', id: null });
    expect(parseClientMsg('{"t":"aim"}')).toBeNull();
    expect(parseClientMsg('{"t":"settings","settings":{"mode":"aim"}}')).not.toBeNull();
    expect(parseClientMsg('{"t":"settings","settings":{"mode":"chaos"}}')).toBeNull();
  });
});
