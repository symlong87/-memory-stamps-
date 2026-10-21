'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const safe = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
let stamps = window.INITIAL_STAMPS.map(s => ({ ...s, tags: [...(s.tags || [])] }));
let favorites = new Set(), toastTimer, activeFlip, editId;
let preparingPageFlip = false, pageTurnRequest = 0;
let uploadQueue = [], uploadGeneration = 0, preparingUploads = false;
try { favorites = new Set(JSON.parse(localStorage.getItem('monet-favorites') || '[]')); } catch {}
const state = { category: 'all', query: new URLSearchParams(location.search).get('collection') === 'three-cities' ? '三城旅行' : '', page: 0, view: 'album', detailId: null };
const normalizeTags = value => [...new Set((Array.isArray(value) ? value : String(value).split(/[,，、;；\s#]+/)).map(t => String(t).trim().replace(/^#+/, '').slice(0, 20)).filter(Boolean))].slice(0, 12);
const newId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

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
function stampCard(s) {
  const liked = favorites.has(s.id);
  return `<article class="stamp-card"><button class="stamp-open" data-open="${safe(s.id)}" aria-label="欣赏${safe(s.title)}邮票"><span class="stamp-mount"><img src="${safe(s.image)}" alt="${safe(s.title)} · 记忆邮票" width="800" height="1200" loading="lazy"><span class="mount-strip" aria-hidden="true"></span></span><span class="stamp-caption"><span class="stamp-title">${safe(s.title)}</span><span class="stamp-id">N° ${safe(s.number)}</span></span><span class="stamp-place">${safe(s.place || '一处值得珍藏的风景')}</span><span class="stamp-tags">${(s.tags || []).slice(0,2).map(t => `<span># ${safe(t)}</span>`).join('')}</span></button><button class="favorite-button ${liked ? 'is-favorite' : ''}" data-favorite="${safe(s.id)}" aria-label="${liked ? '取消心选' : '加入心选'}：${safe(s.title)}" aria-pressed="${liked}">${icon('heart')}</button></article>`;
}
function albumPage(items, side, pageNumber) {
  const category = ['all','favorites'].includes(state.category) ? '风景来信' : state.category;
  return `<div class="album-page" data-side="${side}"><div class="page-heading"><span>${side === 'left' ? 'MEMORY IMPRESSIONS' : 'PLACES TO REMEMBER'}</span><span class="page-heading-cn">${category} · ${pad(pageNumber)}</span></div><div class="page-stamps">${items.length ? items.map(stampCard).join('') : '<div class="blank-page"><span>✳</span><p>下一枚风景，<br>正在路上。</p><small>ROOM FOR ANOTHER MEMORY</small></div>'}</div><div class="page-footer"><span>${items.length ? '藏品 '+items.map(s => s.number).join(' · ') : '留一页，给下一次抵达'}</span><b>— ${pad(pageNumber)} —</b><span>MEMORY POST</span></div></div>`;
}
function render() {
  cancelPageFlip();
  const list = filteredStamps(), pages = Math.max(1, Math.ceil(list.length / 4));
  state.page = Math.min(state.page, pages - 1);
  const visible = list.slice(state.page * 4, state.page * 4 + 4);
  const count = stamps.filter(s => !s.deletedAt).length;
  $('#hero-count').textContent = count; $('#total-count').textContent = count;
  $('#removed-count').textContent = stamps.filter(s => s.deletedAt).length;
  $$('.filter').forEach(b => { const active = b.dataset.category === state.category; b.classList.toggle('active', active); b.setAttribute('aria-pressed', active); });
  ['album','grid'].forEach(v => { $('#'+v+'-view').classList.toggle('selected',state.view === v); $('#'+v+'-view').setAttribute('aria-pressed',state.view === v); });
  $('#album-shell').hidden = state.view !== 'album' || !list.length;
  $('#grid').hidden = state.view !== 'grid' || !list.length;
  $('#album-controls').hidden = !list.length; $('#empty').hidden = !!list.length;
  $('#empty-text').textContent = state.category === 'favorites' ? '轻点邮票上的爱心，把喜欢的风景收入心选。' : '试试其他分类，或换一个关键词。';
  if (state.view === 'album') {
    $('#album-spread').innerHTML = albumPage(visible.slice(0,2),'left',state.page*2+1) + albumPage(visible.slice(2),'right',state.page*2+2);
    $('#grid').replaceChildren();
  } else {
    $('#grid').innerHTML = list.map(stampCard).join('');
    $('#album-spread').replaceChildren();
  }
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
function detailSequence() { const list = filteredStamps(); return list.some(s => s.id === state.detailId) ? list : stamps.filter(s => !s.deletedAt); }
function openDetail(id) {
  const s = stamps.find(s => s.id === id); if (!s) return;
  state.detailId = id;
  $('#detail-image').src = s.image; $('#detail-image').alt = s.title+'邮票原作';
  $('#detail-title').textContent = s.title; $('#detail-english').textContent = s.english;
  $('#detail-category').textContent = s.category;
  $('#detail-number').textContent = 'MEMORY POST / COLLECTION N° '+s.number;
  $('#detail-place').textContent = s.place || '一处值得珍藏的风景';
  $('#detail-description').textContent = s.description || '还没有描述，点下方编辑，为这份记忆添一笔。';
  $('#detail-tags').innerHTML = (s.tags || []).map(t => `<button type="button" data-tag="${safe(t)}" aria-label="按标签筛选：${safe(t)}"># ${safe(t)}</button>`).join('');
  $('#detail-size').textContent = `${s.width || 1024} × ${s.height || 1536} px`;
  $('#detail-series').textContent = s.series || (s.custom ? '我的新收藏' : '记忆邮票 · 风景来信');
  $('#download-image').href = s.original; $('#download-image').download = `${s.title}-记忆邮票.${s.extension || 'png'}`;
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
async function changePage(direction) {
  if (activeFlip || preparingPageFlip) return;
  const target = state.page+direction;
  if (target < 0 || target >= Math.ceil(filteredStamps().length/4)) return;
  const oldSpread = $('#album-spread').cloneNode(true);
  const request = ++pageTurnRequest;
  preparingPageFlip = true;
  $('#prev-page').disabled = true; $('#next-page').disabled = true;
  const previewImages = [...oldSpread.querySelectorAll('img')];
  for (const stamp of filteredStamps().slice(target*4,target*4+4)) {
    const image = new Image(); image.src = stamp.image; previewImages.push(image);
  }
  await Promise.all(previewImages.map(image => { image.loading = 'eager'; return image.decode().catch(() => {}); }));
  if (request !== pageTurnRequest) return;
  state.page = target; render();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || state.view !== 'album') return;
  animatePageFlip(direction, oldSpread);
}
function cancelPageFlip() {
  pageTurnRequest += 1; preparingPageFlip = false;
  if (!activeFlip) return;
  const flip = activeFlip; activeFlip = null;
  flip.animation.cancel(); flip.scene.remove();
  $('#album-shell').classList.remove('is-turning');
}
function animatePageFlip(direction, oldSpread) {
  const mobile = matchMedia('(max-width: 650px)').matches;
  const scene = document.createElement('div');
  scene.className = `flip-scene ${direction > 0 ? 'turn-forward' : 'turn-backward'}${mobile ? ' mobile-turn' : ''}`;
  scene.setAttribute('aria-hidden', 'true'); scene.inert = true;
  const sheet = document.createElement('div'); sheet.className = 'flip-sheet';
  const front = document.createElement('div'), back = document.createElement('div');
  front.className = 'flip-face flip-front'; back.className = 'flip-face flip-back';
  const newSpread = $('#album-spread').cloneNode(true);
  for (const clone of [oldSpread,newSpread]) {
    clone.removeAttribute('id'); clone.removeAttribute('aria-live');
    for (const image of clone.querySelectorAll('img')) image.loading = 'eager';
  }
  if (mobile) { front.append(oldSpread); back.append(newSpread); }
  else {
    const staticPage = oldSpread.children[direction > 0 ? 0 : 1].cloneNode(true);
    staticPage.classList.add('flip-static');
    front.append(oldSpread.children[direction > 0 ? 1 : 0]);
    back.append(newSpread.children[direction > 0 ? 0 : 1]);
    scene.append(staticPage);
  }
  sheet.append(front,back); scene.append(sheet); $('#album-shell').append(scene);
  $('#album-shell').classList.add('is-turning');
  $('#prev-page').disabled = true; $('#next-page').disabled = true;
  const degrees = direction > 0 ? -180 : 180;
  const animation = sheet.animate([{transform:'rotateY(0deg)'},{transform:`rotateY(${degrees}deg)`}],{duration:mobile?650:900,easing:'cubic-bezier(.35,.06,.23,1)',fill:'forwards'});
  const flip = {animation,scene}; activeFlip = flip;
  animation.finished.then(() => {
    if (activeFlip !== flip) return;
    activeFlip = null; scene.remove(); $('#album-shell').classList.remove('is-turning');
    $('#prev-page').disabled = state.page === 0;
    $('#next-page').disabled = state.page >= Math.ceil(filteredStamps().length/4)-1;
  }).catch(() => {});
}
function resetFilters() { state.category = 'all'; state.query = ''; state.page = 0; $('#search').value = ''; render(); }
$$('.filter').forEach(b => b.addEventListener('click', () => { state.category = b.dataset.category; state.page = 0; render(); }));
$('#search').value = state.query;
$('#show-new-stamps').addEventListener('click', () => { state.category='all'; state.query='三城旅行'; state.page=0; $('#search').value=state.query; render(); });
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
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName) || $('#add-dialog').open || $('#zoom-dialog').open || $('#edit-dialog').open) return;
  if (e.key === 'ArrowRight') { if ($('#detail-dialog').open) stepDetail(1); else if (state.view === 'album') changePage(1); }
  if (e.key === 'ArrowLeft') { if ($('#detail-dialog').open) stepDetail(-1); else if (state.view === 'album') changePage(-1); }
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
    state.category = 'all'; state.query = ''; $('#search').value = ''; state.view = 'album'; state.page = Math.floor(stamps.slice(0,firstIndex).filter(s => !s.deletedAt).length/4);
    render(); $('#add-dialog').close(); $('#collection').scrollIntoView({behavior:'smooth'});
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
$('#show-removed').addEventListener('click', async () => { await collectionReady; renderRemoved(); $('#restore-error').textContent=''; $('#removed-dialog').showModal(); });
$('#removed-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-restore]'); if (!button) return;
  const stamp = stamps.find(s => s.id === button.dataset.restore); if (!stamp) return;
  button.disabled = true;
  try {
    await stampStorage.edit({id:stamp.id,deletedAt:0,updatedAt:Date.now()});
    stamp.deletedAt = 0; render(); renderRemoved(); notify('这枚记忆已回到邮册。');
  } catch (error) { $('#restore-error').textContent = stampStorage.errorMessage(error); button.disabled=false; }
});
render();
const collectionReady = loadCustomStamps();
