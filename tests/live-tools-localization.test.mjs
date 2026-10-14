import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createI18nRuntime} from '../extension/lib/i18n.mjs';
import {SUPPORTED_LOCALES, loadLocaleMessages} from '../extension/lib/i18n-registry.mjs';
import {createToolCallGroup} from '../extension/lib/tool-call-group.mjs';

for (const {id} of SUPPORTED_LOCALES) {
  test(`live tool labels and held drafts are translated in ${id}`,async()=>{
    const runtime=createI18nRuntime({documentRef:null,storageArea:null,storageEvents:null});
    await runtime.init();
    await runtime.setLocale(id);
    const catalog=await loadLocaleMessages(id);
    const {document}=parseHTML('<html><body></body></html>');
    for (const count of [1,2,5]) {
      const calls=Array.from({length:count},()=>({tool_name:'terminal',status:'completed'}));
      for (const running of [true,false]) {
        const group=createToolCallGroup({document,calls,running,translate:runtime.translateText,formatCountLabel:runtime.t});
        const key=running?'live_tools.using_count':'live_tools.used_count';
        assert.equal(group.querySelector('.tool-call-group-title').textContent,runtime.t(key,{count}));
        assert.ok(group.querySelector('.tool-call-group-title').textContent.includes(String(count)));
        assert.equal(group.querySelector('.tool-call-status').textContent,catalog['live_tools.completed']);
        assert.equal(group.querySelector('.tool-call-name').textContent,'terminal');
      }
    }
    for (const [label,key] of [['Completed','live_tools.completed'],['Failed','live_tools.failed'],['Running','live_tools.running'],['Restore draft','composer.restore_held_draft'],['Another session is running','composer.other_session_running']]) {
      assert.equal(runtime.translateText(label),catalog[key]);
      if (id!=='en') assert.notEqual(catalog[key],label);
    }
    runtime.destroy();
  });
}
