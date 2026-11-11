// The client's city helpers (web/src/net/cities.ts, web/src/net/base.ts) outside a browser: the home city's view.
import { describe, expect, test } from 'bun:test';
import { apiUrl, BASE, CITY_ID, hubUrl } from '../../web/src/net/base';
import { cityHref, cityStatusText, currentCity, currentCityName, errorOf, hasManyCities, placeHash, restoreLastCity, returnHref, type CitiesView } from '../../web/src/net/cities';
import { cityPrefix } from '../../web/src/ui/dom';

const view = (cities: CitiesView['data'] extends infer D ? (D extends { cities: infer C } ? C : never) : never): CitiesView => ({
  data: { home: { id: 'home', name: 'Hilltop', version: '1.2.3' }, cities },
  error: null,
  loading: false,
});

describe('base paths at the hub’s own city', () => {
  test('no prefix', () => {
    expect(CITY_ID).toBeNull();
    expect(BASE).toBe('/');
    expect(apiUrl('/api/uploads/x.png')).toBe('/api/uploads/x.png');
    expect(apiUrl('https://example.com/x')).toBe('https://example.com/x');
    expect(hubUrl('/api/cities')).toBe('/api/cities');
  });
});

describe('city helpers', () => {
  test('cityHref', () => {
    expect(cityHref('home')).toBe('/');
    expect(cityHref('harbor')).toBe('/city/harbor/');
  });
  test('current city at home, and whether to say whose accounts these are', () => {
    const one = view([]);
    expect(currentCity(one)).toEqual({ id: 'home', name: 'Hilltop', status: 'online', version: '1.2.3' });
    expect(currentCityName(one)).toBe('Hilltop');
    expect(hasManyCities(one)).toBe(false);
    const two = view([{ id: 'harbor', name: 'Harbor', url: 'http://b:1', status: 'offline' }]);
    expect(hasManyCities(two)).toBe(true);
    expect(currentCityName({ data: null, error: null, loading: true })).toBe('Home');
  });
  test('status words', () => {
    expect(cityStatusText({ status: 'online', version: '0.2.0' })).toBe('v0.2.0');
    expect(cityStatusText({ status: 'online' })).toBe('Online');
    expect(cityStatusText({ status: 'offline' })).toBe('Offline');
    expect(cityStatusText({ status: 'error', error: 'That machine no longer accepts this pairing — re-pair it.' })).toBe('Needs re-pairing');
    expect(cityStatusText({ status: 'error', error: 'odd' })).toBe('Problem');
  });
  test('errors from the hub become its sentence', async () => {
    expect(await errorOf(new Response(JSON.stringify({ error: 'That address is this CAST itself.' }), { status: 400 }))).toBe('That address is this CAST itself.');
    expect(await errorOf(new Response('nope', { status: 403 }))).toMatch(/signed in/);
    expect(await errorOf(new Response('x', { status: 500 }))).toBe('The CAST server answered 500.');
  });
  test('restoring the last city never happens outside the installed app', () => {
    expect(restoreLastCity(view([{ id: 'harbor', name: 'Harbor', url: 'http://b:1', status: 'online' }]))).toBe(false);
  });
  test('switching back lands in the house that city was left in', () => {
    expect(returnHref('harbor', '#/house/todo-api')).toBe('/city/harbor/#/house/todo-api');
    expect(returnHref('home', '#/house/novel/job-2')).toBe('/#/house/novel/job-2');
    expect(returnHref('harbor', null)).toBe('/city/harbor/');
    // only a house address comes back; anything else stored there is ignored
    expect(returnHref('harbor', 'javascript:alert(1)')).toBe('/city/harbor/');
    expect(returnHref('harbor', '#/settings')).toBe('/city/harbor/');
    expect(placeHash('#/house/a b')).toBe('');
    expect(placeHash('#/house/' + 'x'.repeat(300))).toBe('');
  });
  test('each city keeps its own keys; home keeps the bare ones', () => {
    expect(cityPrefix(null)).toBe('');
    expect(cityPrefix('home')).toBe('');
    expect(cityPrefix('harbor')).toBe('city:harbor:');
  });
});

describe('Pair a phone from a city', () => {
  test('the one-time link pairs with the hub and lands in the city on screen', async () => {
    const { pairLinkPath } = await import('../../web/src/net/session');
    expect(pairLinkPath('/?token=CODE123', null)).toBe('/?token=CODE123');
    expect(pairLinkPath('/?token=CODE123', 'harbor')).toBe('/city/harbor/?token=CODE123');
  });
  test('the dialog says which CAST the device joins', async () => {
    const { pairTargetLine } = await import('../../web/src/ui/pair-text');
    expect(pairTargetLine('Hilltop', 'Harbor', true)).toBe('This pairs a device with Hilltop, the CAST this browser signed in to, and opens Harbor on it.');
    expect(pairTargetLine('Hilltop', null, true)).toBe('This pairs a device with Hilltop. Your other cities open from its city menu.');
    expect(pairTargetLine('Hilltop', null, false)).toBeNull(); // one CAST: nothing to tell apart
    expect(pairTargetLine(null, 'Harbor', true)).toContain('this hub');
  });
});
