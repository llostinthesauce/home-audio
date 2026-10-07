'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function app(initialStorage = {}) {
  const elements = new Map();
  function element() {
    return { classList: { add() {}, remove() {}, toggle() {} }, style: { setProperty() {} },
      querySelectorAll() { return []; }, querySelector() { return element(); },
      addEventListener() {}, appendChild() {}, setAttribute() {}, children: [], value: '', hidden: false };
  }
  const storage = new Map(Object.entries({sonos_preset_revision:'20261006-impact', ...initialStorage}));
  const timers = new Map(); let timerId = 0;
  const context = vm.createContext({
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      addEventListener() {}, createElement: element, hidden: false, activeElement: null },
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval() {}, clearInterval() {}, AbortController, console,
    fetch() { throw new Error('Live network forbidden in UI tests'); }, assert,
  });
  const html = fs.readFileSync(require.resolve('../static/index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\ninit\(\);\s*$/, '');
  vm.runInContext(script, context);
  vm.runInContext('showToast = () => {};', context);
  return { run: code => vm.runInContext(code, context), storage, timers };
}

test('saved music surround is the observed value subsequently applied by the preset', async () => {
  const a = app();
  await a.run(`state.connected = true; state.roomNameEncoded='Living%20Room';
    var values={...DEFAULT_PRESETS[0].settings,surroundMusicLevel:13};
    apiCall=async()=>({values,controls:Object.fromEntries(Object.keys(values).map(key=>[key,{}]))});
    saveCurrentToPreset('normal');`);
  assert.equal(a.run('PRESETS[0].settings.surroundMusicLevel'), 13);
  assert.equal(JSON.parse(a.storage.get('sonos_custom_presets_v4'))[0].settings.surroundMusicLevel, 13);
});

test('discovery selects Living Room even when another room is listed first', async () => {
  const a = app();
  await a.run(`apiCall = async path => path === '/zones' ? [
    {coordinator:{roomName:'Kitchen',uuid:'k',state:{}},members:[]},
    {coordinator:{roomName:'Living Room',uuid:'arc',state:{}},members:[]}
  ] : {uuid:'arc',roomName:'Living Room',values:{bass:0},controls:{}}; discoverRoom();`);
  assert.equal(a.run("roomPath('bass/1')"), '/Living%20Room/bass/1');
});

test('empty topology clears connection instead of leaving a usable stale target', async () => {
  const a = app();
  await a.run("state.connected=true; state.roomName='Living Room'; state.roomNameEncoded='Living%20Room'; apiCall=async()=>[]; pollState();");
  assert.equal(a.run('state.connected'), false);
});

test('preset application cancels a pending manual slider change', async () => {
  const a = app();
  await a.run(`state.connected=true; state.roomName='Living Room'; state.roomNameEncoded='Living%20Room';
    var observed={...DEFAULT_PRESETS[0].settings,subGain:9}; var paths=[];
    apiCall=async path=>{ paths.push(path); const segments=path.split('/');
      if(segments.length===5) observed[segments[3]]=TOGGLES.includes(segments[3]) ? segments[4]==='true' : Number(segments[4]);
      return {values:{...observed},controls:Object.fromEntries(Object.keys(observed).map(key=>[key,{}]))}; };
    debouncedControlUpdate('subGain',9); applyPreset('normal');`);
  assert.equal(a.run("state.debounceTimers.subGain"), undefined);
  assert.equal(a.run('state.activePreset'), 'normal');
  assert.equal(a.run('observed.subGain'), 0);
  assert.equal(a.run("paths.includes('/Living%20Room/mix/subGain/9')"), false);
});

test('malformed and empty stored presets recover the usable default buttons', () => {
  for (const stored of ['[]', '{}', 'null', '[{"id":"normal","settings":{}}]']) {
    const a = app({sonos_custom_presets_v4:stored});
    assert.equal(a.run('PRESETS.length'), 3);
    assert.equal(a.run('PRESETS[0].settings.subGain'), 0);
  }
});

test('observed settings from another controller clear a stale active preset badge', async () => {
  const a = app({sonos_active_preset:'normal'});
  await a.run(`assert.equal(typeof updateFromMix,'function'); updateFromMix({values:{subGain:6,bass:0,treble:0,surroundTvLevel:4,surroundMusicLevel:4},controls:{}});`);
  assert.equal(a.run('state.activePreset'), null);
});

test('a failed slider write restores the observed value', async () => {
  const a = app();
  await a.run("state.connected=true; state.roomNameEncoded='Living%20Room'; state.current.bass=2; apiCall=async()=>{throw new Error('unavailable')}; applySlider('bass',7);");
  assert.equal(a.run('state.current.bass'), 2);
});

test('mix readback updates both surround sliders from the actual speaker values', () => {
  const a=app();
  a.run("updateFromMix({values:{surroundTvLevel:3,surroundMusicLevel:8},controls:{}});");
  assert.equal(a.run('state.current.surroundTvLevel'),3);
  assert.equal(a.run('state.current.surroundMusicLevel'),8);
});

test('an in-flight poll cannot overwrite a new manual adjustment', async () => {
  const a=app();
  const promise=a.run(`var resolveMix; apiCall=async path=>path==='/zones' ?
    [{coordinator:{roomName:'Living Room',uuid:'arc',state:{}},members:[]}] :
    new Promise(resolve=>{resolveMix=resolve}); var polling=pollState(); polling;`);
  // Let discovery reach its pending mix request before the manual edit.
  await Promise.resolve(); await Promise.resolve();
  a.run("debouncedControlUpdate('bass',7); resolveMix({uuid:'arc',values:{bass:0},controls:{}});");
  await promise;
  assert.equal(a.run('state.current.bass'), undefined);
  assert.equal(a.run('state.pendingValues.bass'),7);
});

test('old saved music alias is migrated without losing the original browser record', () => {
  const stored='[{"id":"normal","settings":{"bass":2,"surroundMusicLevel":4,"musicSurroundLevel":9}}]';
  const a=app({sonos_custom_presets_v4:stored});
  assert.equal(a.run('PRESETS[0].settings.surroundMusicLevel'),9);
  assert.equal(a.run('PRESETS[0].settings.bass'),2);
  assert.equal(a.storage.get('sonos_custom_presets_v4_backup_20261006'),stored);
});

test('failed focused toggles visibly return to the observed speaker value', async () => {
  const a=app();
  await a.run(`state.connected=true; state.roomNameEncoded='Living%20Room'; state.current.mute=false;
    state.controls={mute:{type:'toggle'}}; var toggle=document.getElementById('ctrl-mute');
    toggle.type='checkbox'; toggle.checked=true; document.activeElement=toggle;
    apiCall=async()=>{throw new Error('unavailable')}; applySlider('mute',true);`);
  assert.equal(a.run('toggle.checked'),false);
});

test('saving stops if a pending edit cannot reach the speaker', async () => {
  const a=app();
  await a.run(`state.connected=true; state.roomNameEncoded='Living%20Room'; var messages=[];
    showToast=message=>messages.push(message); debouncedControlUpdate('subGain',9);
    apiCall=async path=>{ if(path.includes('/subGain/')) throw new Error('unavailable');
      return {values:{subGain:0,bass:0,treble:0,surroundTvLevel:4,surroundMusicLevel:4},
        controls:{subGain:{},bass:{},treble:{},surroundTvLevel:{},surroundMusicLevel:{}}}; };
    saveCurrentToPreset('normal');`);
  assert.equal(a.storage.get('sonos_custom_presets_v4'),undefined);
  assert.equal(a.run("messages.some(m=>m.startsWith('Saved '))"),false);
});

test('readback field arrival order does not rebuild controls while they are focused', () => {
  const a=app();
  a.run(`var rebuilds=0; renderControls=()=>{rebuilds++};
    updateFromMix({values:{bass:0,treble:0},controls:{bass:{type:'range',min:-10,max:10},treble:{type:'range',min:-10,max:10}}});
    updateFromMix({values:{bass:1,treble:0},controls:{treble:{type:'range',min:-10,max:10},bass:{type:'range',min:-10,max:10}}});`);
  assert.equal(a.run('rebuilds'),1);
});

test('the recipe update replaces existing phone presets once and preserves their original record', () => {
  const stored=JSON.stringify([{id:'normal',settings:{bass:3,subGain:7}},
    {id:'musicmovies',settings:{bass:2,subGain:5,surroundMusicLevel:12}}]);
  const a=app({sonos_custom_presets_v4:stored,sonos_preset_revision:'previous'});
  assert.equal(a.run('PRESETS[1].settings.subGain'),15);
  assert.equal(a.run('PRESETS[1].settings.surroundMusicLevel'),15);
  assert.equal(a.run('PRESETS[0].settings.surroundTvLevel'),-6);
  assert.equal(a.storage.get('sonos_custom_presets_v4_backup_20261006_impact'),stored);
  assert.equal(a.storage.get('sonos_preset_revision'),'20261006-impact');
  const saved=JSON.parse(a.storage.get('sonos_custom_presets_v4'));
  saved[1].settings.subGain=11;
  const b=app(Object.fromEntries(a.storage.entries()));
  b.storage.set('sonos_custom_presets_v4',JSON.stringify(saved));
  b.run('loadPresets()');
  assert.equal(b.run('PRESETS[1].settings.subGain'),11);
  assert.equal(b.storage.get('sonos_custom_presets_v4_backup_20261006_impact'),stored);
});

test('recipe migration does not overwrite old presets when their backup cannot be saved', () => {
  const stored='[{"id":"musicmovies","settings":{"subGain":5}}]';
  const a=app({sonos_custom_presets_v4:stored,sonos_preset_revision:'previous'});
  a.storage.set('sonos_custom_presets_v4',stored); a.storage.delete('sonos_preset_revision');
  a.storage.delete('sonos_custom_presets_v4_backup_20261006_impact');
  a.run('writeStorage=()=>false; loadPresets();');
  assert.equal(a.storage.get('sonos_custom_presets_v4'),stored);
  assert.equal(a.storage.get('sonos_preset_revision'),undefined);
});

test('switching the new recipes resets the entire mix while leaving everyday volume alone', async () => {
  const a=app();
  await a.run(`(async()=>{state.connected=true; state.roomNameEncoded='Living%20Room';
    var observed={...DEFAULT_PRESETS[0].settings,volume:32,mute:false,audioDelay:0,trueplay:true};
    var writes=[];
    apiCall=async path=>{ const segments=path.split('/');
      if(segments.length===5) { var key=segments[3]; writes.push(key);
        observed[key]=TOGGLES.includes(key) ? segments[4]==='true' : Number(segments[4]); }
      return {values:{...observed},controls:Object.fromEntries(Object.keys(observed).map(key=>[key,{}]))}; };
    await applyPreset('musicmovies');
    assert.equal(observed.subGain,15); assert.equal(observed.heightLevel,10);
    assert.equal(observed.surroundMode,1); assert.equal(observed.speechEnabled,false);
    await applyPreset('normal');
    assert.equal(observed.subGain,0); assert.equal(observed.heightLevel,0);
    assert.equal(observed.surroundTvLevel,-6); assert.equal(observed.surroundMode,0);
    assert.equal(observed.speechEnabled,true); assert.equal(observed.speechLevel,2);
    assert.equal(observed.volume,32); assert.equal(observed.mute,false);
    assert.equal(observed.trueplay,true); assert.equal(observed.audioDelay,0);
    assert.equal(writes.some(key=>['volume','mute','audioDelay','trueplay'].includes(key)),false);})();`);
  assert.equal(a.run('state.activePreset'),'normal');
});

test('MAX applies the maximum mix and only then raises master volume to 100', async () => {
  const a=app();
  await a.run(`(async()=>{ state.connected=true; state.roomNameEncoded='Living%20Room';
    var observed={...DEFAULT_PRESETS[0].settings,volume:32,mute:false,audioDelay:0,trueplay:true};
    var writes=[];
    apiCall=async path=>{ const parts=path.split('/');
      if(parts.length===5){ writes.push(parts[3]);
        observed[parts[3]]=TOGGLES.includes(parts[3]) ? parts[4]==='true' : Number(parts[4]); }
      return {values:{...observed},controls:Object.fromEntries(Object.keys(observed).map(key=>[key,{}]))}; };
    await applyPreset('max');
    assert.equal(observed.volume,100); assert.equal(writes.at(-1),'volume');
    for(const key of ['bass','treble','subGain','surroundTvLevel','surroundMusicLevel','heightLevel','speechLevel'])
      assert.equal(observed[key],LIMITS[key][1]);
    assert.equal(observed.loudness,true); assert.equal(observed.nightMode,false);
    assert.equal(observed.subEnabled,true); assert.equal(observed.surroundEnabled,true);
    assert.equal(observed.surroundMode,1); assert.equal(observed.speechEnabled,true);
    assert.equal(observed.mute,false); assert.equal(observed.trueplay,true); assert.equal(observed.audioDelay,0);
  })();`);
  assert.equal(a.run('state.activePreset'),'max');
});

test('a failed MAX mix adjustment prevents the volume jump', async () => {
  const a=app();
  await a.run(`(async()=>{state.connected=true; state.roomNameEncoded='Living%20Room';
    var observed={...DEFAULT_PRESETS[0].settings,volume:32}; var writes=[];
    apiCall=async path=>{ const parts=path.split('/');
      if(parts.length===5){writes.push(parts[3]); if(parts[3]==='bass')throw new Error('rejected');
        observed[parts[3]]=TOGGLES.includes(parts[3]) ? parts[4]==='true' : Number(parts[4]); }
      return {values:{...observed},controls:Object.fromEntries(Object.keys(observed).map(key=>[key,{}]))}; };
    await applyPreset('max'); assert.equal(observed.volume,32); assert.equal(writes.includes('volume'),false);
  })();`);
  assert.equal(a.run('state.activePreset'),null);
});

test('adding MAX keeps custom everyday presets and its fixed recipe ignores stored overrides', async () => {
  const stored=JSON.stringify([{id:'normal',settings:{bass:3}},
    {id:'musicmovies',settings:{subGain:11}}, {id:'max',settings:{bass:-10,volume:4}}]);
  const a=app({sonos_custom_presets_v4:stored});
  assert.equal(a.run('PRESETS[0].settings.bass'),3);
  assert.equal(a.run('PRESETS[1].settings.subGain'),11);
  assert.equal(a.run("PRESETS.find(p=>p.id==='max').settings.bass"),10);
  assert.equal(a.run("PRESETS.find(p=>p.id==='max').settings.volume"),100);
  a.run('renderControls()');
  assert.equal(a.run('dom.controlsContent.innerHTML.includes(\'data-save="max"\')'),false);
  await a.run("state.connected=true; saveCurrentToPreset('max');");
  assert.equal(a.storage.get('sonos_custom_presets_v4'),stored);
});
