'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const helperPath = '../lib/helpers/mix-control';
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tag = (xml, name) => (xml.match(new RegExp('<' + name + '>([^<]*)</' + name + '>')) || [])[1];

async function speaker(t, config = {}) {
  const eq = Object.assign({ SubGain: 0, SubEnable: 1, SurroundLevel: 0, MusicSurroundLevel: 4,
    SurroundEnable: 1, SurroundMode: 1, HeightChannelLevel: 8, AudioDelay: 0, NightMode: 0,
    DialogLevel: 1, SpeechEnhanceEnabled: 0, SupportsMaxDialogLevel: 1 }, config.eq);
  const state = { Volume: 24, Mute: 0, Bass: -2, Treble: 3, Loudness: 1 };
  let calibrationEnabled = 1;
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const action = (req.headers.soapaction || '').split('#')[1]?.replace(/"/g, '');
      requests.push({ action, body, path: req.url, soapaction: req.headers.soapaction });
      if (config.timeout && (config.timeout === action || config.timeout === req.url)) return;
      if (req.url === '/xml/device_description.xml') {
        res.statusCode = config.descriptorStatus || 200;
        return res.end('<root><device><modelName>' + escape(config.model || 'Sonos Arc Ultra') + '</modelName></device></root>');
      }
      if (config.httpError === action) { res.statusCode = 503; return res.end('Unavailable'); }
      if (config.malformed === action) return res.end('<html>Not a SOAP response</html>');
      let result;
      const eqType = tag(body, 'EQType');
      const unsupported = (config.unsupported || []).includes(eqType || action);
      const faultCode = config.faults && config.faults[eqType || action];
      if (faultCode || unsupported || (action === 'GetEQ' && !(eqType in eq))) {
        res.statusCode = 500;
        return res.end('<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>' + (faultCode || 401) + '</errorCode><errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>');
      }
      if (action === 'GetZoneGroupState') {
        const channels = config.channels === undefined ? 'ROOM:LF,RF;SUB:SW;LEFT:LR,LTR;RIGHT:RR,RTR' : config.channels;
        result = '<ZoneGroupState>' + escape('<ZoneGroups><ZoneGroup><ZoneGroupMember UUID="ROOM" HTSatChanMapSet="' + channels + '"/></ZoneGroup></ZoneGroups>') + '</ZoneGroupState>';
      } else if (action === 'GetEQ') result = '<CurrentValue>' + eq[eqType] + '</CurrentValue>';
      else if (action === 'SetEQ') {
        if (config.disappear === eqType) delete eq[eqType];
        else if (config.ignore !== eqType) eq[eqType] = Number(tag(body, 'DesiredValue'));
        result = '';
      }
      else if (action === 'GetRoomCalibrationStatus') result = '<RoomCalibrationEnabled>' + calibrationEnabled + '</RoomCalibrationEnabled><RoomCalibrationAvailable>' + (config.calibrationAvailable === undefined ? 1 : config.calibrationAvailable) + '</RoomCalibrationAvailable>';
      else if (action === 'SetRoomCalibrationStatus') { calibrationEnabled = Number(tag(body, 'RoomCalibrationEnabled')); result = ''; }
      else if (action && action.startsWith('Get')) {
        const key = action.slice(3);
        result = '<Current' + key + '>' + state[key] + '</Current' + key + '>';
      } else if (action && action.startsWith('Set')) {
        const key = action.slice(3);
        // Clamp to show endpoint reports device readback rather than requested state.
        state[key] = key === 'Volume' ? Math.min(80, Number(tag(body, 'Desired' + key))) : Number(tag(body, 'Desired' + key));
        result = '';
      }
      res.end('<s:Envelope><s:Body><u:' + action + 'Response xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">' + result + '</u:' + action + 'Response></s:Body></s:Envelope>');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const player = { baseUrl: 'http://127.0.0.1:' + server.address().port, uuid: 'ROOM', roomName: 'Living Room', hasSub: true,
    coordinator: { baseUrl: 'http://127.0.0.1:1', uuid: 'WRONG' } };
  return { player, requests, eq, state };
}

// Each case exercises native HTTP and literal Sonos SOAP fixtures.

test('reads live room controls including bonded Arc Ultra and calibrated Trueplay', async t => {
  const { player, requests } = await speaker(t);
  const result = await require(helperPath)(player).read();
  assert.equal(result.status, 'success');
  assert.equal(result.modelName, 'Sonos Arc Ultra');
  assert.equal(result.uuid, 'ROOM');
  assert.equal(result.values.volume, 24);
  assert.equal(result.values.bass, -2);
  assert.equal(result.values.mute, false);
  assert.equal(result.values.surroundMusicLevel, 4);
  assert.equal(result.values.heightLevel, 8);
  assert.equal(result.values.trueplay, true);
  assert.deepEqual(result.controls.speechLevel.options.map(x => x.value), [0, 1, 2, 3, 4]);
  assert.equal(result.controls.subGain.min, -15);
  assert.equal(result.controls.volume.max, 100);
  assert.ok(!('subPolarity' in result.controls));
  assert.ok(requests.every(r => r.path !== '/wrong'));
});

test('strictly rejects invalid ranges, booleans and keys before any network write', async t => {
  const { player, requests } = await speaker(t);
  const control = require(helperPath)(player);
  for (const [key, value] of [['volume', '101'], ['bass', '1.5'], ['treble', '4x'], ['mute', 'maybe'], ['volume', ''], ['subGain', '-16'], ['audioDelay', '6'], ['__proto__', '1'], ['notAControl', '1']]) {
    await assert.rejects(control.set(key, value), /invalid|range|unknown/i);
  }
  assert.equal(requests.length, 0);
});

test('writes exact SOAP on selected player then returns device readback', async t => {
  const { player, requests } = await speaker(t);
  const control = require(helperPath)(player);
  assert.equal((await control.set('volume', '75')).values.volume, 75);
  const volume = requests.find(r => r.action === 'SetVolume');
  assert.equal(volume.path, '/MediaRenderer/RenderingControl/Control');
  assert.equal(volume.soapaction, '"urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"');
  assert.match(volume.body, /<InstanceID>0<\/InstanceID><Channel>Master<\/Channel><DesiredVolume>75<\/DesiredVolume>/);
  assert.equal((await control.set('surroundMusicLevel', '-3')).values.surroundMusicLevel, -3);
  const eq = requests.find(r => r.action === 'SetEQ');
  assert.match(eq.body, /<EQType>MusicSurroundLevel<\/EQType><DesiredValue>-3<\/DesiredValue>/);
  assert.equal((await control.set('mute', 'true')).values.mute, true);
});

test('omits optional SOAP faults and refuses unsupported writes', async t => {
  const { player, requests } = await speaker(t, { unsupported: ['HeightChannelLevel', 'SurroundMode'] });
  const control = require(helperPath)(player);
  assert.ok(!('heightLevel' in (await control.read()).controls));
  await assert.rejects(control.set('heightLevel', '2'), /unsupported/i);
  assert.ok(!requests.some(r => r.action === 'SetEQ'));
});

test('hardware topology and calibration gate controls even if generic EQ reads succeed', async t => {
  const { player } = await speaker(t, { model: 'Sonos One', channels: 'ROOM:LF,RF', calibrationAvailable: 0 });
  player.hasSub = false;
  const result = await require(helperPath)(player).read();
  for (const key of ['subGain', 'surroundEnabled', 'heightLevel', 'speechLevel', 'nightMode', 'trueplay']) assert.ok(!(key in result.controls), key);
  assert.equal(result.values.loudness, true);
});

test('legacy soundbar uses DialogLevel toggle and omits Ultra speech levels', async t => {
  const { player, requests } = await speaker(t, { model: 'Sonos Beam' });
  const result = await require(helperPath)(player).set('speechEnabled', 'off');
  assert.equal(result.values.speechEnabled, false);
  assert.ok(!('speechLevel' in result.controls));
  assert.match(requests.find(r => r.action === 'SetEQ').body, /<EQType>DialogLevel<\/EQType><DesiredValue>0<\/DesiredValue>/);
});

test('mandatory faults, descriptor failures and timeouts reject fresh reads', async t => {
  const a = await speaker(t, { unsupported: ['GetVolume'] });
  await assert.rejects(require(helperPath)(a.player).read(), /SOAP|401/i);
  const b = await speaker(t, { descriptorStatus: 503 });
  await assert.rejects(require(helperPath)(b.player).read(), /503/);
  const c = await speaker(t, { timeout: 'GetVolume' });
  await assert.rejects(require(helperPath)(c.player, { timeoutMs: 35 }).read(), /timeout/i);
});

test('fresh capability check restricts maximum speech level and missing calibration', async t => {
  const { player, requests } = await speaker(t, { eq: { SupportsMaxDialogLevel: 0 }, calibrationAvailable: 0 });
  const control = require(helperPath)(player);
  await assert.rejects(control.set('speechLevel', '4'), /range|invalid/i);
  await assert.rejects(control.set('trueplay', 'on'), /unsupported/i);
  assert.ok(!requests.some(r => r.action && r.action.startsWith('Set')));
});

test('separate helpers serialize writes and complete readback before next write', async t => {
  const { player, requests } = await speaker(t);
  const [first, second] = await Promise.all([require(helperPath)(player).set('bass', '5'), require(helperPath)(player).set('bass', '-4')]);
  assert.equal(first.values.bass, 5);
  assert.equal(second.values.bass, -4);
  const writes = requests.map((r, i) => r.action === 'SetBass' ? i : -1).filter(i => i >= 0);
  assert.equal(writes.length, 2);
  assert.ok(requests.slice(writes[0] + 1, writes[1]).some(r => r.action === 'GetBass'));
});

test('autoload action validates route shape and returns full Mix readback', async t => {
  const { player } = await speaker(t);
  let handler;
  require('../lib/actions/mix')({ registerAction(name, fn) { assert.equal(name, 'mix'); handler = fn; } });
  assert.equal((await handler(player, [])).values.volume, 24);
  await assert.rejects(handler(player, ['volume']), /invalid/i);
  await assert.rejects(handler(player, ['volume', '20', 'extra']), /invalid/i);
});


test('missing bonds suppress sub and surround controls on an otherwise capable soundbar', async t => {
  const { player } = await speaker(t, { channels: 'ROOM:LF,RF;OTHER:LF,RF' });
  const result = await require(helperPath)(player).read();
  assert.ok(!('subGain' in result.controls));
  assert.ok(!('surroundTvLevel' in result.controls));
  assert.equal(result.values.heightLevel, 8);
});

test('SOAP rejection or malformed write response never reports success', async t => {
  const a = await speaker(t, { unsupported: ['SetVolume'] });
  await assert.rejects(require(helperPath)(a.player).set('volume', '20'), /SOAP/);
  const b = await speaker(t, { malformed: 'SetVolume' });
  await assert.rejects(require(helperPath)(b.player).set('volume', '20'), /Invalid Sonos response/);
});

test('optional transport failure rejects the snapshot instead of disguising lost connectivity', async t => {
  const { player } = await speaker(t, { httpError: 'GetRoomCalibrationStatus' });
  await assert.rejects(require(helperPath)(player).read(), /503/);
});

test('Trueplay switches only existing calibration using RoomCalibrationEnabled', async t => {
  const { player, requests } = await speaker(t);
  assert.equal((await require(helperPath)(player).set('trueplay', 'off')).values.trueplay, false);
  const write = requests.find(r => r.action === 'SetRoomCalibrationStatus');
  assert.match(write.body, /<InstanceID>0<\/InstanceID><RoomCalibrationEnabled>0<\/RoomCalibrationEnabled>/);
});


test('write success requires the requested value to survive fresh readback', async t => {
  const clamped = await speaker(t);
  await assert.rejects(require(helperPath)(clamped.player).set('volume', '95'), /readback|not applied/i);
  const ignored = await speaker(t, { ignore: 'MusicSurroundLevel' });
  await assert.rejects(require(helperPath)(ignored.player).set('surroundMusicLevel', '2'), /readback|not applied/i);
  const missing = await speaker(t, { disappear: 'MusicSurroundLevel' });
  await assert.rejects(require(helperPath)(missing.player).set('surroundMusicLevel', '2'), /readback|not applied/i);
});

test('Arc Ultra DialogLevel zero remains a readable independent Off selection', async t => {
  const { player } = await speaker(t, { eq: { DialogLevel: 0, SpeechEnhanceEnabled: 1 } });
  const control = require(helperPath)(player);
  const result = await control.read();
  assert.equal(result.values.speechLevel, 0);
  assert.equal(result.values.speechEnabled, true);
  assert.deepEqual(result.controls.speechLevel.options[0], { value: 0, label: 'Off' });
  assert.equal((await control.set('speechLevel', '0')).values.speechLevel, 0);
  const limited = await speaker(t, { eq: { DialogLevel: 0, SupportsMaxDialogLevel: 0 } });
  assert.deepEqual((await require(helperPath)(limited.player).read()).controls.speechLevel.options.map(x => x.value), [0, 1, 2, 3]);
});

test('only known unsupported faults omit optional controls, device failures propagate', async t => {
  const unsupported = await speaker(t, { faults: { HeightChannelLevel: 402 } });
  assert.ok(!('heightLevel' in (await require(helperPath)(unsupported.player).read()).controls));
  for (const code of [501, 701, 999]) {
    const failed = await speaker(t, { faults: { HeightChannelLevel: code } });
    await assert.rejects(require(helperPath)(failed.player).read(), new RegExp(String(code)));
  }
});

test('exact device model names gate soundbar, height and Ultra-only speech controls', async t => {
  for (const [model, soundbar, height, ultra] of [
    ['Sonos Arc Ultra', true, true, true], ['Sonos Arc', true, true, false],
    ['Sonos Beam', true, false, false], ['Sonos Ray', true, false, false],
    ['Sonos PLAYBAR', true, false, false], ['Sonos PLAYBASE', true, false, false],
    ['Sonos Era 300', false, false, false], ['Sonos One', false, false, false]
  ]) {
    const { player } = await speaker(t, { model });
    const result = await require(helperPath)(player).read();
    assert.equal('nightMode' in result.controls, soundbar, model);
    assert.equal('heightLevel' in result.controls, height, model);
    assert.equal('speechLevel' in result.controls, ultra, model);
  }
});

test('Invalid Args outside optional GetEQ remains a reported device fault', async t => {
  const { player } = await speaker(t, { faults: { GetRoomCalibrationStatus: 402 } });
  await assert.rejects(require(helperPath)(player).read(), /402/);
});
