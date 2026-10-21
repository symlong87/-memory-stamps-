'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const safe = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
let stamps = [...window.INITIAL_STAMPS], favorites = new Set(), uploadData, databasePromise, toastTimer;
try { favorites = new Set(JSON.parse(localStorage.getItem('monet-favorites') || '[]')); } catch {}
const state = { category: 'all', query: '', page: 0, view: 'album', detailId: null };

function notify(message) {
  $('#toast').textContent = message; $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2700);
}
function getDatabase() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('monet-post-collection', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('stamps', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('storage blocked'));
  });
  return databasePromise;
}
async function loadCustomStamps() {
  try {
    const db = await getDatabase();
    const records = await new Promise((resolve, reject) => {
      const req = db.transaction('stamps').objectStore('stamps').getAll();
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    records.sort((a,b) => a.createdAt - b.createdAt);
    for (const r of records) {
      const url = URL.createObjectURL(r.file);
      stamps.push({ ...r, image: url, original: url, number: String(stamps.length + 1).padStart(3, '0') });
    }
    render();
  } catch { notify('当前浏览器未开放本地存储，仍可欣赏全部原有藏品。'); }
}
function filteredStamps() {
  const q = state.query.trim().toLocaleLowerCase();
  return stamps.filter(s => (state.category === 'all' || (state.category === 'favorites' ? favorites.has(s.id) : s.category === state.category)) && (!q || [s.title,s.english,s.place,s.category,s.description].join(' ').toLocaleLowerCase().includes(q)));
}
function stampCard(s) {
  const liked = favorites.has(s.id);
  return `<article class="stamp-card"><button class="stamp-open" data-open="${safe(s.id)}" aria-label="欣赏${safe(s.title)}邮票"><span class="stamp-mount"><img src="${safe(s.image)}" alt="${safe(s.title)} · 莫奈印记邮票" width="800" height="1200" loading="lazy"><span class="mount-strip" aria-hidden="true"></span></span><span class="stamp-caption"><span class="stamp-title">${safe(s.title)}</span><span class="stamp-id">N° ${safe(s.number)}</span></span><span class="stamp-place">${safe(s.place || '一处值得珍藏的风景')}</span></button><button class="favorite-button ${liked ? 'is-favorite' : ''}" data-favorite="${safe(s.id)}" aria-label="${liked ? '取消心选' : '加入心选'}：${safe(s.title)}" aria-pressed="${liked}">${icon('heart')}</button></article>`;
}
function albumPage(items, side, pageNumber) {
  const category = ['all','favorites'].includes(state.category) ? '风景来信' : state.category;
  return `<div class="album-page"><div class="page-heading"><span>${side === 'left' ? 'MONET IMPRESSIONS' : 'PLACES TO REMEMBER'}</span><span class="page-heading-cn">${category} · ${pad(pageNumber)}</span></div><div class="page-stamps">${items.length ? items.map(stampCard).join('') : '<div class="blank-page"><span>✳</span><p>下一枚风景，<br>正在路上。</p><small>ROOM FOR ANOTHER MEMORY</small></div>'}</div><div class="page-footer"><span>${items.length ? '藏品 '+items.map(s => s.number).join(' · ') : '留一页，给下一次抵达'}</span><b>— ${pad(pageNumber)} —</b><span>THE MONET POST</span></div></div>`;
}
function render() {
  const list = filteredStamps(), pages = Math.max(1, Math.ceil(list.length / 4));
  state.page = Math.min(state.page, pages - 1);
  const visible = list.slice(state.page * 4, state.page * 4 + 4);
  $('#hero-count').textContent = stamps.length; $('#total-count').textContent = stamps.length;
  $$('.filter').forEach(b => { const active = b.dataset.category === state.category; b.classList.toggle('active', active); b.setAttribute('aria-pressed', active); });
  ['album','grid'].forEach(v => { $('#'+v+'-view').classList.toggle('selected',state.view === v); $('#'+v+'-view').setAttribute('aria-pressed',state.view === v); });
  $('#album-shell').hidden = state.view !== 'album' || !list.length;
  $('#grid').hidden = state.view !== 'grid' || !list.length;
  $('#album-controls').hidden = !list.length; $('#empty').hidden = !!list.length;
  $('#empty-text').textContent = state.category === 'favorites' ? '轻点邮票上的爱心，把喜欢的风景收入心选。' : '试试其他分类，或换一个关键词。';
  if (state.view === 'album') $('#album-spread').innerHTML = albumPage(visible.slice(0,2),'left',state.page*2+1) + albumPage(visible.slice(2),'right',state.page*2+2);
  else $('#grid').innerHTML = list.map(stampCard).join('');
  $('.pagination').hidden = state.view !== 'album';
  $('#page-indicator').innerHTML = `${pad(state.page+1)} <i>/</i> ${pad(pages)}`;
  $('#prev-page').disabled = state.page === 0; $('#next-page').disabled = state.page >= pages-1;
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
function detailSequence() { const list = filteredStamps(); return list.some(s => s.id === state.detailId) ? list : stamps; }
function openDetail(id) {
  const s = stamps.find(s => s.id === id); if (!s) return;
  state.detailId = id;
  $('#detail-image').src = s.image; $('#detail-image').alt = s.title+'邮票原作';
  $('#detail-title').textContent = s.title; $('#detail-english').textContent = s.english;
  $('#detail-category').textContent = s.category;
  $('#detail-number').textContent = 'THE MONET POST / COLLECTION N° '+s.number;
  $('#detail-place').textContent = s.place || '一处值得珍藏的风景';
  $('#detail-description').textContent = s.description || '让这一枚小小的风景，替你保存此刻的心情。';
  $('#detail-size').textContent = `${s.width || 1024} × ${s.height || 1536} px`;
  $('#detail-series').textContent = s.custom ? '我的新收藏' : '莫奈印记 · 风景来信';
  $('#download-image').href = s.original; $('#download-image').download = `${s.title}-莫奈印记.${s.extension || 'png'}`;
  const sequence = detailSequence(), index = sequence.findIndex(s => s.id === id);
  $('#detail-position').textContent = `${pad(index+1)} / ${pad(sequence.length)}`;
  $('#detail-prev').disabled = index === 0; $('#detail-next').disabled = index === sequence.length-1;
  updateDetailFavorite();
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
  $('#detail-dialog').scrollTop = 0;
}
function stepDetail(direction) {
  const list = detailSequence(), index = list.findIndex(s => s.id === state.detailId);
  if (list[index+direction]) openDetail(list[index+direction].id);
}
function changePage(direction) {
  const target = state.page+direction;
  if (target < 0 || target >= Math.ceil(filteredStamps().length/4)) return;
  state.page = target; render();
}
function resetFilters() { state.category = 'all'; state.query = ''; state.page = 0; $('#search').value = ''; render(); }
$$('.filter').forEach(b => b.addEventListener('click', () => { state.category = b.dataset.category; state.page = 0; render(); }));
$('#search').addEventListener('input', e => { state.query = e.target.value; state.page = 0; render(); });
$('#reset-filters').addEventListener('click',resetFilters);
$('#album-view').addEventListener('click', () => { state.view = 'album'; render(); });
$('#grid-view').addEventListener('click', () => { state.view = 'grid'; render(); });
$('#prev-page').addEventListener('click', () => changePage(-1));
$('#next-page').addEventListener('click', () => changePage(1));
$('#detail-prev').addEventListener('click', () => stepDetail(-1));
$('#detail-next').addEventListener('click', () => stepDetail(1));
$('#detail-favorite').addEventListener('click', () => toggleFavorite(state.detailId));
$('.collection').addEventListener('click', e => {
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
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) || $('#add-dialog').open || $('#zoom-dialog').open) return;
  if (e.key === 'ArrowRight') { if ($('#detail-dialog').open) stepDetail(1); else if (state.view === 'album') changePage(1); }
  if (e.key === 'ArrowLeft') { if ($('#detail-dialog').open) stepDetail(-1); else if (state.view === 'album') changePage(-1); }
});
function resetUpload() {
  $('#add-form').reset(); $('#upload-preview').hidden = true; $('#upload-prompt').hidden = false; $('#upload-error').textContent = '';
  if (uploadData?.url) URL.revokeObjectURL(uploadData.url); uploadData = null;
}
$$('[data-add]').forEach(b => b.addEventListener('click', () => { resetUpload(); $('#add-dialog').showModal(); }));
async function prepareUpload(file) {
  $('#upload-error').textContent = ''; if (!file) return;
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) { $('#upload-error').textContent = '请选择 JPG、PNG 或 WebP 图片。'; return; }
  if (file.size > 15*1024*1024) { $('#upload-error').textContent = '这张图片超过 15 MB，请选择小一些的图片。'; return; }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    if (uploadData?.url) URL.revokeObjectURL(uploadData.url);
    uploadData = { file, url, width:image.naturalWidth, height:image.naturalHeight };
    $('#upload-preview').src = url; $('#upload-preview').hidden = false; $('#upload-prompt').hidden = true;
    if (!$('#stamp-title').value) $('#stamp-title').value = file.name.replace(/\.[^.]+$/, '').slice(0,40);
  } catch { URL.revokeObjectURL(url); $('#upload-error').textContent = '这张图片无法打开，请重新选择。'; }
}
$('#upload-file').addEventListener('change', e => prepareUpload(e.target.files[0]));
const uploadArea = $('#upload-area');
['dragenter','dragover'].forEach(name => uploadArea.addEventListener(name,e => { e.preventDefault(); uploadArea.classList.add('dragging'); }));
['dragleave','drop'].forEach(name => uploadArea.addEventListener(name,e => { e.preventDefault(); uploadArea.classList.remove('dragging'); }));
uploadArea.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0]; if (!file) return;
  const transfer = new DataTransfer(); transfer.items.add(file); $('#upload-file').files = transfer.files; prepareUpload(file);
});
$('#add-form').addEventListener('submit', async e => {
  e.preventDefault(); const title = $('#stamp-title').value.trim();
  if (!uploadData || !title) { $('#upload-error').textContent = '请选择一张图片，并填写邮票名称。'; return; }
  const button = $('#save-stamp'); button.disabled = true;
  const record = { id:'personal-'+crypto.randomUUID(), title, category:$('#stamp-category').value, place:$('#stamp-place').value.trim(), description:$('#stamp-description').value.trim(), english:'A Personal Memory', custom:true, createdAt:Date.now(), file:uploadData.file, extension:{'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[uploadData.file.type], width:uploadData.width, height:uploadData.height };
  try {
    const db = await getDatabase();
    await new Promise((resolve,reject) => {
      const t = db.transaction('stamps','readwrite'); t.objectStore('stamps').put(record);
      t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
    });
    const url = URL.createObjectURL(record.file);
    stamps.push({...record,image:url,original:url,number:String(stamps.length+1).padStart(3,'0')});
    resetFilters(); state.view = 'album'; state.page = Math.floor((stamps.length-1)/4); render();
    $('#add-dialog').close(); $('#collection').scrollIntoView({behavior:'smooth'}); notify('新的远方，已收入你的集邮册。'); resetUpload();
  } catch { $('#upload-error').textContent = '未能保存，请检查浏览器存储空间，或退出无痕模式后再试。'; }
  finally { button.disabled = false; }
});
render();
loadCustomStamps();
