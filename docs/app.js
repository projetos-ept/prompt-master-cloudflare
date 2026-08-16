import { localDB } from './db.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const escapeHTML = (value = '') => String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

const state = {
  prompts: [], view: 'all', category: '', query: '', sort: 'updated', syncing: false,
  apiUrl: localStorage.getItem('pm_api_url') || '',
  token: localStorage.getItem('pm_token') || sessionStorage.getItem('pm_token') || '',
  editorTimer: null, installEvent: null, conflict: null,
};

function toast(message, type = '') {
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  $('#toast-region').append(item);
  setTimeout(() => item.remove(), 3200);
}

function formatDate(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('authorization', `Bearer ${state.token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
  return fetch(`${state.apiUrl}${path}`, { ...options, headers });
}

async function loadLocal() {
  state.prompts = (await localDB.all('prompts')).filter(p => !p.deletedAt);
}

function counts() {
  $('#count-all').textContent = state.prompts.filter(p => !p.archived).length;
  $('#count-favorites').textContent = state.prompts.filter(p => p.favorite && !p.archived).length;
  $('#count-pinned').textContent = state.prompts.filter(p => p.pinned && !p.archived).length;
  $('#count-archived').textContent = state.prompts.filter(p => p.archived).length;
}

function categories() {
  const map = new Map();
  state.prompts.forEach(p => { if (!p.archived) map.set(p.category || 'Geral', (map.get(p.category || 'Geral') || 0) + 1); });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
}

function renderNavigation() {
  counts();
  const cats = categories();
  $('#category-list').innerHTML = cats.map(([name, count], i) => `
    <button class="nav-item ${state.category === name ? 'active' : ''}" data-category="${escapeHTML(name)}">
      <i class="category-dot" style="--dot:hsl(${(i * 67 + 255) % 360} 72% 66%)"></i><span>${escapeHTML(name)}</span><b>${count}</b>
    </button>`).join('');
  $('#category-options').innerHTML = cats.map(([name]) => `<option value="${escapeHTML(name)}">`).join('');
  $('#mobile-filters').innerHTML = [
    `<button class="${state.view === 'all' && !state.category ? 'active' : ''}" data-mobile-view="all">Todos</button>`,
    `<button class="${state.view === 'favorites' ? 'active' : ''}" data-mobile-view="favorites">Favoritos</button>`,
    ...cats.map(([name]) => `<button class="${state.category === name ? 'active' : ''}" data-mobile-category="${escapeHTML(name)}">${escapeHTML(name)}</button>`)
  ].join('');
}

function visiblePrompts() {
  let items = [...state.prompts];
  if (state.view === 'archived') items = items.filter(p => p.archived);
  else {
    items = items.filter(p => !p.archived);
    if (state.view === 'favorites') items = items.filter(p => p.favorite);
    if (state.view === 'pinned') items = items.filter(p => p.pinned);
  }
  if (state.category) items = items.filter(p => p.category === state.category);
  const query = state.query.trim().toLocaleLowerCase('pt-BR');
  if (query) items = items.filter(p => [p.title, p.content, p.category, ...(p.tags || [])].join(' ').toLocaleLowerCase('pt-BR').includes(query));
  items.sort((a, b) => {
    if (state.sort === 'title') return a.title.localeCompare(b.title, 'pt-BR');
    if (state.sort === 'category') return a.category.localeCompare(b.category, 'pt-BR') || a.title.localeCompare(b.title, 'pt-BR');
    return Number(b.pinned) - Number(a.pinned) || String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  return items;
}

function cardHTML(prompt, pendingIds, pendingFiles = []) {
  const tags = (prompt.tags || []).slice(0, 3).map(tag => `<span class="tag">#${escapeHTML(tag)}</span>`).join('');
  const synced = (prompt.attachments || []).map(a => `<button type="button" class="attachment-chip" data-action="download-attachment" data-attachment="${a.id}" data-name="${escapeHTML(a.name)}" title="Baixar ${escapeHTML(a.name)}">📎 ${escapeHTML(a.name)}</button>`).join('');
  const pending = pendingFiles.map(f => `<span class="attachment-chip pending" title="${escapeHTML(f.name)} · envio pendente">↻ ${escapeHTML(f.name)}</span>`).join('');
  const attachments = synced + pending;
  const totalCount = Number(prompt.attachmentCount || 0) + pendingFiles.length;
  return `<article class="prompt-card ${prompt.pinned ? 'pinned' : ''}" data-id="${prompt.id}">
    <div class="card-head"><span class="category-badge">${escapeHTML(prompt.category || 'Geral')}</span>
      <button class="favorite-button ${prompt.favorite ? 'active' : ''}" data-action="favorite" title="Favorito">${prompt.favorite ? '♥' : '♡'}</button></div>
    <h2>${escapeHTML(prompt.title)}${totalCount ? `<small class="attachment-count" title="${totalCount} anexo(s)"> · 📎 ${totalCount}</small>` : ''}</h2><p class="prompt-preview">${escapeHTML(prompt.content)}</p>
    <div class="tag-list">${tags}</div>
    ${attachments ? `<div class="attachment-list">${attachments}</div>` : ''}
    <footer class="card-footer"><span class="card-date">Atualizado ${formatDate(prompt.updatedAt)}</span>
      <div class="card-actions">
        <button data-action="copy" title="Copiar prompt">⧉</button><button data-action="export" title="Exportar com anexos">⇩</button>
        <button data-action="edit" title="Editar">✎</button><button data-action="duplicate" title="Duplicar">▣</button>
        <button data-action="pin" title="Fixar">${prompt.pinned ? '◆' : '◇'}</button><button data-action="attach" title="Adicionar anexo">⌕</button>
        <button data-action="archive" title="${prompt.archived ? 'Restaurar' : 'Arquivar'}">□</button>
        <button data-action="delete" title="Excluir">⌫</button>
      </div></footer>${pendingIds.has(prompt.id) ? '<i class="sync-dot" title="Alteração pendente"></i>' : ''}
  </article>`;
}

async function render() {
  renderNavigation();
  $$('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === state.view && !state.category));
  const titles = { all: 'Todos os prompts', favorites: 'Favoritos', pinned: 'Prompts fixados', archived: 'Arquivados' };
  $('#page-title').textContent = state.category || titles[state.view];
  const items = visiblePrompts();
  $('#page-subtitle').textContent = `${items.length} ${items.length === 1 ? 'prompt encontrado' : 'prompts encontrados'}`;
  const pending = await localDB.all('outbox');
  const pendingIds = new Set(pending.map(o => o.promptId));
  const pendingFiles = await localDB.all('files');
  const pendingFileMap = new Map();
  pendingFiles.forEach(f => pendingFileMap.set(f.promptId, [...(pendingFileMap.get(f.promptId) || []), f]));
  $('#prompt-grid').innerHTML = items.map(p => cardHTML(p, pendingIds, pendingFileMap.get(p.id) || [])).join('');
  $('#empty-state').hidden = items.length > 0;
  updateConnection(pending.length);
}

async function updateConnection(pendingCount) {
  if (pendingCount == null) pendingCount = (await localDB.all('outbox')).length;
  const pill = $('#connection-pill');
  pill.className = `connection-pill ${navigator.onLine ? (pendingCount ? 'pending' : 'online') : ''}`;
  $('span', pill).textContent = navigator.onLine ? (pendingCount ? `${pendingCount} pendente${pendingCount > 1 ? 's' : ''}` : 'Sincronizado') : 'Offline';
  $('#sync-caption').textContent = navigator.onLine ? (pendingCount ? 'Aguardando sincronização' : 'Tudo sincronizado') : 'Trabalhando offline';
  $('#pending-label').textContent = pendingCount ? `${pendingCount} alteração${pendingCount > 1 ? 'ões' : ''} pendente${pendingCount > 1 ? 's' : ''}` : 'Nenhuma alteração pendente';
}

async function queuePrompt(prompt, action = 'upsert') {
  const key = `prompt:${prompt.id}`;
  const existing = await localDB.get('outbox', key);
  const operation = {
    key, promptId: prompt.id, action, prompt: structuredClone(prompt),
    operationId: existing?.operationId || uuid(), queuedAt: Date.now(), force: existing?.force || false,
  };
  await localDB.put('outbox', operation);
  updateConnection();
  if (navigator.onLine) setTimeout(syncNow, 80);
}

async function savePromptLocal(prompt, action = 'upsert') {
  if (action === 'delete') await localDB.delete('prompts', prompt.id);
  else await localDB.put('prompts', prompt);
  await queuePrompt(prompt, action);
  await loadLocal();
  await render();
}

async function pullChanges() {
  if (!navigator.onLine || !state.apiUrl || !state.token) return;
  const last = await localDB.get('meta', 'lastSync');
  const response = await apiFetch(`/api/prompts${last?.value ? `?since=${encodeURIComponent(last.value)}` : ''}`);
  if (response.status === 401) throw new Error('Chave de acesso recusada.');
  if (!response.ok) throw new Error('Não foi possível baixar as alterações.');
  const data = await response.json();
  const pendingIds = new Set((await localDB.all('outbox')).map(o => o.promptId));
  for (const prompt of data.prompts || []) {
    if (pendingIds.has(prompt.id)) continue;
    if (prompt.deletedAt) await localDB.delete('prompts', prompt.id);
    else await localDB.put('prompts', prompt);
  }
  await localDB.put('meta', { key: 'lastSync', value: data.serverTime });
}

async function pushOperation(operation) {
  const isNew = !operation.prompt.version;
  const path = isNew ? '/api/prompts' : `/api/prompts/${encodeURIComponent(operation.promptId)}${operation.force ? '?force=1' : ''}`;
  if (operation.action === 'delete') {
    return apiFetch(`/api/prompts/${encodeURIComponent(operation.promptId)}${operation.force ? '?force=1' : ''}`, {
      method: 'DELETE', body: JSON.stringify({ operationId: operation.operationId, version: operation.prompt.version })
    });
  }
  return apiFetch(path, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify({ ...operation.prompt, operationId: operation.operationId }) });
}

async function syncFiles() {
  const files = await localDB.all('files');
  for (const item of files) {
    const prompt = await localDB.get('prompts', item.promptId);
    if (!prompt || !prompt.version) continue; // O prompt ainda não existe no servidor.
    const form = new FormData(); form.append('attachmentId', item.id); form.append('file', item.blob, item.name);
    const response = await apiFetch(`/api/prompts/${encodeURIComponent(item.promptId)}/attachments`, { method: 'POST', body: form });
    if (response.ok) {
      const payload = await response.json().catch(() => ({}));
      await localDB.delete('files', item.id);
      const attachmentId = payload.attachment?.id || item.id;
      const attachmentName = payload.attachment?.name || item.name;
      if (!(prompt.attachments || []).some(a => a.id === attachmentId)) {
        prompt.attachmentCount = Number(prompt.attachmentCount || 0) + 1;
        prompt.attachments = [...(prompt.attachments || []), { id: attachmentId, name: attachmentName }];
        await localDB.put('prompts', prompt);
      }
    }
  }
}

async function syncNow() {
  if (state.syncing || !navigator.onLine || !state.apiUrl || !state.token) return;
  state.syncing = true;
  $('#sync-button').classList.add('spinning');
  try {
    const operations = await localDB.all('outbox');
    for (const operation of operations) {
      const response = await pushOperation(operation);
      const payload = await response.json().catch(() => ({}));
      if (response.status === 409) {
        state.conflict = { operation, server: payload.server };
        showConflict();
        continue;
      }
      if (response.status === 401) throw new Error('A chave de acesso não é mais válida.');
      if (!response.ok) throw new Error(payload.error || 'Falha ao enviar uma alteração.');
      const current = await localDB.get('outbox', operation.key);
      if (current?.queuedAt === operation.queuedAt) {
        await localDB.delete('outbox', operation.key);
        if (operation.action !== 'delete' && payload.prompt) await localDB.put('prompts', payload.prompt);
      } else if (payload.prompt) {
        const latestPrompt = await localDB.get('prompts', operation.promptId);
        if (latestPrompt) {
          latestPrompt.version = payload.prompt.version;
          await localDB.put('prompts', latestPrompt);
          current.prompt = structuredClone(latestPrompt);
          current.operationId = uuid();
          await localDB.put('outbox', current);
        }
      }
    }
    await syncFiles();
    await pullChanges();
    await loadLocal();
  } catch (error) {
    toast(error.message || 'Erro de sincronização.', 'error');
    $('#connection-pill').classList.add('error');
  } finally {
    state.syncing = false;
    $('#sync-button').classList.remove('spinning');
    await render();
    if ($('#editor-dialog').open && $('#prompt-id').value) await loadEditorFiles($('#prompt-id').value);
  }
}

function collectEditorPrompt() {
  const id = $('#prompt-id').value || uuid();
  const existing = state.prompts.find(p => p.id === id);
  return {
    id,
    title: $('#prompt-title').value.trim(),
    category: $('#prompt-category').value.trim() || 'Geral',
    tags: [...new Set($('#prompt-tags').value.split(',').map(v => v.trim().replace(/^#/, '')).filter(Boolean))].slice(0, 8),
    content: $('#prompt-content').value,
    favorite: existing?.favorite || false, pinned: existing?.pinned || false, archived: existing?.archived || false,
    version: existing?.version || 0, createdAt: existing?.createdAt || now(), updatedAt: now(),
  };
}

async function storeSelectedFiles(promptId) {
  const files = [...$('#prompt-files').files].slice(0, 5);
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) { toast(`${file.name}: excede 5 MB.`, 'error'); continue; }
    await localDB.put('files', { id: uuid(), promptId, name: file.name, type: file.type, size: file.size, blob: file, createdAt: now() });
  }
}

async function saveEditor(close = false) {
  const prompt = collectEditorPrompt();
  if (!prompt.title || !prompt.content.trim()) return false;
  $('#prompt-id').value = prompt.id;
  $('#editor-status').textContent = 'Salvando neste dispositivo…';
  await localDB.put('prompts', prompt);
  await queuePrompt(prompt);
  await storeSelectedFiles(prompt.id);
  $('#prompt-files').value = '';
  await loadLocal(); await render();
  $('#editor-status').textContent = navigator.onLine ? 'Salvo localmente; sincronizando…' : 'Salvo neste dispositivo; envio pendente.';
  if (close) { $('#editor-dialog').close(); toast('Prompt salvo.'); }
  return true;
}

async function loadEditorFiles(promptId) {
  if (!promptId) return;
  let localFiles = (await localDB.all('files')).filter(file => file.promptId === promptId);
  let serverFiles = [];
  if (navigator.onLine && state.apiUrl && state.token) {
    try {
      const response = await apiFetch(`/api/prompts/${encodeURIComponent(promptId)}/attachments`);
      if (response.ok) serverFiles = (await response.json()).attachments || [];
    } catch { /* Os anexos pendentes continuam disponíveis localmente. */ }
  }
  // Um envio pode ter sido confirmado no servidor sem o dispositivo remover o registro local pendente; reconcilia aqui.
  const serverIds = new Set(serverFiles.map(f => f.id));
  const stale = localFiles.filter(f => serverIds.has(f.id));
  if (stale.length) {
    for (const f of stale) await localDB.delete('files', f.id);
    localFiles = localFiles.filter(f => !serverIds.has(f.id));
    const prompt = await localDB.get('prompts', promptId);
    if (prompt) {
      prompt.attachmentCount = serverFiles.length + localFiles.length;
      prompt.attachments = serverFiles.map(f => ({ id: f.id, name: f.name }));
      await localDB.put('prompts', prompt);
      await loadLocal(); await render();
    }
  }
  $('#file-list').innerHTML = [
    ...localFiles.map(f => `<span class="file-chip">↻ ${escapeHTML(f.name)} · envio pendente<button type="button" class="file-remove" data-remove-local="${f.id}" title="Remover anexo">×</button></span>`),
    ...serverFiles.map(f => `<span class="file-chip"><button type="button" class="file-download" data-attachment="${f.id}" data-name="${escapeHTML(f.name)}">⇩ ${escapeHTML(f.name)}</button><button type="button" class="file-remove" data-remove-server="${f.id}" title="Remover anexo">×</button></span>`),
  ].join('');
}

async function removeLocalFile(id) {
  await localDB.delete('files', id);
  await loadEditorFiles($('#prompt-id').value);
  toast('Anexo removido.');
}

async function removeServerAttachment(id) {
  if (!confirm('Remover este anexo definitivamente?')) return;
  const response = await apiFetch(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) { toast('Não foi possível remover o anexo.', 'error'); return; }
  const promptId = $('#prompt-id').value;
  const prompt = state.prompts.find(p => p.id === promptId);
  if (prompt) {
    prompt.attachmentCount = Math.max(0, Number(prompt.attachmentCount || 0) - 1);
    prompt.attachments = (prompt.attachments || []).filter(a => a.id !== id);
    await localDB.put('prompts', prompt);
    await loadLocal(); await render();
  }
  await loadEditorFiles(promptId);
  toast('Anexo removido.');
}

async function downloadAttachment(id, name) {
  const response = await apiFetch(`/api/attachments/${encodeURIComponent(id)}`);
  if (!response.ok) { toast('Não foi possível baixar o anexo.', 'error'); return; }
  const url = URL.createObjectURL(await response.blob());
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openEditor(id = '') {
  clearTimeout(state.editorTimer);
  const prompt = state.prompts.find(p => p.id === id);
  $('#editor-form').reset();
  $('#prompt-id').value = prompt?.id || '';
  $('#prompt-title').value = prompt?.title || '';
  $('#prompt-category').value = prompt?.category || (state.category || 'Geral');
  $('#prompt-tags').value = (prompt?.tags || []).join(', ');
  $('#prompt-content').value = prompt?.content || '';
  $('#editor-eyebrow').textContent = prompt ? 'EDIÇÃO COM SALVAMENTO AUTOMÁTICO' : 'NOVO ITEM';
  $('#editor-title').textContent = prompt ? 'Editar prompt' : 'Criar prompt';
  $('#editor-status').textContent = prompt ? 'As alterações são salvas automaticamente.' : 'O prompt será salvo neste dispositivo primeiro.';
  $('#file-list').innerHTML = '';
  $('#editor-dialog').showModal();
  if (prompt) loadEditorFiles(prompt.id);
  setTimeout(() => $('#prompt-title').focus(), 30);
}

function showConflict() {
  const { operation, server } = state.conflict;
  const local = operation.prompt;
  $('#conflict-comparison').innerHTML = `
    <div class="conflict-version"><strong>Neste dispositivo</strong><h3>${escapeHTML(local.title)}</h3><pre>${escapeHTML(local.content)}</pre></div>
    <div class="conflict-version"><strong>No servidor</strong><h3>${escapeHTML(server.title)}</h3><pre>${escapeHTML(server.content)}</pre></div>`;
  $('#conflict-dialog').showModal();
}

async function mutateCard(id, action) {
  const prompt = state.prompts.find(p => p.id === id);
  if (!prompt) return;
  if (action === 'copy') { await copyPrompt(prompt); return; }
  if (action === 'export') { await exportJSON([prompt]); return; }
  if (action === 'edit') { openEditor(id); return; }
  if (action === 'attach') { openEditor(id); setTimeout(() => $('.file-drop').click(), 100); return; }
  if (action === 'duplicate') {
    const copy = { ...structuredClone(prompt), id: uuid(), title: `${prompt.title} (cópia)`, version: 0, createdAt: now(), updatedAt: now() };
    await savePromptLocal(copy); toast('Cópia criada.'); return;
  }
  if (action === 'delete') {
    if (!confirm(`Excluir “${prompt.title}”? A exclusão será sincronizada.`)) return;
    await savePromptLocal(prompt, 'delete'); return;
  }
  const changed = { ...prompt, updatedAt: now() };
  if (action === 'favorite') changed.favorite = !changed.favorite;
  if (action === 'pin') changed.pinned = !changed.pinned;
  if (action === 'archive') changed.archived = !changed.archived;
  await savePromptLocal(changed);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}

function isTextAttachment(name = '', type = '') {
  const extension = name.toLowerCase().split('.').pop();
  const textExtensions = new Set(['bash','bat','c','cfg','conf','cpp','cs','css','csv','go','h','hpp','htm','html','ini','ipynb','java','js','json','jsx','kt','markdown','md','mjs','php','ps1','py','rb','rs','sh','sql','swift','toml','ts','tsx','txt','xml','yaml','yml']);
  return type.startsWith('text/') || type.includes('json') || type.includes('xml') || textExtensions.has(extension);
}

async function collectAttachments(promptId) {
  const found = [];
  const localFiles = (await localDB.all('files')).filter(file => file.promptId === promptId);
  for (const file of localFiles) found.push({ id: file.id, name: file.name, type: file.type, size: file.size, data: await blobToDataURL(file.blob) });
  if (navigator.onLine && state.apiUrl && state.token) {
    const listResponse = await apiFetch(`/api/prompts/${encodeURIComponent(promptId)}/attachments`);
    if (listResponse.ok) {
      for (const metadata of (await listResponse.json()).attachments || []) {
        if (found.some(item => item.id === metadata.id)) continue;
        const response = await apiFetch(`/api/attachments/${encodeURIComponent(metadata.id)}`);
        if (response.ok) found.push({ id: metadata.id, name: metadata.name, type: metadata.contentType, size: metadata.size, data: await blobToDataURL(await response.blob()) });
      }
    }
  }
  return found;
}

async function portableFiles(prompt) {
  const attachments = await collectAttachments(prompt.id);
  const localPending = (await localDB.all('files')).filter(file => file.promptId === prompt.id).length;
  if (!navigator.onLine && Number(prompt.attachmentCount || 0) > 0 && attachments.length <= localPending) {
    throw new Error('Este prompt possui anexos no servidor. Conecte-se à internet para copiá-lo completo.');
  }
  const files = [];
  for (const attachment of attachments) {
    if (isTextAttachment(attachment.name, attachment.type)) {
      files.push({ nome: attachment.name, conteudo: await (await fetch(attachment.data)).text() });
    } else {
      files.push({ nome: attachment.name, conteudo: attachment.data, codificacao: 'data-url', tipo_mime: attachment.type || 'application/octet-stream' });
    }
  }
  return files;
}

async function makePortableBundle(selected, prefetched = new Map()) {
  const prompts = [];
  for (const item of selected) prompts.push({
    id: item.id,
    titulo: item.title,
    prompt: item.content,
    categoria: item.category || 'Geral',
    tags: item.tags || [],
    data: item.createdAt || item.updatedAt || now(),
    fixado: Boolean(item.pinned),
    arquivos: prefetched.has(item.id) ? prefetched.get(item.id) : await portableFiles(item),
  });
  return {
    _instrucao: "Você recebeu um prompt exportado do Prompt Master. Execute o campo 'prompt' como instrução principal. Se houver itens em 'arquivos', o campo 'conteudo' de cada um é contexto adicional para a tarefa. Quando 'codificacao' for 'data-url', preserve o conteúdo binário no formato informado. Ignore campos técnicos como 'versao', 'exportado_em', 'id', 'data' e 'fixado'.",
    versao: 1,
    exportado_em: now(),
    total: prompts.length,
    prompts,
  };
}

async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); return; }
  catch { /* Usa uma alternativa para navegadores/PWAs com permissão restrita. */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  const copied = document.execCommand('copy');
  area.remove();
  if (!copied) throw new Error('O navegador bloqueou a área de transferência.');
}

async function copyPrompt(prompt) {
  try {
    const files = await portableFiles(prompt);
    if (!files.length) {
      await writeClipboard(prompt.content);
      toast('Texto do prompt copiado.');
      return;
    }
    const bundle = await makePortableBundle([prompt], new Map([[prompt.id, files]]));
    await writeClipboard(JSON.stringify(bundle, null, 2));
    toast(`Prompt copiado com ${files.length} anexo${files.length > 1 ? 's' : ''}.`);
  } catch (error) { toast(error.message || 'Não foi possível copiar o prompt.', 'error'); }
}

async function exportJSON(selected = state.prompts) {
  toast('Preparando backup com anexos…');
  let payload;
  try { payload = await makePortableBundle(selected); }
  catch (error) { toast(error.message || 'Não foi possível preparar o backup.', 'error'); return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const suffix = selected.length === 1 ? selected[0].title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50) : now().slice(0, 10);
  const link = Object.assign(document.createElement('a'), { href: url, download: `prompt-master-${suffix || 'backup'}.json` });
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importJSON(file) {
  const data = JSON.parse(await file.text());
  const prompts = Array.isArray(data) ? data : data.prompts;
  if (!Array.isArray(prompts)) throw new Error('O JSON não contém uma lista de prompts.');
  for (const source of prompts) {
    if (!(source.title || source.titulo) || !(source.content || source.prompt)) continue;
    const existing = state.prompts.find(p => p.id === source.id);
    const prompt = {
      id: source.id || uuid(), title: String(source.title || source.titulo),
      category: String(source.category || source.categoria || 'Geral'), content: String(source.content || source.prompt),
      tags: Array.isArray(source.tags) ? source.tags : [], favorite: Boolean(source.favorite), pinned: Boolean(source.pinned), archived: false,
      version: existing?.version || 0, createdAt: source.createdAt || now(), updatedAt: now(),
    };
    await localDB.put('prompts', prompt); await queuePrompt(prompt);
    for (const attachment of source.arquivos || source.attachments || []) {
      const value = attachment.conteudo ?? attachment.data;
      if (value == null) continue;
      const isDataURL = typeof value === 'string' && value.startsWith('data:');
      const blob = isDataURL ? await (await fetch(value)).blob() : new Blob([String(value)], { type: attachment.tipo_mime || attachment.type || 'text/plain;charset=utf-8' });
      await localDB.put('files', { id: attachment.id || uuid(), promptId: prompt.id, name: attachment.nome || attachment.name || 'anexo.txt', type: attachment.tipo_mime || attachment.type || blob.type, size: blob.size, blob, createdAt: now() });
    }
  }
  await loadLocal(); await render(); toast(`${prompts.length} itens processados.`); syncNow();
}

function bindEvents() {
  $('#setup-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('button[type=submit]', event.currentTarget); button.disabled = true;
    state.apiUrl = $('#api-url').value.trim().replace(/\/+$/, ''); state.token = $('#api-token').value;
    try {
      const response = await apiFetch('/api/prompts');
      if (!response.ok) throw new Error(response.status === 401 ? 'Chave de acesso incorreta.' : 'API indisponível.');
      localStorage.setItem('pm_api_url', state.apiUrl);
      const target = $('#remember-token').checked ? localStorage : sessionStorage; target.setItem('pm_token', state.token);
      (target === localStorage ? sessionStorage : localStorage).removeItem('pm_token');
      showApp(); await pullChanges(); await loadLocal(); await render(); syncNow();
    } catch (error) { $('#setup-error').textContent = error.message; $('#setup-error').hidden = false; }
    finally { button.disabled = false; }
  });
  $('#toggle-token').addEventListener('click', () => $('#api-token').type = $('#api-token').type === 'password' ? 'text' : 'password');
  $('#offline-entry').addEventListener('click', showApp);
  $('#new-button').addEventListener('click', () => openEditor());
  $('#empty-state').addEventListener('click', e => { if (e.target.closest('[data-action=new]')) openEditor(); });
  $('#prompt-grid').addEventListener('click', event => {
    const card = event.target.closest('.prompt-card');
    if (!card) return;
    const button = event.target.closest('[data-action]');
    if (!button) { mutateCard(card.dataset.id, 'copy'); return; }
    if (button.dataset.action === 'download-attachment') { downloadAttachment(button.dataset.attachment, button.dataset.name); return; }
    mutateCard(card.dataset.id, button.dataset.action);
  });
  $('.nav').addEventListener('click', event => { const b = event.target.closest('[data-view]'); if (!b) return; state.view = b.dataset.view; state.category = ''; render(); });
  $('#category-list').addEventListener('click', event => { const b = event.target.closest('[data-category]'); if (!b) return; state.category = b.dataset.category; state.view = 'all'; closeSidebar(); render(); });
  $('#mobile-filters').addEventListener('click', event => { const b = event.target.closest('button'); if (!b) return; state.category = b.dataset.mobileCategory || ''; state.view = b.dataset.mobileView || 'all'; render(); });
  $('#search-input').addEventListener('input', event => { state.query = event.target.value; render(); });
  $('#sort-select').addEventListener('change', event => { state.sort = event.target.value; render(); });
  $('#editor-form').addEventListener('submit', async event => { event.preventDefault(); await saveEditor(true); });
  $('#editor-form').addEventListener('input', event => {
    if (!$('#prompt-id').value || event.target.type === 'file') return;
    clearTimeout(state.editorTimer); $('#editor-status').textContent = 'Alteração ainda não salva…';
    state.editorTimer = setTimeout(() => saveEditor(false), 850);
  });
  $('#prompt-files').addEventListener('change', event => { $('#file-list').innerHTML = [...event.target.files].map(f => `<span class="file-chip">${escapeHTML(f.name)} · ${Math.ceil(f.size / 1024)} KB</span>`).join(''); });
  $('#file-list').addEventListener('click', event => {
    const removeLocal = event.target.closest('[data-remove-local]');
    if (removeLocal) { removeLocalFile(removeLocal.dataset.removeLocal); return; }
    const removeServer = event.target.closest('[data-remove-server]');
    if (removeServer) { removeServerAttachment(removeServer.dataset.removeServer); return; }
    const button = event.target.closest('[data-attachment]');
    if (button) downloadAttachment(button.dataset.attachment, button.dataset.name);
  });
  $('#sync-button').addEventListener('click', syncNow); $('#settings-sync').addEventListener('click', syncNow);
  $('#theme-button').addEventListener('click', () => { const value = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = value; localStorage.setItem('pm_theme', value); });
  $('#export-button').addEventListener('click', () => exportJSON()); $('#settings-export').addEventListener('click', () => exportJSON());
  $('#import-button').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async event => { try { if (event.target.files[0]) await importJSON(event.target.files[0]); } catch (e) { toast(e.message, 'error'); } event.target.value = ''; });
  $('#settings-button').addEventListener('click', () => { $('#settings-api').textContent = state.apiUrl; $('#settings-dialog').showModal(); });
  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $('#disconnect-button').addEventListener('click', () => { localStorage.removeItem('pm_api_url'); localStorage.removeItem('pm_token'); sessionStorage.removeItem('pm_token'); location.reload(); });
  $('#menu-button').addEventListener('click', () => { $('.sidebar').classList.add('open'); $('#sidebar-backdrop').hidden = false; });
  $('#sidebar-backdrop').addEventListener('click', closeSidebar);
  $('#add-category').addEventListener('click', () => { openEditor(); setTimeout(() => $('#prompt-category').focus(), 30); });
  $('#keep-server').addEventListener('click', async () => {
    const { operation, server } = state.conflict; await localDB.delete('outbox', operation.key); await localDB.put('prompts', server);
    state.conflict = null; await loadLocal(); await render(); toast('Versão do servidor restaurada.');
  });
  $('#keep-local').addEventListener('click', async () => {
    const { operation, server } = state.conflict; operation.prompt.version = server.version; operation.operationId = uuid(); operation.queuedAt = Date.now(); operation.force = true;
    await localDB.put('outbox', operation); state.conflict = null; setTimeout(syncNow, 50);
  });
  window.addEventListener('online', () => { toast('Conexão restabelecida. Sincronizando…'); syncNow(); });
  window.addEventListener('offline', () => updateConnection());
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installEvent = event; $('#install-button').hidden = false; });
  $('#install-button').addEventListener('click', async () => { if (state.installEvent) { state.installEvent.prompt(); await state.installEvent.userChoice; state.installEvent = null; $('#install-button').hidden = true; } });
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('#search-input').focus(); } if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); openEditor(); } });
}

function closeSidebar() { $('.sidebar').classList.remove('open'); $('#sidebar-backdrop').hidden = true; }
function showApp() { $('#setup-screen').hidden = true; $('#app-shell').hidden = false; }

async function init() {
  bindEvents();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
  await loadLocal();
  $('#offline-entry').hidden = state.prompts.length === 0;
  if (state.apiUrl && state.token) { showApp(); await render(); syncNow(); }
  else { $('#setup-screen').hidden = false; $('#api-url').value = state.apiUrl; }
}

init().catch(error => { console.error(error); toast('Não foi possível iniciar o aplicativo.', 'error'); });
