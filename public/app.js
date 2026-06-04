const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const logBox = $('#logOutput');
const outputBox = $('#runOutput');

let currentProcId = null;
let pollTimer = null;
let editingProject = null;

function log(msg, type = 'info') {
  msg.split('\n').forEach(line => {
    const el = document.createElement('div');
    el.className = `log-entry ${type}`;
    el.textContent = `[${new Date().toLocaleTimeString()}] ${line}`;
    logBox.prepend(el);
  });
}

async function api(path, body) {
  const opts = body !== undefined
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' };
  const res = await fetch(path, opts);
  return res.json();
}

async function apiDel(path) {
  const res = await fetch(path, { method: 'DELETE' });
  return res.json();
}

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

function switchTab(name) {
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

// ===== Global Settings =====
async function loadGlobal() {
  const g = await api('/api/global');
  $('#globalGitName').value = g.gitName || '';
  $('#globalGitEmail').value = g.gitEmail || '';

  if (g.githubUser) {
    $('#tokenStatusIcon').textContent = `Token configured (${g.githubUser})`;
    $('#tokenStatusIcon').className = 'token-status ok';
    $('#globalTokenStatus').textContent = `Logged in: ${g.githubUser}`;
    $('#globalTokenStatus').className = 'status-text success';
    $('#globalStatus').textContent = `GitHub: ${g.githubUser}`;
    $('#globalStatus').className = 'status-text success';
  } else if (g.token) {
    $('#tokenStatusIcon').textContent = 'Token saved (not verified)';
    $('#tokenStatusIcon').className = 'token-status warn';
  } else {
    $('#tokenStatusIcon').textContent = 'No token configured';
    $('#tokenStatusIcon').className = 'token-status err';
    $('#globalTokenStatus').textContent = '';
  }
}

$('#btnVerifyGlobal').addEventListener('click', async () => {
  const newToken = $('#globalToken').value.trim();
  const s = $('#globalTokenStatus');

  if (!newToken) {
    const g = await api('/api/global/raw');
    if (!g.token) { log('Please enter a token', 'error'); return; }
    s.textContent = 'Verifying saved token...'; s.className = 'status-text';
    try {
      const data = await api('/api/global/verify', { token: g.token });
      if (data.user) {
        s.textContent = `Verified: ${data.user.login}`;
        s.className = 'status-text success';
        $('#globalGitName').value = data.user.name || data.user.login;
        $('#globalGitEmail').value = data.user.email || `${data.user.login}@users.noreply.github.com`;
        $('#repoOwner').value = data.user.login;
        log(`Verified: ${data.user.login}`, 'success');
        loadGlobal();
      } else {
        s.textContent = `Error: ${data.error}`; s.className = 'status-text error';
      }
    } catch (e) {
      s.textContent = `Error: ${e.message}`; s.className = 'status-text error';
    }
    return;
  }

  s.textContent = 'Verifying...'; s.className = 'status-text';
  try {
    await api('/api/global', { token: newToken });
    const data = await api('/api/global/verify', { token: newToken });
    if (data.user) {
      s.textContent = `Verified: ${data.user.login}`;
      s.className = 'status-text success';
      $('#globalGitName').value = data.user.name || data.user.login;
      $('#globalGitEmail').value = data.user.email || `${data.user.login}@users.noreply.github.com`;
      $('#repoOwner').value = data.user.login;
      $('#globalToken').value = '';
      $('#globalToken').placeholder = 'Token saved';
      log(`Verified: ${data.user.login}`, 'success');
      loadGlobal();
    } else {
      s.textContent = `Error: ${data.error}`; s.className = 'status-text error';
    }
  } catch (e) {
    s.textContent = `Error: ${e.message}`; s.className = 'status-text error';
  }
});

$('#btnSaveGlobal').addEventListener('click', async () => {
  const data = {};
  const t = $('#globalToken').value.trim();
  if (t) data.token = t;
  data.gitName = $('#globalGitName').value.trim();
  data.gitEmail = $('#globalGitEmail').value.trim();
  const r = await api('/api/global', data);
  log(r.success ? 'Settings saved' : `Error: ${r.error}`, r.success ? 'success' : 'error');
  if (t) { $('#globalToken').value = ''; $('#globalToken').placeholder = 'Token saved'; }
  loadGlobal();
});

// ===== Add / Edit Project =====
$('#btnSaveProject').addEventListener('click', async () => {
  const name = $('#projectName').value.trim();
  const repoOwner = $('#repoOwner').value.trim();
  const codePath = $('#codePath').value.trim();
  const branch = $('#branch').value.trim() || 'main';
  const isPrivate = $('#isPrivate').checked;
  if (!name || !repoOwner) { log('Name and owner required', 'error'); return; }
  const r = await api('/api/projects', { name, repoOwner, codePath, branch, isPrivate });
  if (r.success) {
    log(`Project "${name}" saved`, 'success');
    resetForm();
    loadDashboard(false);
    switchTab('dashboard');
  } else {
    log(`Error: ${r.error}`, 'error');
  }
});

$('#btnCancelEdit').addEventListener('click', () => {
  resetForm();
  switchTab('dashboard');
});

function resetForm() {
  $('#projectName').value = '';
  $('#repoOwner').value = '';
  $('#codePath').value = '';
  $('#branch').value = 'main';
  $('#isPrivate').checked = false;
  editingProject = null;
  $('#btnSaveProject').textContent = 'Save Project';
  $('#projectFormTitle').textContent = 'Add / Edit Project';
}

function fillForm(proj) {
  $('#projectName').value = proj.name;
  $('#repoOwner').value = proj.repoOwner;
  $('#codePath').value = proj.codePath;
  $('#branch').value = proj.branch || 'main';
  $('#isPrivate').checked = !!proj.isPrivate;
  editingProject = proj.name;
  $('#btnSaveProject').textContent = 'Update Project';
  $('#projectFormTitle').textContent = `Edit: ${proj.name}`;
}

// ===== Dashboard =====
function saveInputValues() {
  const inputs = document.querySelectorAll('.custom-cmd-input');
  const saved = {};
  inputs.forEach(input => {
    if (input.dataset.cmdFor && input.value) {
      saved[input.dataset.cmdFor] = input.value;
      localStorage.setItem(`customCmd_${input.dataset.cmdFor}`, input.value);
    }
  });
  return saved;
}

function restoreInputValues(savedValues = {}) {
  const inputs = document.querySelectorAll('.custom-cmd-input');
  inputs.forEach(input => {
    if (input.dataset.cmdFor) {
      const name = input.dataset.cmdFor;
      if (savedValues[name]) {
        input.value = savedValues[name];
      } else {
        const stored = localStorage.getItem(`customCmd_${name}`);
        if (stored) input.value = stored;
      }
    }
  });
}

async function loadDashboard(showLoading = true) {
  const list = $('#dashboardList');
  const savedValues = saveInputValues();

  if (showLoading && list.children.length === 0) {
    list.innerHTML = '<span class="spinner"></span> Loading...';
  }

  try {
    const projects = await api('/api/projects');
    if (!projects || projects.length === 0) {
      list.innerHTML = '<div class="dashboard-empty"><p>No projects yet. Go to "Add Project" to create one.</p></div>';
      return;
    }

    list.innerHTML = '';
    projects.forEach(p => list.appendChild(renderProjectCard(p)));
    restoreInputValues(savedValues);
  } catch (e) {
    if (list.children.length === 0) {
      list.innerHTML = `<p style="color:#f85149">Error: ${e.message}</p>`;
    }
  }
}

function renderProjectCard(p) {
  const card = document.createElement('div');
  card.className = `project-card${p.gitStatus && p.gitStatus.conflicted > 0 ? ' has-conflict' : ''}`;

  const repoUrl = `https://github.com/${p.repoOwner}/${p.name}`;
  const types = p.detectedTypes.join(', ') || 'unknown';
  const scripts = p.availableScripts || [];

  let statusChips = '';
  if (!p.pathExists) {
    statusChips = `<div class="status-chip warn"><span class="label">Path</span><span class="value">Not found</span></div>`;
  } else {
    statusChips += `<div class="status-chip"><span class="label">Type</span><span class="value">${types}</span></div>`;

    if (p.isRepo && p.gitStatus) {
      const gs = p.gitStatus;
      const hasChanges = gs.modified > 0 || gs.untracked > 0;
      statusChips += `<div class="status-chip ${gs.conflicted > 0 ? 'err' : hasChanges ? 'warn' : 'ok'}">
        <span class="label">Git (${gs.branch})</span>
        <span class="value">${gs.conflicted > 0 ? gs.conflicted + ' conflicts' : hasChanges ? gs.modified + ' mod, ' + gs.untracked + ' new' : 'Clean'}</span>
      </div>`;
    } else {
      statusChips += `<div class="status-chip warn"><span class="label">Git</span><span class="value">Not initialized</span></div>`;
    }

    if (scripts.includes('install')) {
      statusChips += `<div class="status-chip ${p.installed ? 'ok' : 'warn'}"><span class="label">Dependencies</span><span class="value">${p.installed ? 'Installed' : 'Not installed'}</span></div>`;
    }
    if (scripts.includes('build')) {
      const buildVal = p.built ? (p.buildLocation ? `Built (${p.buildLocation})` : 'Built') : 'Not built';
      statusChips += `<div class="status-chip ${p.built ? 'ok' : 'warn'}"><span class="label">Build</span><span class="value">${buildVal}</span></div>`;
    }
    statusChips += `<div class="status-chip ${p.running ? 'ok' : ''}"><span class="label">Run</span><span class="value">${p.running ? 'Running' : 'Stopped'}</span></div>`;
  }

  let actions = '';
  if (p.pathExists && p.isRepo) {
    actions += btn('pull', p.name, 'Pull', 'btn-blue');
    actions += btn('push', p.name, 'Push', 'btn-primary');
  } else if (!p.pathExists) {
    actions += btn('clone', p.name, 'Clone', 'btn-warn');
  } else {
    actions += btn('push', p.name, 'Push (Init)', 'btn-primary');
  }

  if (p.pathExists) {
    if (scripts.includes('install'))
      actions += btnRun(p.name, 'install', 'Install');
    if (scripts.includes('build'))
      actions += btnRun(p.name, 'build', 'Build');
    if (scripts.includes('dev'))
      actions += btnRun(p.name, 'dev', 'Dev');
    else if (scripts.includes('start'))
      actions += btnRun(p.name, 'start', 'Start');
    if (scripts.includes('test'))
      actions += btnRun(p.name, 'test', 'Test');
    if (p.running)
      actions += `<button class="btn btn-danger btn-sm" data-act="stop" data-procid="${p.runningProcId}">Stop</button>`;

    actions += `<div class="custom-cmd-row">
      <input type="text" class="custom-cmd-input" placeholder="custom command..." data-cmd-for="${p.name}">
      <button class="btn btn-secondary btn-sm" data-act="run-custom" data-name="${p.name}">Run</button>
    </div>`;
  }

  actions += `<button class="btn btn-secondary btn-sm" data-act="edit" data-name="${p.name}">Edit</button>`;
  actions += `<button class="btn btn-danger btn-sm" data-act="delete" data-name="${p.name}">Delete</button>`;

  const lastCommit = p.gitStatus && p.gitStatus.lastCommit
    ? `<span class="pc-path">${p.codePath} | Last: ${p.gitStatus.lastCommit.hash.substring(0, 7)} ${p.gitStatus.lastCommit.message.substring(0, 60)}</span>`
    : `<span class="pc-path">${p.codePath}</span>`;

  card.innerHTML = `
    <div class="pc-header">
      <div>
        <div class="pc-title"><a href="${repoUrl}" target="_blank">${p.name}</a></div>
        <div class="pc-owner">${p.repoOwner}/${p.name} ${p.isPrivate ? '(private)' : '(public)'}</div>
      </div>
    </div>
    <div class="pc-status">${statusChips}</div>
    <div class="pc-actions">${actions}</div>
    ${lastCommit}
  `;

  card.querySelectorAll('[data-act]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (el.dataset.act === 'run-custom') {
        const input = card.querySelector(`[data-cmd-for="${el.dataset.name}"]`);
        const cmd = input ? input.value.trim() : '';
        if (!cmd) { log('Enter a command', 'error'); return; }
        handleRunCustom(el.dataset.name, cmd);
      } else {
        handleAction(el.dataset);
      }
    });
  });

  return card;
}

function btn(act, name, label, cls) {
  return `<button class="btn ${cls} btn-sm" data-act="${act}" data-name="${name}">${label}</button>`;
}
function btnRun(name, script, label) {
  return `<button class="btn btn-secondary btn-sm" data-act="run" data-script="${script}" data-name="${name}">${label}</button>`;
}

async function handleAction(ds) {
  const { act, name, script, procid } = ds;

  switch (act) {
    case 'clone': {
      log(`Cloning ${name}...`, 'info');
      const r = await api('/api/git/clone', { projectName: name });
      log(r.success ? r.message : `Clone failed: ${r.error}`, r.success ? 'success' : 'error');
      if (r.detectedTypes) log(`Detected: ${r.detectedTypes.join(', ')}`, 'info');
      loadDashboard(false);
      break;
    }
    case 'pull': {
      log(`Pulling ${name}...`, 'info');
      const r = await api('/api/git/pull', { projectName: name });
      log(r.success ? r.message : `Pull failed: ${r.error}`, r.success ? 'success' : 'error');
      if (r.latestCommit) log(`Latest: ${r.latestCommit.hash.substring(0, 7)} - ${r.latestCommit.message}`, 'info');
      loadDashboard(false);
      break;
    }
    case 'push': {
      log(`Pushing ${name}...`, 'info');
      const global = await api('/api/global/raw');
      if (!global.token) { log('Configure token in Settings first', 'error'); return; }

      const projects = await api('/api/projects');
      const proj = projects.find(pp => pp.name === name);
      if (!proj) { log('Project not found', 'error'); return; }

      const check = await api('/api/github/check-repo', { owner: proj.repoOwner, repo: name });
      if (check.error) { log(`GitHub error: ${check.error}`, 'error'); return; }

      if (!check.exists) {
        log(`Repo not found. Creating "${name}"...`, 'warn');
        const cr = await api('/api/github/create-repo', { name, isPrivate: proj.isPrivate });
        if (cr.success) log(`Repo "${name}" created`, 'success');
        else { log(`Create failed: ${cr.error}`, 'error'); return; }
      }

      const r = await api('/api/git/push', { projectName: name });
      if (r.conflict) { showConflict(r.conflictedFiles, proj.codePath); return; }
      log(r.success ? r.message : `Push failed: ${r.error}`, r.success ? 'success' : 'error');
      if (r.latestCommit) log(`Latest: ${r.latestCommit.hash.substring(0, 7)} - ${r.latestCommit.message}`, 'info');
      loadDashboard(false);
      break;
    }
    case 'run': {
      log(`Running "${script}" on ${name}...`, 'info');
      const r = await api('/api/project/run', { projectName: name, scriptName: script });
      if (r.success) {
        currentProcId = r.procId;
        showOutput(r.cmd, r.output);
        log(`Started: ${r.cmd}`, 'success');
        loadDashboard(false);
        startPolling(r.procId);
      } else {
        log(`Error: ${r.error}`, 'error');
      }
      break;
    }
    case 'stop': {
      const r = await api('/api/project/stop', { procId: procid });
      log(r.message, 'info');
      currentProcId = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      loadDashboard(false);
      break;
    }
    case 'edit': {
      const projects = await api('/api/projects');
      const proj = projects.find(pp => pp.name === name);
      if (proj) {
        fillForm(proj);
        switchTab('add');
      }
      break;
    }
    case 'delete': {
      if (confirm(`Delete project "${name}"?`)) {
        await apiDel(`/api/projects/${encodeURIComponent(name)}`);
        log(`Deleted "${name}"`, 'warn');
        loadDashboard(false);
      }
      break;
    }
  }
}

async function handleRunCustom(name, cmd) {
  log(`Running "${cmd}" on ${name}...`, 'info');
  localStorage.setItem(`customCmd_${name}`, cmd);
  const r = await api('/api/project/run', { projectName: name, customCmd: cmd });
  if (r.success) {
    currentProcId = r.procId;
    showOutput(r.cmd, r.output);
    log(`Started: ${r.cmd}`, 'success');
    loadDashboard(false);
    startPolling(r.procId);
  } else {
    log(`Error: ${r.error}`, 'error');
  }
}

$('#btnRefresh').addEventListener('click', () => loadDashboard(false));

$('#btnStopProc').addEventListener('click', async () => {
  if (!currentProcId) { log('No running process', 'warn'); return; }
  const r = await api('/api/project/stop', { procId: currentProcId });
  log(r.message, 'info');
  currentProcId = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  loadDashboard(false);
});

function showOutput(cmd, output) {
  outputBox.innerHTML = `<pre><strong>$ ${escapeHtml(cmd)}</strong>\n\n${escapeHtml(output || '')}</pre>`;
  outputBox.scrollTop = outputBox.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function startPolling(procId) {
  if (pollTimer) clearInterval(pollTimer);
  let lastLen = 0;
  pollTimer = setInterval(async () => {
    try {
      const r = await api('/api/project/output', { procId });
      if (r.output && r.output.length !== lastLen) {
        const scriptName = procId.split('_')[1];
        showOutput(scriptName, r.output);
        lastLen = r.output.length;
      }
      if (!r.running) {
        clearInterval(pollTimer); pollTimer = null;
        log('Process finished', 'info');
        setTimeout(() => loadDashboard(false), 1000);
      }
    } catch (e) {
      clearInterval(pollTimer); pollTimer = null;
    }
  }, 1500);
}

// ===== Conflict Modal =====
function showConflict(files, codePath) {
  const modal = $('#conflictModal');
  $('#conflictMessage').textContent = 'Conflicted files:';
  const filesEl = $('#conflictFiles');
  filesEl.innerHTML = '';
  (files || []).forEach(f => {
    const d = document.createElement('div'); d.textContent = f; filesEl.appendChild(d);
  });
  modal.classList.remove('hidden');

  $('#btnAbortMerge').onclick = async () => {
    const r = await api('/api/git/resolve-conflict', { codePath, action: 'abort' });
    log(r.message || r.error, r.success ? 'success' : 'error');
    modal.classList.add('hidden');
    loadDashboard(false);
  };
  $('#btnResolveContinue').onclick = async () => {
    log('Resolve conflicts in editor, then click here.', 'warn');
    const r = await api('/api/git/resolve-conflict', { codePath, action: 'continue' });
    log(r.message || r.error, r.success ? 'success' : 'error');
    modal.classList.add('hidden');
    loadDashboard(false);
  };
}

// ===== Init =====
loadGlobal();
loadDashboard();
