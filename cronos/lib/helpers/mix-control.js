'use strict';

const http = require('http');
const https = require('https');
const URL = require('url').URL;
const writes = new WeakMap();
const RC = 'RenderingControl';

function range(min, max) { return { type: 'range', min, max, step: 1 }; }
function toggle() { return { type: 'toggle' }; }
function select(labels, start) {
  return { type: 'select', min: start, max: start + labels.length - 1, step: 1,
    options: labels.map((label, index) => ({ value: start + index, label })) };
}
const definitions = {
  volume: { control: range(0, 100), basic: 'Volume', channel: true },
  mute: { control: toggle(), basic: 'Mute', channel: true },
  bass: { control: range(-10, 10), basic: 'Bass' },
  treble: { control: range(-10, 10), basic: 'Treble' },
  loudness: { control: toggle(), basic: 'Loudness', channel: true },
  subGain: { control: range(-15, 15), eq: 'SubGain', hardware: 'sub' },
  subEnabled: { control: toggle(), eq: 'SubEnable', hardware: 'sub' },
  surroundTvLevel: { control: range(-15, 15), eq: 'SurroundLevel', hardware: 'surround' },
  surroundMusicLevel: { control: range(-15, 15), eq: 'MusicSurroundLevel', hardware: 'surround' },
  surroundEnabled: { control: toggle(), eq: 'SurroundEnable', hardware: 'surround' },
  surroundMode: { control: select(['Ambient', 'Full'], 0), eq: 'SurroundMode', hardware: 'surround' },
  heightLevel: { control: range(-10, 10), eq: 'HeightChannelLevel', hardware: 'height' },
  audioDelay: { control: select(['0', '1', '2', '3', '4', '5'], 0), eq: 'AudioDelay', hardware: 'soundbar' },
  nightMode: { control: toggle(), eq: 'NightMode', hardware: 'soundbar' },
  speechEnabled: { control: toggle(), eq: 'SpeechEnhanceEnabled', hardware: 'soundbar' },
  speechLevel: { control: select(['Off', 'Low', 'Medium', 'High', 'Max'], 0), eq: 'DialogLevel', hardware: 'ultra' },
  trueplay: { control: toggle(), calibration: true }
};

function decode(xml) {
  return xml.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function leaf(xml, name) {
  const match = xml.match(new RegExp('<(?:[\\w-]+:)?' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?' + name + '\\s*>'));
  if (!match) throw new Error('Invalid Sonos response: missing ' + name);
  return decode(match[1]);
}
function integer(xml, name) {
  const value = leaf(xml, name).trim();
  if (!/^-?\d+$/.test(value)) throw new Error('Invalid Sonos response: ' + name);
  return Number(value);
}
function validate(key, raw, control) {
  if (control.type === 'toggle') {
    if (raw === true || raw === 1 || raw === 'true' || raw === 'on' || raw === '1') return true;
    if (raw === false || raw === 0 || raw === 'false' || raw === 'off' || raw === '0') return false;
    throw new Error('Invalid boolean for ' + key);
  }
  if (!/^-?\d+$/.test(String(raw))) throw new Error('Invalid integer for ' + key);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < control.min || value > control.max) {
    throw new Error('Invalid range for ' + key + ': ' + control.min + ' to ' + control.max);
  }
  return value;
}

module.exports = function createMixControl(player, options) {
  const timeoutMs = (options && options.timeoutMs) || 2500;
  function request(path, body, service, action) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, player.baseUrl);
      const headers = body ? { 'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: '"urn:schemas-upnp-org:service:' + service + ':1#' + action + '"',
        'Content-Length': Buffer.byteLength(body) } : {};
      const transport = url.protocol === 'https:' ? https : http;
      const req = transport.request(url, { method: body ? 'POST' : 'GET', headers }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          data += chunk;
          if (data.length > 1024 * 1024) req.destroy(new Error('Sonos response too large'));
        });
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('Sonos response aborted')));
        res.on('end', () => {
          clearTimeout(deadline);
          if (/<(?:[\w-]+:)?Fault(?:\s|>)/.test(data)) {
            let code = 'unknown';
            try { code = leaf(data, 'errorCode'); } catch (_) { /* Missing code is still a fault. */ }
            const error = new Error('Sonos SOAP fault ' + code + ' for ' + action);
            error.soapFault = true;
            error.soapCode = code;
            error.soapAction = action;
            return reject(error);
          }
          if (res.statusCode !== 200) return reject(new Error('Sonos HTTP ' + res.statusCode + ' for ' + (action || path)));
          resolve(data);
        });
      });
      // An absolute deadline also bounds peers that send headers or dribble data.
      const deadline = setTimeout(() => req.destroy(new Error('Sonos timeout for ' + (action || path))), timeoutMs);
      req.on('error', error => { clearTimeout(deadline); reject(error); });
      if (body) req.write(body);
      req.end();
    });
  }
  function soap(action, args, service) {
    service = service || RC;
    const fields = Object.keys(args).map(key => '<' + key + '>' + args[key] + '</' + key + '>').join('');
    const body = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:' + action + ' xmlns:u="urn:schemas-upnp-org:service:' + service + ':1">' + fields + '</u:' + action + '></s:Body></s:Envelope>';
    const path = service === RC ? '/MediaRenderer/RenderingControl/Control' : '/' + service + '/Control';
    return request(path, body, service, action).then(response => {
      if (!new RegExp('<(?:[\\w-]+:)?' + action + 'Response(?:\\s|/?>)').test(response)) {
        throw new Error('Invalid Sonos response: missing ' + action + 'Response');
      }
      return response;
    });
  }
  function optional(promise) {
    return promise.catch(error => {
      // Invalid Action means this capability is absent. GetEQ's fixed,
      // validated probe also uses Invalid Args for unknown EQ names.
      if (error.soapFault && (error.soapCode === '401' ||
        (error.soapCode === '402' && error.soapAction === 'GetEQ'))) return null;
      throw error;
    });
  }
  async function hardware(modelName) {
    const soundbar = /\b(Arc|Beam|Ray|Playbar|Playbase)\b/i.test(modelName);
    const ultra = /\bArc Ultra\b/i.test(modelName);
    const topologyResponse = await optional(soap('GetZoneGroupState', {}, 'ZoneGroupTopology'));
    let channelMap = '';
    if (topologyResponse !== null) {
      const topology = leaf(topologyResponse, 'ZoneGroupState');
      const members = topology.match(/<ZoneGroupMember\b[^>]*>/g) || [];
      const member = members.find(tag => {
        const uuid = tag.match(/\bUUID="([^"]*)"/);
        return uuid && decode(uuid[1]) === player.uuid;
      });
      if (member) {
        const channels = member.match(/\b(?:HTSatChanMapSet|ChannelMapSet)="([^"]*)"/);
        if (channels) channelMap = decode(channels[1]);
      }
    }
    return { soundbar, ultra, height: /\bArc\b/i.test(modelName),
      sub: topologyResponse === null ? player.hasSub === true : /:SW(?:;|,|$)/.test(channelMap),
      surround: soundbar && /:(?:LR|RR)(?:;|,|$)/.test(channelMap) };
  }
  async function read() {
    const descriptor = await request('/xml/device_description.xml');
    const modelName = leaf(descriptor, 'modelName').trim();
    if (!modelName) throw new Error('Invalid Sonos device descriptor');
    const hw = await hardware(modelName);
    const result = { status: 'success', roomName: player.roomName, uuid: player.uuid, modelName, values: {}, controls: {} };
    let speechMax = 3;
    if (hw.ultra) {
      const response = await optional(soap('GetEQ', { InstanceID: 0, EQType: 'SupportsMaxDialogLevel' }));
      if (response !== null && integer(response, 'CurrentValue') === 1) speechMax = 4;
    }
    await Promise.all(Object.keys(definitions).map(async key => {
      const def = definitions[key];
      if (def.hardware && !hw[def.hardware]) return;
      let control = def.control;
      if (key === 'speechLevel' && speechMax === 3) control = select(['Off', 'Low', 'Medium', 'High'], 0);
      let response;
      let value;
      if (def.calibration) {
        response = await optional(soap('GetRoomCalibrationStatus', { InstanceID: 0 }));
        if (response === null || integer(response, 'RoomCalibrationAvailable') !== 1) return;
        value = integer(response, 'RoomCalibrationEnabled');
      } else if (def.basic) {
        const args = { InstanceID: 0 };
        if (def.channel) args.Channel = 'Master';
        // Core EQ is mandatory. Loudness is optional on unusual devices.
        response = await (key === 'loudness' ? optional(soap('Get' + def.basic, args)) : soap('Get' + def.basic, args));
        if (response === null) return;
        value = integer(response, 'Current' + def.basic);
      } else {
        const eq = key === 'speechEnabled' && !hw.ultra ? 'DialogLevel' : def.eq;
        response = await optional(soap('GetEQ', { InstanceID: 0, EQType: eq }));
        if (response === null) return;
        value = integer(response, 'CurrentValue');
      }
      if (control.type === 'toggle') {
        if (value !== 0 && value !== 1) throw new Error('Invalid Sonos boolean response for ' + key);
        value = value === 1;
      } else value = validate(key, value, control);
      result.values[key] = value;
      result.controls[key] = control;
    }));
    return result;
  }
  function set(key, raw) {
    // Reject malformed input without touching the network, including prototype keys.
    if (!Object.prototype.hasOwnProperty.call(definitions, key)) return Promise.reject(new Error('Unknown Mix control: ' + key));
    let value;
    try { value = validate(key, raw, definitions[key].control); } catch (error) { return Promise.reject(error); }
    const previous = writes.get(player) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await read();
      if (!current.controls[key]) throw new Error('Unsupported Mix control: ' + key);
      value = validate(key, value, current.controls[key]);
      const desired = typeof value === 'boolean' ? Number(value) : value;
      const def = definitions[key];
      if (def.calibration) await soap('SetRoomCalibrationStatus', { InstanceID: 0, RoomCalibrationEnabled: desired });
      else if (def.basic) {
        const args = { InstanceID: 0 };
        if (def.channel) args.Channel = 'Master';
        args['Desired' + def.basic] = desired;
        await soap('Set' + def.basic, args);
      } else {
        const eq = key === 'speechEnabled' && !/\bArc Ultra\b/i.test(current.modelName) ? 'DialogLevel' : def.eq;
        await soap('SetEQ', { InstanceID: 0, EQType: eq, DesiredValue: desired });
      }
      const confirmed = await read();
      if (!confirmed.controls[key] || !Object.prototype.hasOwnProperty.call(confirmed.values, key) || confirmed.values[key] !== value) {
        throw new Error('Sonos write not applied: readback for ' + key + ' was ' + confirmed.values[key] + ', requested ' + value);
      }
      return confirmed;
    });
    writes.set(player, operation);
    operation.then(() => { if (writes.get(player) === operation) writes.delete(player); }, () => { if (writes.get(player) === operation) writes.delete(player); });
    return operation;
  }
  return { read, set };
};
