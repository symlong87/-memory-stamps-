'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const safe = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
let stamps = window.INITIAL_STAMPS.map(s => ({ ...s, tags: [...(s.tags || [])] }));
let favorites = new Set(), toastTimer, activeFlip, editId;
let preparingPageFlip = false, pageTurnRequest = 0;
let routeSequence = 0, routeAnimations = [], preloadTimer, routeTarget;
const imageCache = new Map();
const readerMedia = matchMedia('(max-width: 650px)');
const pageSize = () => readerMedia.matches ? 1 : 2;
let currentPageSize = pageSize();
let swipeStart, suppressStampClickUntil = 0;
let uploadQueue = [], uploadGeneration = 0, preparingUploads = false;
try { favorites = new Set(JSON.parse(localStorage.getItem('monet-favorites') || '[]')); } catch {}
const collectionQueries = {'three-cities':'三城旅行', 'landscape-letters':'风景来信第二辑'};
const state = { category: 'all', query: collectionQueries[new URLSearchParams(location.search).get('collection')] || '', page: 0, view: 'album', detailId: null, screen: 'home' };
const normalizeTags = value => [...new Set((Array.isArray(value) ? value : String(value).split(/[,，、;；\s#]+/)).map(t => String(t).trim().replace(/^#+/, '').slice(0, 20)).filter(Boolean))].slice(0, 12);
const newId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

function pageFromLocation() { return location.hash === '#collection' ? 'collection' : 'home'; }
function setScreen(page) {
  routeTarget = page; state.screen = page;
  document.body.dataset.page = page;
  for (const section of $$('.screen')) {
    section.hidden = section.id !== page;
    section.inert = section.hidden;
  }
  for (const link of $$('.site-header nav [data-route]')) {
    const active = link.dataset.route === page;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  document.title = page === 'home' ? '记忆邮票 — 方寸之间，皆是远方' : '我的集邮册 · 记忆邮票';
}
async function showScreen(page, {push = true, animate = true, focus = true} = {}) {
  if (!['home','collection'].includes(page)) return;
  routeTarget = page;
  const request = ++routeSequence;
  routeAnimations.forEach(animation => animation.cancel()); routeAnimations = [];
  cancelPageFlip();
  if (push) {
    const url = new URL(location.href); url.hash = page === 'collection' ? 'collection' : 'home';
    if (url.href !== location.href) history.pushState({page}, '', url);
  }
  const outgoing = $$('.screen').find(section => !section.hidden), incoming = $('#'+page);
  const motion = animate && outgoing !== incoming && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.body.classList.toggle('is-navigating', motion);
  try {
    if (motion && outgoing) {
      outgoing.inert = true;
      const exit = outgoing.animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:page === 'collection' ? 'scale(1.025)' : 'scale(.99)'}], {duration:170,easing:'ease-in',fill:'forwards'});
      routeAnimations.push(exit); await exit.finished.catch(() => {});
      if (request !== routeSequence) return;
    }
    setScreen(page);
    window.scrollTo({top:0,behavior:'instant'});
    schedulePreload();
    if (motion) {
      incoming.inert = true;
      const enter = incoming.animate([{opacity:0,transform:'translateY(12px) scale(.985)'},{opacity:1,transform:'translateY(0) scale(1)'}], {duration:330,easing:'cubic-bezier(.2,.65,.3,1)',fill:'both'});
      routeAnimations.push(enter); await enter.finished.catch(() => {});
      if (request !== routeSequence) return;
    }
    if (focus) $(page === 'home' ? '#hero-title' : '#collection-title').focus({preventScroll:true});
  } finally {
    if (request === routeSequence) {
      routeAnimations.forEach(animation => animation.cancel()); routeAnimations = [];
      incoming.inert = false; document.body.classList.remove('is-navigating');
    }
  }
}
document.addEventListener('click', event => {
  const link = event.target.closest('a[data-route]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); showScreen(link.dataset.route);
});
window.addEventListener('popstate', () => showScreen(pageFromLocation(), {push:false,focus:false}));
window.addEventListener('hashchange', () => {
  if (pageFromLocation() !== routeTarget) showScreen(pageFromLocation(), {push:false,focus:false});
});

function notify(message) {
  $('#toast').textContent = message; $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2700);
}
async function loadCustomStamps() {
  try {
    const data = await stampStorage.load();
    const records = data.stamps.sort((a,b) => a.createdAt - b.createdAt);
    for (const r of records) {
      const file = r.file || (r.bytes ? new Blob([r.bytes], {type:r.mime}) : null);
      const hash = r.sourceHash || (file ? await imageHash(file) : '');
      if (hash && stamps.some(s => s.sourceHash === hash)) continue;
      const url = r.image || (file ? URL.createObjectURL(file) : '');
      if (url) stamps.push({...r, file, sourceHash:hash, tags:normalizeTags(r.tags || []), image:url, original:r.original || url, number:String(stamps.length+1).padStart(3,'0')});
    }
    const fields = ['title','category','place','description','tags','deletedAt'];
    for (const patch of data.edits) {
      const stamp = stamps.find(s => s.id === patch.id);
      if (stamp) for (const key of fields) if (Object.hasOwn(patch,key)) stamp[key] = key === 'tags' ? normalizeTags(patch[key]) : key === 'deletedAt' ? Number(patch[key]) : String(patch[key]);
    }
    updateStorageNote(); render();
  } catch (error) { updateStorageNote(stampStorage.errorMessage(error)); notify('原有藏品仍可浏览。'+stampStorage.errorMessage(error)); }
}
async function imageHash(file) {
  if (!crypto.subtle) return '';
  const bytes = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2,'0')).join('');
}
function updateStorageNote(error) {
  const text = error || (stampStorage.mode === 'disk' ? '本地文件保存已开启：新增图片、描述和移除记录会保留在电脑中。' : '新增图片、描述和移除记录保存在当前浏览器，不跨设备同步。');
  $('#storage-status').textContent = text;
  $$('.storage-note').forEach(note => note.textContent = text);
}
function filteredStamps() {
  const q = state.query.trim().toLocaleLowerCase();
  return stamps.filter(s => !s.deletedAt && (state.category === 'all' || (state.category === 'favorites' ? favorites.has(s.id) : s.category === state.category)) && (!q || [s.title,s.english,s.place,s.category,s.description,...(s.tags || [])].join(' ').toLocaleLowerCase().includes(q)));
}
function stampCard(s, eager = false) {
  const liked = favorites.has(s.id);
  return `<article class="stamp-card"><button class="stamp-open" data-open="${safe(s.id)}" aria-label="欣赏${safe(s.title)}邮票"><span class="stamp-mount"><img src="${safe(s.image)}" alt="${safe(s.title)} · 记忆邮票" width="800" height="1200" loading="${eager ? 'eager' : 'lazy'}" decoding="async"><span class="mount-strip" aria-hidden="true"></span></span><span class="stamp-caption"><span class="stamp-title">${safe(s.title)}</span><span class="stamp-id">N° ${safe(s.number)}</span></span><span class="stamp-place">${safe(s.place || '一处值得珍藏的风景')}</span><span class="stamp-tags">${(s.tags || []).slice(0,2).map(t => `<span># ${safe(t)}</span>`).join('')}</span></button><button class="favorite-button ${liked ? 'is-favorite' : ''}" data-favorite="${safe(s.id)}" aria-label="${liked ? '取消心选' : '加入心选'}：${safe(s.title)}" aria-pressed="${liked}">${icon('heart')}</button></article>`;
}
function albumPage(items, side, pageNumber) {
  const category = state.query === '三城旅行' ? '三城旅行' : state.query === '风景来信第二辑' ? '风景来信 · 第二辑' : ['all','favorites'].includes(state.category) ? '风景来信' : state.category;
  return `<div class="album-page" data-side="${side}"><div class="page-heading"><span>${side === 'left' ? 'MEMORY IMPRESSIONS' : 'PLACES TO REMEMBER'}</span><span class="page-heading-cn">${category} · ${pad(pageNumber)}</span></div><div class="page-stamps">${items.length ? items.map(s => stampCard(s, true)).join('') : '<div class="blank-page"><span>✳</span><p>下一枚风景，<br>正在路上。</p><small>ROOM FOR ANOTHER MEMORY</small></div>'}</div><div class="page-footer"><span>${items.length ? '藏品 '+items.map(s => s.number).join(' · ') : '留一页，给下一次抵达'}</span><b>— ${pad(pageNumber)} —</b><span>MEMORY POST</span></div></div>`;
}
function spreadHTML(list, page) {
  const size = pageSize(), start = page*size, visible = list.slice(start,start+size);
  if (size === 1) return albumPage(visible,'single',start+1);
  return albumPage(visible.slice(0,1),'left',start+1) + albumPage(visible.slice(1),'right',start+2);
}
function updatePager() {
  const total = filteredStamps().length, size = pageSize(), pages = Math.max(1,Math.ceil(total/size));
  const first = state.page*size+1, last = Math.min(total,first+size-1);
  $('#page-indicator').innerHTML = `${pad(first)}${last > first ? '–'+pad(last) : ''} <i>/</i> ${pad(total)}`;
  $('#page-indicator').setAttribute('aria-label',`当前第 ${first}${last > first ? ' 至 '+last : ''} 枚，共 ${total} 枚`);
  const busy = !!activeFlip || preparingPageFlip;
  $('#prev-page').disabled = busy || state.page === 0;
  $('#next-page').disabled = busy || state.page >= pages-1;
}
function warmImage(url) {
  if (imageCache.has(url)) return imageCache.get(url).promise;
  const image = new Image(); image.decoding = 'async'; image.fetchPriority = 'low'; image.src = url;
  const entry = {image, promise:image.decode().catch(() => {})};
  imageCache.set(url,entry); return entry.promise;
}
function schedulePreload() {
  clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    if (state.view !== 'album') return;
    const list = filteredStamps(), size = pageSize();
    const nearby = state.screen === 'home' ? list.slice(state.page*size,(state.page+2)*size) : [...list.slice(Math.max(0,state.page-1)*size,state.page*size),...list.slice((state.page+1)*size,(state.page+2)*size)];
    const keep = new Set(nearby.map(s => s.image));
    for (const url of imageCache.keys()) if (!keep.has(url)) imageCache.delete(url);
    nearby.forEach(s => warmImage(s.image));
  },100);
}
function render() {
  cancelPageFlip();
  const list = filteredStamps(), pages = Math.max(1, Math.ceil(list.length / pageSize()));
  state.page = Math.min(state.page, pages - 1);
  const count = stamps.filter(s => !s.deletedAt).length;
  $('#hero-count').textContent = count; $('#total-count').textContent = count;
  $('#removed-count').textContent = stamps.filter(s => s.deletedAt).length;
  const filtered = state.category !== 'all' || !!state.query;
  const label = state.query ? `“${state.query}”` : state.category === 'favorites' ? '我的心选' : state.category === 'all' ? '全部藏品' : state.category;
  $('#reading-summary').textContent = `${label} · ${list.length} 枚`;
  $('#clear-search').hidden = !filtered;
  $('#toggle-filters').classList.toggle('has-filter',filtered);
  if ($('#manage-dialog').open) renderManage();
  $$('.filter').forEach(b => { const active = b.dataset.category === state.category; b.classList.toggle('active', active); b.setAttribute('aria-pressed', active); });
  ['album','grid'].forEach(v => { $('#'+v+'-view').classList.toggle('selected',state.view === v); $('#'+v+'-view').setAttribute('aria-pressed',state.view === v); });
  $('#album-shell').hidden = state.view !== 'album' || !list.length;
  $('#grid').hidden = state.view !== 'grid' || !list.length;
  $('#album-controls').hidden = !list.length; $('#empty').hidden = !!list.length;
  $('#empty-text').textContent = state.category === 'favorites' ? '轻点邮票上的爱心，把喜欢的风景收入心选。' : '试试其他分类，或换一个关键词。';
  if (state.view === 'album') {
    $('#album-spread').innerHTML = spreadHTML(list,state.page);
    $('#grid').replaceChildren();
  } else {
    $('#grid').innerHTML = list.map(s => stampCard(s)).join('');
    $('#album-spread').replaceChildren();
  }
  $('.pagination').hidden = state.view !== 'album';
  updatePager(); schedulePreload();
}
function updateDetailFavorite() {
  const liked = favorites.has(state.detailId);
  $('#detail-favorite').classList.toggle('is-favorite', liked);
  $('#detail-favorite').setAttribute('aria-pressed', liked);
  $('#detail-favorite span').textContent = liked ? '已收入心选' : '加入心选';
}
function toggleFavorite(id) {
  if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
  try { localStorage.setItem('monet-favorites', JSON.stringify([...favorites])); }
  catch { notify('心选已更新，但当前浏览器无法保存心选记录。'); }
  render(); if (state.detailId === id) updateDetailFavorite();
}
function detailSequence() { const list = filteredStamps(); return list.some(s => s.id === state.detailId) ? list : stamps.filter(s => !s.deletedAt); }
function openDetail(id) {
  const s = stamps.find(s => s.id === id); if (!s) return;
  state.detailId = id;
  $('#detail-image').src = s.image; $('#detail-image').alt = s.title+'邮票原作';
  $('#detail-title').textContent = s.title; $('#detail-english').textContent = s.english;
  $('#detail-category').textContent = s.category;
  $('#detail-number').textContent = 'MEMORY POST / COLLECTION N° '+s.number;
  $('#detail-place').textContent = s.place || '一处值得珍藏的风景';
  $('#detail-description').textContent = s.description || '这一处风景，值得慢慢回望。';
  $('#detail-tags').innerHTML = (s.tags || []).map(t => `<button type="button" data-tag="${safe(t)}" aria-label="按标签筛选：${safe(t)}"># ${safe(t)}</button>`).join('');
  $('#detail-size').textContent = `${s.width || 1024} × ${s.height || 1536} px`;
  $('#detail-series').textContent = s.series || (s.custom ? '我的新收藏' : '记忆邮票 · 风景来信');
  $('#download-image').href = s.original; $('#download-image').download = `${s.title}-记忆邮票.${s.extension || 'png'}`;
  const sequence = detailSequence(), index = sequence.findIndex(s => s.id === id);
  $('#detail-position').textContent = `${pad(index+1)} / ${pad(sequence.length)}`;
  $('#detail-prev').disabled = index === 0; $('#detail-next').disabled = index === sequence.length-1;
  updateDetailFavorite();
  if (!$('#detail-dialog').open) { $('.detail-manage').open = false; $('#detail-dialog').showModal(); }
  $('#detail-dialog').scrollTop = 0;
}
function stepDetail(direction) {
  const list = detailSequence(), index = list.findIndex(s => s.id === state.detailId);
  if (list[index+direction]) openDetail(list[index+direction].id);
}
async function changePage(direction) {
  if (state.screen !== 'collection' || state.view !== 'album' || document.body.classList.contains('is-navigating') || activeFlip || preparingPageFlip) return;
  const list = filteredStamps(), target = state.page+direction;
  if (target < 0 || target >= Math.ceil(list.length/pageSize())) return;
  const request = ++pageTurnRequest;
  preparingPageFlip = true; $('#album-shell').setAttribute('aria-busy','true'); updatePager();
  const ready = Promise.all(list.slice(target*pageSize(),(target+1)*pageSize()).map(s => warmImage(s.image)));
  // Adjacent pages normally decode in advance; a slow image cannot hold the controls indefinitely.
  await Promise.race([ready,new Promise(resolve => setTimeout(resolve,220))]);
  if (request !== pageTurnRequest) return;
  const oldSpread = $('#album-spread'), height = oldSpread.getBoundingClientRect().height;
  const nextSpread = document.createElement('div');
  nextSpread.id = 'album-spread'; nextSpread.className = 'album-spread'; nextSpread.setAttribute('aria-live','polite');
  nextSpread.innerHTML = spreadHTML(list,target);
  state.page = target; preparingPageFlip = false;
  oldSpread.replaceWith(nextSpread);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('#album-shell').removeAttribute('aria-busy'); updatePager(); schedulePreload(); return;
  }
  nextSpread.style.height = height+'px';
  animatePageFlip(direction,oldSpread,nextSpread);
}
function cancelPageFlip() {
  pageTurnRequest += 1; preparingPageFlip = false;
  if (activeFlip) {
    const flip = activeFlip; activeFlip = null;
    flip.animation.cancel(); flip.scene.remove();
  }
  const shell = $('#album-shell');
  shell.classList.remove('is-turning'); shell.removeAttribute('aria-busy');
  $('#album-spread').style.height = '';
  updatePager();
}
function animatePageFlip(direction,oldSpread,nextSpread) {
  const mobile = readerMedia.matches;
  const scene = document.createElement('div');
  scene.className = `flip-scene ${direction > 0 ? 'turn-forward' : 'turn-backward'}${mobile ? ' mobile-turn' : ''}`;
  scene.setAttribute('aria-hidden','true'); scene.inert = true;
  const sheet = document.createElement('div'); sheet.className = 'flip-sheet';
  const front = document.createElement('div'), back = document.createElement('div');
  front.className = 'flip-face flip-front'; back.className = 'flip-face flip-back';
  oldSpread.removeAttribute('id'); oldSpread.removeAttribute('aria-live');
  if (mobile) {
    front.append(oldSpread.firstElementChild);
    // The underside stays quiet; the next artwork is already visible underneath.
    const underside = document.createElement('div'); underside.className = 'paper-underside';
    underside.innerHTML = '<span>✳</span><small>记忆邮票</small>'; back.append(underside);
  } else {
    const oldPages = [...oldSpread.children], newPages = [...nextSpread.children];
    const staticPage = oldPages[direction > 0 ? 0 : 1]; staticPage.classList.add('flip-static');
    scene.append(staticPage); front.append(oldPages[direction > 0 ? 1 : 0]);
    back.append(newPages[direction > 0 ? 0 : 1].cloneNode(true));
  }
  for (const image of scene.querySelectorAll('img')) image.loading = 'eager';
  sheet.append(front,back); scene.append(sheet); $('#album-shell').append(scene);
  $('#album-shell').classList.add('is-turning');
  const degrees = direction > 0 ? (mobile ? -105 : -180) : (mobile ? 105 : 180);
  const frames = mobile ? [{transform:'rotateY(0deg)',opacity:1},{transform:`rotateY(${degrees*.8}deg)`,opacity:1,offset:.78},{transform:`rotateY(${degrees}deg)`,opacity:0}] : [{transform:'rotateY(0deg)'},{transform:`rotateY(${degrees}deg)`}];
  const animation = sheet.animate(frames, {duration:mobile?380:500,delay:16,easing:'cubic-bezier(.3,.08,.25,1)',fill:'both'});
  const flip = {animation,scene}; activeFlip = flip; updatePager();
  animation.finished.then(() => {
    if (activeFlip !== flip) return;
    activeFlip = null; scene.remove(); nextSpread.style.height = '';
    $('#album-shell').classList.remove('is-turning'); $('#album-shell').removeAttribute('aria-busy');
    updatePager(); schedulePreload();
  }).catch(() => {});
}
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer); resizeTimer = setTimeout(() => {
    const size = pageSize();
    if (size !== currentPageSize) {
      state.page = Math.floor(state.page*currentPageSize/size); currentPageSize = size; render();
    } else { cancelPageFlip(); schedulePreload(); }
  },80);
});
function resetFilters() { state.category = 'all'; state.query = ''; state.page = 0; $('#search').value = ''; render(); }
$$('.filter').forEach(b => b.addEventListener('click', () => { state.category = b.dataset.category; state.page = 0; render(); }));
$('#search').value = state.query;
function showSeries(query) { state.category='all'; state.query=query; state.page=0; $('#search').value=query; render(); }
$('#show-new-stamps').addEventListener('click', () => showSeries('风景来信第二辑'));
$('#show-travel-stamps').addEventListener('click', () => showSeries('三城旅行'));
$('#search').addEventListener('input', e => { state.query = e.target.value; state.page = 0; render(); });
$('#reset-filters').addEventListener('click',resetFilters);
$('#clear-search').addEventListener('click',resetFilters);
$('#toggle-filters').addEventListener('click',() => {
  const panel = $('#filter-panel'), button = $('#toggle-filters');
  panel.hidden = !panel.hidden; button.setAttribute('aria-expanded',!panel.hidden);
  button.querySelector('span').textContent = panel.hidden ? '＋' : '−';
});
$('#album-view').addEventListener('click', () => { state.view = 'album'; render(); });
$('#grid-view').addEventListener('click', () => { state.view = 'grid'; render(); });
$('#prev-page').addEventListener('click', () => changePage(-1));
$('#next-page').addEventListener('click', () => changePage(1));
$('#detail-prev').addEventListener('click', () => stepDetail(-1));
$('#detail-next').addEventListener('click', () => stepDetail(1));
$('#detail-favorite').addEventListener('click', () => toggleFavorite(state.detailId));
$('.collection').addEventListener('click', e => {
  if (Date.now() < suppressStampClickUntil) return;
  const open = e.target.closest('[data-open]'), favorite = e.target.closest('[data-favorite]');
  if (open) openDetail(open.dataset.open); if (favorite) toggleFavorite(favorite.dataset.favorite);
});
$$('dialog').forEach(dialog => {
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (dialog.id === 'zoom-dialog' || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
});
$('#zoom-image').addEventListener('click', () => {
  const s = stamps.find(s => s.id === state.detailId);
  $('#zoom-art').src = s.original; $('#zoom-art').alt = s.title+'邮票完整原图'; $('#zoom-dialog').showModal();
});
document.addEventListener('keydown', e => {
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) || $$('dialog[open]').some(dialog => dialog.id !== 'detail-dialog')) return;
  if (e.key === 'ArrowRight') { if ($('#detail-dialog').open) stepDetail(1); else if (state.screen === 'collection' && state.view === 'album') changePage(1); }
  if (e.key === 'ArrowLeft') { if ($('#detail-dialog').open) stepDetail(-1); else if (state.screen === 'collection' && state.view === 'album') changePage(-1); }
});
function openEdit() {
  const stamp = stamps.find(s => s.id === state.detailId);
  if (!stamp) return;
  editId = stamp.id;
  $('#edit-preview-image').src = stamp.image;
  $('#edit-preview-image').alt = stamp.title;
  $('#edit-preview-name').textContent = stamp.title;
  $('#edit-name').value = stamp.title;
  $('#edit-category').value = stamp.category;
  $('#edit-place').value = stamp.place || '';
  $('#edit-description').value = stamp.description || '';
  $('#edit-tags').value = (stamp.tags || []).join('，');
  $('#edit-error').textContent = '';
  $('#edit-dialog').showModal();
}
$('#edit-stamp').addEventListener('click', openEdit);
$('#cancel-edit').addEventListener('click', () => $('#edit-dialog').close());
$('#edit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const title = $('#edit-name').value.trim();
  if (!title) { $('#edit-error').textContent = '请为这枚邮票填写名称。'; return; }
  const patch = { id:editId, title, category:$('#edit-category').value, place:$('#edit-place').value.trim(), description:$('#edit-description').value.trim(), tags:normalizeTags($('#edit-tags').value), updatedAt:Date.now() };
  const button = $('#save-edit'); button.disabled = true;
  try {
    await collectionReady;
    await stampStorage.edit(patch);
    const stamp = stamps.find(s => s.id === patch.id);
    Object.assign(stamp,patch);
    render(); openDetail(stamp.id); $('#edit-dialog').close(); notify('描述与标签已保存。');
  } catch (error) { $('#edit-error').textContent = stampStorage.errorMessage(error); }
  finally { button.disabled = false; }
});
$('#detail-tags').addEventListener('click', event => {
  const button = event.target.closest('[data-tag]'); if (!button) return;
  state.category = 'all'; state.page = 0; state.query = button.dataset.tag;
  $('#search').value = state.query;
  $('#detail-dialog').close(); render(); $('#collection').scrollIntoView({behavior:'smooth'});
});

function renderUploadQueue() {
  $('#upload-queue').innerHTML = uploadQueue.map((item,index) => `<div class="upload-item"><img src="${safe(item.url)}" alt="${safe(item.file.name)}"><div><label>邮票名称<input ${index===0?'id="stamp-title"':''} data-upload-title="${safe(item.id)}" value="${safe(item.title)}" maxlength="40" required></label><small>${item.width} × ${item.height} · ${(item.file.size/1024/1024).toFixed(1)} MB</small></div><button type="button" data-remove-upload="${safe(item.id)}" class="remove-upload" aria-label="移除待导入图片：${safe(item.file.name)}">${icon('close')}</button></div>`).join('');
  $('#upload-summary').hidden = uploadQueue.length < 2;
  $('#upload-summary').textContent = `已选择 ${uploadQueue.length} 张图片。以下分类、地点、标签与手记将应用于本批邮票，导入后可单独编辑。`;
  $('#save-stamp').innerHTML = `${uploadQueue.length > 1 ? `收藏 ${uploadQueue.length} 枚邮票` : '收入集邮册'}${icon('arrow')}`;
}
function resetUpload() {
  uploadGeneration += 1;
  for (const item of uploadQueue) URL.revokeObjectURL(item.url);
  uploadQueue = []; preparingUploads = false;
  $('#add-form').reset(); $('#upload-error').textContent = '';
  $('#save-stamp').disabled = false; renderUploadQueue();
}
$$('[data-add]').forEach(button => button.addEventListener('click', () => {
  $('#manage-dialog').close();
  resetUpload();
  if (['湖光园林','山川旷野','人文建筑'].includes(state.category)) $('#stamp-category').value = state.category;
  $('#add-dialog').showModal();
}));
$('#add-dialog').addEventListener('close', resetUpload);
async function prepareUploads(fileList) {
  if (preparingUploads) return;
  const files = [...fileList]; if (!files.length) return;
  const generation = uploadGeneration;
  const errors = []; preparingUploads = true; $('#save-stamp').disabled = true;
  await collectionReady;
  if (generation !== uploadGeneration) return;
  $('#upload-error').textContent = '正在准备图片…';
  for (const file of files) {
    if (generation !== uploadGeneration) break;
    if (uploadQueue.length >= 30) { errors.push('每次最多导入 30 张，其余图片可在下一批导入。'); break; }
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { errors.push(`${file.name}：请选择 JPG、PNG 或 WebP。`); continue; }
    if (file.size > 15*1024*1024) { errors.push(`${file.name}：超过 15 MB。`); continue; }
    if (uploadQueue.some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) continue;
    const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.src = url; await image.decode();
      if (generation !== uploadGeneration) { URL.revokeObjectURL(url); break; }
      const sourceHash = await imageHash(file);
      if (generation !== uploadGeneration) { URL.revokeObjectURL(url); break; }
      if (sourceHash && (stamps.some(s => s.sourceHash === sourceHash) || uploadQueue.some(s => s.sourceHash === sourceHash))) { URL.revokeObjectURL(url); errors.push(`${file.name}：这枚邮票已收录；若之前移除，可在“已移除”中恢复。`); continue; }
      uploadQueue.push({id:newId(),file,url,sourceHash,width:image.naturalWidth,height:image.naturalHeight,title:file.name.replace(/\.[^.]+$/, '').replace(/^\d+[-_、.\s]+/, '').slice(0,40)});
    } catch { URL.revokeObjectURL(url); errors.push(`${file.name}：无法打开这张图片。`); }
  }
  if (generation !== uploadGeneration) return;
  preparingUploads = false; $('#save-stamp').disabled = false;
  $('#upload-file').value = ''; renderUploadQueue();
  $('#upload-error').textContent = errors.join('\n');
}
$('#upload-file').addEventListener('change', event => prepareUploads(event.target.files));
$('#upload-queue').addEventListener('input', event => {
  const item = uploadQueue.find(item => item.id === event.target.dataset.uploadTitle);
  if (item) item.title = event.target.value;
});
$('#upload-queue').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-upload]'); if (!button) return;
  const item = uploadQueue.find(item => item.id === button.dataset.removeUpload);
  if (item) URL.revokeObjectURL(item.url);
  uploadQueue = uploadQueue.filter(item => item.id !== button.dataset.removeUpload);
  renderUploadQueue();
});
const uploadArea = $('#upload-area');
['dragenter','dragover'].forEach(name => uploadArea.addEventListener(name,event => { event.preventDefault(); uploadArea.classList.add('dragging'); }));
['dragleave','drop'].forEach(name => uploadArea.addEventListener(name,event => { event.preventDefault(); uploadArea.classList.remove('dragging'); }));
uploadArea.addEventListener('drop', event => prepareUploads(event.dataTransfer.files));
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (preparingUploads) return;
  if (!uploadQueue.length) { $('#upload-error').textContent = '请先选择至少一张图片。'; return; }
  if (uploadQueue.some(item => !item.title.trim())) { $('#upload-error').textContent = '请为每枚邮票填写名称。'; return; }
  const button = $('#save-stamp'); button.disabled = true;
  const records = uploadQueue.map((item,index) => ({id:'personal-'+newId(),title:item.title.trim(),category:$('#stamp-category').value,place:$('#stamp-place').value.trim(),description:$('#stamp-description').value.trim(),tags:normalizeTags($('#stamp-tags').value),english:'A Personal Memory',custom:true,createdAt:Date.now()+index,sourceHash:item.sourceHash,file:item.file,extension:{'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[item.file.type],width:item.width,height:item.height}));
  try {
    await collectionReady;
    await stampStorage.add(records);
    const firstIndex = stamps.length;
    for (const record of records) {
      const url = URL.createObjectURL(record.file);
      stamps.push({...record,image:url,original:url,number:String(stamps.length+1).padStart(3,'0')});
    }
    state.category = 'all'; state.query = ''; $('#search').value = ''; state.view = 'album'; state.page = Math.floor(stamps.slice(0,firstIndex).filter(s => !s.deletedAt).length/pageSize());
    render(); $('#add-dialog').close(); showScreen('collection',{focus:false});
    notify(`${records.length} 枚新的记忆，已收入集邮册。`);
  } catch (error) { $('#upload-error').textContent = stampStorage.errorMessage(error); }
  finally { button.disabled = false; }
});
function renderRemoved() {
  const removed = stamps.filter(s => s.deletedAt).sort((a,b) => b.deletedAt-a.deletedAt);
  $('#removed-list').innerHTML = removed.length ? removed.map(s => `<article class="removed-item"><img src="${safe(s.image)}" alt="${safe(s.title)}"><div><strong>${safe(s.title)}</strong><small>${safe(s.place || '我的记忆邮票')}</small></div><button type="button" class="secondary-button" data-restore="${safe(s.id)}">恢复到邮册</button></article>`).join('') : '<p class="removed-empty">这里还没有移除的邮票。移除的邮票可以随时恢复。</p>';
}
$('#delete-stamp').addEventListener('click', () => {
  $('#delete-name').textContent = stamps.find(s => s.id === state.detailId)?.title || '';
  $('#delete-error').textContent = ''; $('#delete-dialog').showModal();
});
$('#cancel-delete').addEventListener('click', () => $('#delete-dialog').close());
$('#confirm-delete').addEventListener('click', async () => {
  const stamp = stamps.find(s => s.id === state.detailId); if (!stamp) return;
  const button = $('#confirm-delete'); button.disabled = true;
  try {
    await collectionReady;
    const deletedAt = Date.now();
    await stampStorage.edit({id:stamp.id, deletedAt, updatedAt:deletedAt});
    stamp.deletedAt = deletedAt;
    $('#delete-dialog').close(); $('#detail-dialog').close(); render();
    notify('已移入“已移除”，可随时恢复。');
  } catch (error) { $('#delete-error').textContent = stampStorage.errorMessage(error); }
  finally { button.disabled = false; }
});
$('#show-removed').addEventListener('click', async () => { await collectionReady; $('#manage-dialog').close(); renderRemoved(); $('#restore-error').textContent=''; $('#removed-dialog').showModal(); });
$('#removed-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-restore]'); if (!button) return;
  const stamp = stamps.find(s => s.id === button.dataset.restore); if (!stamp) return;
  button.disabled = true;
  try {
    await stampStorage.edit({id:stamp.id,deletedAt:0,updatedAt:Date.now()});
    stamp.deletedAt = 0; render(); renderRemoved(); notify('这枚记忆已回到邮册。');
  } catch (error) { $('#restore-error').textContent = stampStorage.errorMessage(error); button.disabled=false; }
});
function renderManage() {
  const list = stamps.filter(s => !s.deletedAt);
  $('#manage-count').textContent = list.length;
  $('#manage-list').innerHTML = list.length ? list.map(s => `<article class="manage-item"><img src="${safe(s.image)}" alt="" loading="lazy"><div><strong>${safe(s.title)}</strong><span>${safe(s.place || '我的记忆邮票')}</span></div><button type="button" data-manage-stamp="${safe(s.id)}" aria-label="整理${safe(s.title)}">整理 ${icon('edit')}</button></article>`).join('') : '<p class="removed-empty">从一枚新邮票，开启这一册记忆。</p>';
}
$$('[data-manage]').forEach(button => button.addEventListener('click',() => {
  renderManage(); $('#manage-dialog').showModal();
}));
$('#manage-list').addEventListener('click',event => {
  const button = event.target.closest('[data-manage-stamp]'); if (!button) return;
  $('#manage-dialog').close(); openDetail(button.dataset.manageStamp); $('.detail-manage').open = true;
});
$('#album-shell').addEventListener('pointerdown',event => {
  if (readerMedia.matches && event.pointerType === 'touch' && event.isPrimary) swipeStart = {x:event.clientX,y:event.clientY};
});
$('#album-shell').addEventListener('pointercancel',() => { swipeStart = null; });
$('#album-shell').addEventListener('pointerup',event => {
  if (!swipeStart) return;
  const dx = event.clientX-swipeStart.x, dy = event.clientY-swipeStart.y; swipeStart = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)*1.5) {
    suppressStampClickUntil = Date.now()+450; changePage(dx < 0 ? 1 : -1);
  }
});
setScreen(pageFromLocation());
render();
const collectionReady = loadCustomStamps();
