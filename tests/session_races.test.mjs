import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(process.env.BOUJOY_APP_SOURCE || fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing production function ${start}`);
  return source.slice(from, to);
}

function historyFixture() {
  const state = {sessionId: 'a', mode: 'knowledge', history: [{seq: 10, text: 'A current'}], historyHasMore: true,
    historyLoadingOlder: false, loadingHistory: false, liveResponse: null, historyLoadToken: 1, historyOlderLoadToken: 0};
  const stream = {scrollHeight: 100, scrollTop: 20};
  const calls = [], renders = [], errors = [], frames = [];
  let settle;
  const context = vm.createContext({state, HISTORY_FETCH_LIMIT: 50, $: () => stream,
    sessionEventSeq: event => event?.seq ?? null, historyEvents: value => value.events,
    rpc: (...args) => {calls.push(args); return new Promise(resolve => {settle = resolve;});},
    renderHistory: history => {renders.push(history); stream.scrollHeight += 50;},
    requestAnimationFrame: callback => frames.push(callback), toast: message => errors.push(message)});
  vm.runInContext(section('async function loadOlderHistory()', '\nasync function loadSubagents()'), context);
  return {state, stream, calls, renders, errors, frames, load: () => context.loadOlderHistory(),
    resolve: () => settle({events: [{seq: 9, text: 'A older'}], hasMore: false})};
}

test('older history still prepends and preserves the scroll anchor in the same session', async () => {
  const f = historyFixture();
  const pending = f.load(); f.resolve(); await new Promise(setImmediate);
  f.frames.shift()(); await pending;
  assert.deepEqual(Array.from(f.state.history, e => e.seq), [9, 10]);
  assert.equal(f.stream.scrollTop, 70);
  assert.equal(f.state.historyLoadingOlder, false);
});

for (const change of ['session', 'mode', 'refresh']) {
  test(`an older-history response cannot land after a ${change} change`, async () => {
    const f = historyFixture();
    const pending = f.load();
    if (change === 'session') f.state.sessionId = 'b';
    if (change === 'mode') f.state.mode = 'clean';
    if (change === 'refresh') f.state.historyLoadToken += 1;
    f.state.history = [{seq: 40, text: 'New view'}];
    f.resolve(); await new Promise(setImmediate);
    // Complete frames on the old implementation too, so failures do not hang.
    f.frames.splice(0).forEach(frame => frame());
    await pending;
    assert.deepEqual(Array.from(f.state.history, e => e.seq), [40]);
    assert.equal(f.renders.length, 0);
    assert.equal(f.state.historyLoadingOlder, false);
  });
}

test('old pagination cleanup does not unlock a newer pagination request', async () => {
  const f = historyFixture();
  const pending = f.load();
  f.state.historyOlderLoadToken += 1;
  f.state.historyLoadingOlder = true;
  f.resolve(); await new Promise(setImmediate);
  f.frames.splice(0).forEach(frame => frame()); await pending;
  assert.equal(f.state.historyLoadingOlder, true);
});

test('a delayed animation frame cannot scroll a switched conversation', async () => {
  const f = historyFixture();
  const pending = f.load(); f.resolve(); await new Promise(setImmediate);
  f.state.sessionId = 'b'; f.stream.scrollTop = 0;
  f.frames.shift()(); await pending;
  assert.equal(f.stream.scrollTop, 0);
});

function streamFixture() {
  const sockets = [], frames = [], timers = new Map(); let timerId = 0;
  class WebSocket {
    static OPEN = 1; static CLOSING = 2;
    constructor(url) {this.url = url; this.readyState = 0; sockets.push(this);}
    close() {this.readyState = 3; this.onclose?.();}
  }
  const state = {eventSources: [], eventSourceGeneration: 0, mode: 'knowledge'};
  const context = vm.createContext({state, WebSocket, location: {host: '127.0.0.1:8766'},
    localStorage: {getItem: () => ''}, handleServerFrame: frame => frames.push(frame),
    setTimeout: callback => {timers.set(++timerId, callback); return timerId;},
    clearTimeout: id => timers.delete(id), showDisconnectBanner() {}, hideDisconnectBanner() {}});
  vm.runInContext(section('function closeEventSources()', '\nfunction sessionEventSeq('), context);
  return {state, sockets, frames, timers, context};
}

test('retired sockets cannot inject queued frames into the new mode', () => {
  const f = streamFixture(); f.context.connectEvents();
  const old = f.sockets[0];
  f.context.closeEventSources(); f.state.mode = 'clean';
  old.onmessage({data: JSON.stringify({type: 'session/event', private: 'old mode'})});
  assert.equal(f.frames.length, 0);
});

test('a pending reconnect from the previous mode is invalidated on shutdown', () => {
  const f = streamFixture(); f.context.connectEvents();
  f.sockets[0].close(); f.context.closeEventSources(); f.state.mode = 'clean';
  [...f.timers.values()].forEach(callback => callback());
  assert.equal(f.sockets.length, 2);
});

test('one failed endpoint reconnects while the other stays connected', () => {
  const f = streamFixture(); f.context.connectEvents();
  f.sockets[0].close();
  [...f.timers.values()].forEach(callback => callback());
  assert.equal(f.sockets.length, 3);
  assert.ok(f.sockets[2].url.includes('events.mux'));
  assert.equal(f.state.eventSources.length, 2);
});
