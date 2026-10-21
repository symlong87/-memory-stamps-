'use strict';
window.stampStorage = (() => {
  let databasePromise, mode = 'browser', diskAvailable = false;
  const fileDataURL = file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
  });
  function database() {
    if (databasePromise) return databasePromise;
    const opening = new Promise((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => fail(new Error('存储连接超时，请关闭其他旧版邮册标签页后重试。')), 6000);
      function fail(error) { if (finished) return; finished = true; clearTimeout(timer); reject(error); }
      let request;
      try { request = indexedDB.open('monet-post-collection', 2); }
      catch (error) { fail(error); return; }
      request.onupgradeneeded = () => {
        for (const store of ['stamps', 'edits']) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, {keyPath:'id'});
      };
      request.onsuccess = () => {
        if (finished) { request.result.close(); return; }
        finished = true; clearTimeout(timer);
        request.result.onversionchange = () => { request.result.close(); databasePromise = null; };
        request.result.onclose = () => { databasePromise = null; };
        resolve(request.result);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail(new Error('请关闭其他旧版邮册标签页，再点击保存重试。'));
    });
    databasePromise = opening;
    opening.catch(() => { if (databasePromise === opening) databasePromise = null; });
    return opening;
  }
  async function browserLoad() {
    const db = await database();
    const read = name => new Promise((resolve, reject) => {
      const request = db.transaction(name).objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const [stamps, edits] = await Promise.all([read('stamps'), read('edits')]);
    return {stamps, edits};
  }
  async function transaction(store, action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => { databasePromise = null; reject(tx.error || new Error('存储写入中断，请重试。')); };
      try { action(tx.objectStore(store)); } catch (error) { tx.abort(); reject(error); }
    });
  }
  async function diskWrite(body) {
    let response;
    try { response = await fetch('/api/collection', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}); }
    catch { throw new Error('本地保存服务已断开。请重新启动“打开邮册”后再点保存，已选图片会保留。'); }
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '本地邮册保存失败，请重新启动“打开邮册”。');
    return value;
  }
  async function add(records) {
    if (diskAvailable) {
      const values = [];
      for (const {file, bytes, mime, ...record} of records) {
        if (!record.sourceHash && crypto.subtle) {
          const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
          record.sourceHash = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('');
        }
        values.push({...record, dataURL:await fileDataURL(file)});
      }
      await diskWrite({operation:'add', records:values});
    } else {
      // Store bytes rather than a File object for browsers that cannot clone files into IndexedDB.
      const values = [];
      for (const {file, ...record} of records) values.push({...record, bytes:await file.arrayBuffer(), mime:file.type});
      await transaction('stamps', store => values.forEach(value => store.put(value)));
    }
  }
  async function edit(patch) {
    if (diskAvailable) await diskWrite({operation:'edit', patch});
    else await transaction('edits', store => {
      const request = store.get(patch.id);
      request.onsuccess = () => store.put({...request.result, ...patch});
    });
  }
  async function load() {
    if (['127.0.0.1','localhost'].includes(location.hostname)) {
      let response;
      try { response = await fetch('/api/collection'); } catch { /* A plain static server can use browser storage. */ }
      if (response?.headers.get('Content-Type')?.includes('application/json')) {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        diskAvailable = true; mode = 'disk';
        // Retain and migrate earlier browser imports without deleting the browser copy.
        let previous;
        try { previous = await browserLoad(); } catch { return value; }
        const ids = new Set(value.stamps.map(s => s.id));
        const pending = previous.stamps.filter(s => !ids.has(s.id));
        for (const record of pending) {
          const file = record.file || new Blob([record.bytes], {type:record.mime});
          await add([{...record, file}]);
        }
        for (const patch of previous.edits) {
          const saved = value.edits.find(e => e.id === patch.id);
          if (!saved || (patch.updatedAt || 0) > (saved.updatedAt || 0)) await edit(patch);
        }
        const result = await fetch('/api/collection');
        if (!result.ok) throw new Error('无法读取保存后的本地邮册，请重试。');
        return result.json();
      }
    }
    return browserLoad();
  }
  function errorMessage(error) {
    if (error?.name === 'QuotaExceededError') return '存储空间不足。请使用本地“打开邮册”保存到电脑，或腾出浏览器存储空间后重试。';
    if (['SecurityError','InvalidStateError','UnknownError'].includes(error?.name)) return '浏览器未允许保存。请通过网站地址访问，或使用本地“打开邮册”；允许网站存储后可再次保存。';
    return error?.message || '未能保存，请重试。';
  }
  return {load, add, edit, errorMessage, get mode() { return mode; }};
})();
