const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const simpleGit = require('simple-git');
const { Octokit } = require('@octokit/rest');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_DIR = path.join(__dirname, 'config');
const GLOBAL_FILE = path.join(CONFIG_DIR, 'global.json');
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadGlobal() {
  if (fs.existsSync(GLOBAL_FILE)) {
    return JSON.parse(fs.readFileSync(GLOBAL_FILE, 'utf-8'));
  }
  return { token: '', gitName: '', gitEmail: '', githubUser: '' };
}

function saveGlobal(data) {
  fs.writeFileSync(GLOBAL_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function loadProjects() {
  if (fs.existsSync(PROJECTS_FILE)) {
    return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
  }
  return [];
}

function saveProjects(data) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getOctokit(token) {
  return new Octokit({ auth: token });
}

function detectProjectType(codePath) {
  if (!fs.existsSync(codePath)) return [];
  const checks = [
    { file: 'package.json', type: 'nodejs' },
    { file: 'requirements.txt', type: 'python' },
    { file: 'pyproject.toml', type: 'python' },
    { file: 'Pipfile', type: 'python' },
    { file: 'setup.py', type: 'python' },
    { file: 'pom.xml', type: 'java' },
    { file: 'build.gradle', type: 'java' },
    { file: 'go.mod', type: 'go' },
    { file: 'Cargo.toml', type: 'rust' },
    { file: 'composer.json', type: 'php' },
    { file: 'Gemfile', type: 'ruby' },
    { file: '*.sln', type: 'dotnet' },
    { file: 'pubspec.yaml', type: 'dart' },
  ];
  const types = new Set();
  for (const c of checks) {
    if (c.file.includes('*')) {
      const ext = c.file.replace('*', '');
      const found = fs.readdirSync(codePath).some(f => f.endsWith(ext));
      if (found) types.add(c.type);
    } else if (fs.existsSync(path.join(codePath, c.file))) {
      types.add(c.type);
    }
  }
  if (fs.existsSync(path.join(codePath, 'tsconfig.json'))) types.add('typescript');
  return [...types];
}

function generateGitignore(codePath) {
  const common = [
    '', '# OS files', '.DS_Store', 'Thumbs.db', 'desktop.ini', 'ehthumbs.db',
    '', '# IDE / Editor', '.vscode/', '.idea/', '*.swp', '*.swo', '*~',
    '', '# Environment / Secrets', '.env', '.env.*', '!.env.example', '*.pem', '*.key',
    '', '# Logs', '*.log', 'logs/', 'npm-debug.log*', 'yarn-debug.log*', 'yarn-error.log*',
    '', '# Build outputs', 'dist/', 'build/', 'out/', 'target/',
    '', '# Temp files', '*.tmp', '*.temp', '.tmp/', 'temp/',
    '', '# Cache', '.cache/', '.parcel-cache/', '.turbo/',
  ];
  const typeRules = {
    nodejs: ['', '# Node.js', 'node_modules/', 'coverage/', '.npm', '.pnp.*', '.yarn/', '!.yarn/patches', '!.yarn/plugins', '!.yarn/releases', '!.yarn/versions'],
    python: ['', '# Python', '__pycache__/', '*.py[cod]', 'venv/', '.venv/', '.eggs/', '*.egg-info/', '.tox/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/'],
    java: ['', '# Java', '*.class', '*.jar', '*.war', '.classpath', '.project', '.settings/', 'bin/'],
    go: ['', '# Go', '*.exe', 'vendor/'],
    rust: ['', '# Rust', '/target/'],
    php: ['', '# PHP', 'vendor/'],
    ruby: ['', '# Ruby', '*.gem', '.bundle/', 'vendor/bundle'],
    dotnet: ['', '# .NET', 'bin/', 'obj/', '*.user', '*.suo', 'packages/', '*.nupkg'],
    dart: ['', '# Dart / Flutter', '.dart_tool/', '.flutter-plugins', '.packages', '.pub-cache/'],
    typescript: ['', '# TypeScript', '*.tsbuildinfo'],
  };
  const types = detectProjectType(codePath);
  const lines = ['# Auto-generated .gitignore', ...common];
  types.forEach(t => { if (typeRules[t]) lines.push(...typeRules[t]); });
  lines.push('');
  return lines.join('\n');
}

function ensureGitignore(codePath) {
  const gitignorePath = path.join(codePath, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    const content = generateGitignore(codePath);
    fs.writeFileSync(gitignorePath, content, 'utf-8');
    return { created: true, types: detectProjectType(codePath) };
  }
  return { created: false, types: detectProjectType(codePath) };
}

const runningProcesses = {};
const processOutputs = {};

function getProjectScripts(codePath, types) {
  const scripts = {};
  if (types.includes('nodejs') && fs.existsSync(path.join(codePath, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(codePath, 'package.json'), 'utf-8'));
    const pkgScripts = pkg.scripts || {};
    scripts.install = { cmd: 'npm', args: ['install'] };
    if (pkgScripts.build) scripts.build = { cmd: 'npm', args: ['run', 'build'] };
    if (pkgScripts.start) scripts.start = { cmd: 'npm', args: ['run', 'start'] };
    if (pkgScripts.dev) scripts.dev = { cmd: 'npm', args: ['run', 'dev'] };
    if (pkgScripts.test) scripts.test = { cmd: 'npm', args: ['run', 'test'] };
    if (pkgScripts.lint) scripts.lint = { cmd: 'npm', args: ['run', 'lint'] };
    if (pkgScripts.typecheck) scripts.typecheck = { cmd: 'npm', args: ['run', 'typecheck'] };
    scripts.availableScripts = Object.keys(pkgScripts);
  }
  if (types.includes('python')) {
    if (fs.existsSync(path.join(codePath, 'requirements.txt'))) {
      scripts.install = { cmd: 'pip', args: ['install', '-r', 'requirements.txt'] };
    }
    for (const f of ['main.py', 'app.py', 'manage.py', 'run.py']) {
      if (fs.existsSync(path.join(codePath, f))) { scripts.start = { cmd: 'python', args: [f] }; break; }
    }
  }
  if (types.includes('go')) {
    scripts.install = { cmd: 'go', args: ['mod', 'download'] };
    scripts.build = { cmd: 'go', args: ['build', './...'] };
    scripts.start = { cmd: 'go', args: ['run', '.'] };
  }
  if (types.includes('rust')) {
    scripts.build = { cmd: 'cargo', args: ['build'] };
    scripts.start = { cmd: 'cargo', args: ['run'] };
    scripts.test = { cmd: 'cargo', args: ['test'] };
  }
  if (types.includes('java')) {
    if (fs.existsSync(path.join(codePath, 'pom.xml'))) {
      scripts.install = { cmd: 'mvn', args: ['install'] };
      scripts.build = { cmd: 'mvn', args: ['package'] };
    } else if (fs.existsSync(path.join(codePath, 'build.gradle'))) {
      scripts.install = { cmd: 'gradle', args: ['build'] };
    }
  }
  return scripts;
}

function checkInstalled(codePath, types) {
  if (types.includes('nodejs')) return fs.existsSync(path.join(codePath, 'node_modules'));
  if (types.includes('python')) return fs.existsSync(path.join(codePath, 'venv')) || fs.existsSync(path.join(codePath, '.venv'));
  return true;
}

function findBuildOutput(codePath, types) {
  const buildDirs = ['dist', 'build', 'out', 'public', 'target', '.next', '.nuxt'];
  const checkDirs = [codePath];
  try {
    const entries = fs.readdirSync(codePath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git' && !e.name.startsWith('.')) {
        checkDirs.push(path.join(codePath, e.name));
      }
    }
  } catch (e) {}
  for (const dir of checkDirs) {
    for (const bd of buildDirs) {
      const p = path.join(dir, bd);
      if (fs.existsSync(p)) {
        try {
          const files = fs.readdirSync(p);
          if (files.length > 0) return { found: true, location: path.relative(codePath, p) };
        } catch (e) {}
      }
    }
  }
  return { found: false, location: null };
}

function checkBuilt(codePath, types) {
  if (types.includes('nodejs') || types.includes('java')) {
    return findBuildOutput(codePath, types).found;
  }
  return true;
}

// ===== Global Config =====

app.get('/api/global', (req, res) => {
  const g = loadGlobal();
  res.json({ ...g, token: g.token ? g.token.substring(0, 8) + '***' : '' });
});

app.get('/api/global/raw', (req, res) => {
  res.json(loadGlobal());
});

app.post('/api/global', (req, res) => {
  const { token, gitName, gitEmail } = req.body;
  const current = loadGlobal();
  if (token !== undefined) current.token = token;
  if (gitName !== undefined) current.gitName = gitName;
  if (gitEmail !== undefined) current.gitEmail = gitEmail;
  saveGlobal(current);
  res.json({ success: true });
});

app.post('/api/global/verify', async (req, res) => {
  try {
    const { token } = req.body;
    const octokit = getOctokit(token);
    const { data } = await octokit.users.getAuthenticated();
    const current = loadGlobal();
    current.githubUser = data.login;
    if (!current.gitName) current.gitName = data.name || data.login;
    if (!current.gitEmail) current.gitEmail = data.email || `${data.login}@users.noreply.github.com`;
    saveGlobal(current);
    res.json({ user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Projects =====

app.get('/api/projects', async (req, res) => {
  try {
    const projects = loadProjects();
    const results = [];
    for (const p of projects) {
      const exists = fs.existsSync(p.codePath);
      let types = [], isRepo = false, gitStatus = null, installed = false, built = false, buildLocation = null, availableScripts = {};
      if (exists) {
        types = detectProjectType(p.codePath);
        installed = checkInstalled(p.codePath, types);
        built = checkBuilt(p.codePath, types);
        if (built) {
          const result = findBuildOutput(p.codePath, types);
          buildLocation = result.location;
        }
        availableScripts = getProjectScripts(p.codePath, types);
        try {
          const git = simpleGit(p.codePath);
          isRepo = await git.checkIsRepo();
          if (isRepo) {
            const st = await git.status();
            const branch = st.current;
            const modified = st.modified.length + st.created.length;
            const untracked = st.not_added.length;
            const conflicted = st.conflicted.length;
            let lastCommit = null;
            try { const l = await git.log({ maxCount: 1 }); lastCommit = l.latest; } catch (e) {}
            gitStatus = { branch, modified, untracked, conflicted, lastCommit };
          }
        } catch (e) {}
      }
      const procKey = Object.keys(runningProcesses).find(k => k.startsWith(p.name + '_'));
      results.push({
        ...p,
        pathExists: exists,
        detectedTypes: types,
        isRepo,
        gitStatus,
        installed,
        built,
        buildLocation,
        availableScripts: Object.keys(availableScripts).filter(k => k !== 'availableScripts'),
        allScripts: availableScripts.availableScripts || [],
        running: !!procKey,
        runningProcId: procKey || null,
      });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const { name, repoOwner, codePath, branch, isPrivate } = req.body;
    if (!name || !repoOwner) {
      res.status(400).json({ error: 'Name and owner are required' });
      return;
    }
    const projects = loadProjects();
    const project = { name, repoOwner, codePath: codePath || '', branch: branch || 'main', isPrivate: !!isPrivate, updatedAt: new Date().toISOString() };
    const idx = projects.findIndex(p => p.name === name);
    if (idx >= 0) {
      projects[idx] = { ...projects[idx], ...project };
    } else {
      projects.push(project);
    }
    saveProjects(projects);
    res.json({ success: true, project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:name', (req, res) => {
  const projects = loadProjects();
  saveProjects(projects.filter(p => p.name !== req.params.name));
  res.json({ success: true });
});

// ===== GitHub =====

app.post('/api/github/check-repo', async (req, res) => {
  try {
    const { owner, repo } = req.body;
    const token = (req.body.token || loadGlobal().token);
    const octokit = getOctokit(token);
    try {
      const { data } = await octokit.repos.get({ owner, repo });
      res.json({ exists: true, repo: data });
    } catch (e) {
      if (e.status === 404) res.json({ exists: false }); else throw e;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/github/create-repo', async (req, res) => {
  try {
    const { name, isPrivate, description } = req.body;
    const token = (req.body.token || loadGlobal().token);
    const octokit = getOctokit(token);
    const { data } = await octokit.repos.createForAuthenticatedUser({ name, private: !!isPrivate, description: description || '', auto_init: false });
    res.json({ success: true, repo: data });
  } catch (err) {
    let message = err.message;
    if (err.status === 403 || err.status === 404) {
      const token = (req.body.token || loadGlobal().token);
      const isFineGrained = token.startsWith('github_pat_');
      message = isFineGrained
        ? `Token 权限不足 (Fine-grained)。需要 Administration + Contents: Read and write`
        : `Token 权限不足。请确保 Classic Token 已勾选 repo scope。`;
    }
    res.status(500).json({ error: message });
  }
});

app.post('/api/github/user', async (req, res) => {
  try {
    const token = (req.body.token || loadGlobal().token);
    const octokit = getOctokit(token);
    const { data } = await octokit.users.getAuthenticated();
    res.json({ user: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/github/repos', async (req, res) => {
  try {
    const token = (req.body.token || loadGlobal().token);
    const octokit = getOctokit(token);
    const { data } = await octokit.repos.listForAuthenticatedUser({ per_page: 100, sort: 'updated' });
    res.json({ repos: data.map(r => ({ name: r.name, full_name: r.full_name, private: r.private, clone_url: r.clone_url, html_url: r.html_url, default_branch: r.default_branch })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Git Operations (all by project name) =====

async function resolveProject(projectName) {
  const projects = loadProjects();
  const project = projects.find(p => p.name === projectName);
  if (!project) throw new Error('Project not found');
  return project;
}

app.post('/api/git/push', async (req, res) => {
  try {
    const { projectName, commitMessage } = req.body;
    const global = loadGlobal();
    const project = await resolveProject(projectName);
    const { codePath, repoOwner, name, branch } = project;
    const git = simpleGit(codePath);
    const targetBranch = branch || 'main';
    const remoteUrl = `https://x-access-token:${global.token}@github.com/${repoOwner}/${name}.git`;

    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      await git.init(['-b', targetBranch]);
      await git.addConfig('core.autocrlf', 'true');
    }

    if (global.gitName) await git.addConfig('user.name', global.gitName);
    if (global.gitEmail) await git.addConfig('user.email', global.gitEmail);

    const remotes = await git.getRemotes();
    const hasOrigin = remotes.some(r => r.name === 'origin');
    if (hasOrigin) await git.remote(['set-url', 'origin', remoteUrl]);
    else await git.addRemote('origin', remoteUrl);

    let hasRemoteBranch = false;
    try { await git.fetch('origin', targetBranch); await git.revparse([`origin/${targetBranch}`]); hasRemoteBranch = true; } catch (e) {}

    let localHasCommits = true;
    try { await git.revparse(['HEAD']); } catch (e) { localHasCommits = false; }

    if (!localHasCommits && hasRemoteBranch) {
      await git.checkout(['-B', targetBranch, `origin/${targetBranch}`]);
    } else if (localHasCommits) {
      const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (currentBranch !== targetBranch) {
        try { await git.checkout(targetBranch); } catch (e) { await git.branch(['-M', targetBranch]); }
      }
    }

    ensureGitignore(codePath);
    await git.add('.');
    const status = await git.status();

    if (status.staged.length === 0 && status.modified.length === 0 && status.not_added.length === 0) {
      if (localHasCommits || hasRemoteBranch) {
        try { await git.push('origin', targetBranch, { '--set-upstream': null }); res.json({ success: true, message: 'Already up to date.' }); return; }
        catch (e) { res.json({ success: true, message: 'No local changes.' }); return; }
      }
      res.json({ success: true, message: 'No local changes.' });
      return;
    }

    const msg = commitMessage || `Auto commit: ${new Date().toISOString()}`;
    await git.commit(msg);

    if (hasRemoteBranch) {
      try {
        await git.pull('origin', targetBranch, { '--no-rebase': null });
      } catch (pullErr) {
        const cs = await git.status();
        if (cs.conflicted.length > 0) {
          res.json({ success: false, conflict: true, conflictedFiles: cs.conflicted, message: 'Merge conflict detected.' });
          return;
        }
        throw pullErr;
      }
    }

    await git.push('origin', targetBranch, { '--set-upstream': null });
    const log = await git.log({ maxCount: 1 });
    res.json({ success: true, message: 'Push successful.', latestCommit: log.latest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/git/clone', async (req, res) => {
  try {
    const { projectName } = req.body;
    const global = loadGlobal();
    const project = await resolveProject(projectName);
    const { codePath, repoOwner, name, branch } = project;

    if (!codePath) { res.status(400).json({ error: 'Please set a local path for this project' }); return; }

    let cloneUrl = `https://x-access-token:${global.token}@github.com/${repoOwner}/${name}.git`;

    if (fs.existsSync(codePath)) {
      const contents = fs.readdirSync(codePath);
      if (contents.length > 0) { res.status(400).json({ error: `Path "${codePath}" is not empty.` }); return; }
    } else {
      fs.mkdirSync(codePath, { recursive: true });
    }

    const git = simpleGit();
    const options = branch ? ['-b', branch] : [];
    await git.clone(cloneUrl, codePath, options);
    ensureGitignore(codePath);

    const projects = loadProjects();
    const idx = projects.findIndex(p => p.name === projectName);
    if (idx >= 0) { projects[idx].updatedAt = new Date().toISOString(); saveProjects(projects); }

    res.json({ success: true, message: `Cloned to ${codePath}`, detectedTypes: detectProjectType(codePath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/git/pull', async (req, res) => {
  try {
    const { projectName } = req.body;
    const project = await resolveProject(projectName);
    const git = simpleGit(project.codePath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) { res.status(400).json({ error: 'Not a git repository' }); return; }
    const targetBranch = project.branch || (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    await git.pull('origin', targetBranch);
    const log = await git.log({ maxCount: 1 });
    res.json({ success: true, message: 'Pull successful.', latestCommit: log.latest });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/git/status', async (req, res) => {
  try {
    const { codePath } = req.body;
    if (!fs.existsSync(codePath)) { res.json({ isRepo: false, status: null, pathExists: false }); return; }
    const git = simpleGit(codePath);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) { res.json({ isRepo: false, status: null, pathExists: true }); return; }
    const status = await git.status();
    const log = await git.log({ maxCount: 5 }).catch(() => ({ all: [] }));
    res.json({ isRepo: true, pathExists: true, status, recentCommits: log.all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/git/resolve-conflict', async (req, res) => {
  try {
    const { codePath, action } = req.body;
    const git = simpleGit(codePath);
    if (action === 'abort') {
      await git.merge(['--abort']).catch(() => git.rebase(['--abort']));
      res.json({ success: true, message: 'Merge aborted.' });
    } else if (action === 'continue') {
      await git.add('.');
      await git.commit('Resolved merge conflicts');
      res.json({ success: true, message: 'Conflicts resolved and committed.' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Project Run/Install/Build =====

app.post('/api/project/run', (req, res) => {
  try {
    const { projectName, scriptName, customCmd } = req.body;
    const projects = loadProjects();
    const project = projects.find(p => p.name === projectName);
    if (!project) { res.status(400).json({ error: 'Project not found' }); return; }

    const codePath = project.codePath;
    if (!fs.existsSync(codePath)) { res.status(400).json({ error: 'Path not found' }); return; }
    const types = detectProjectType(codePath);
    const scripts = getProjectScripts(codePath, types);

    let cmd, args;
    if (customCmd) {
      const parts = customCmd.trim().split(/\s+/);
      cmd = parts[0]; args = parts.slice(1);
    } else if (scripts[scriptName]) {
      cmd = scripts[scriptName].cmd; args = scripts[scriptName].args;
    } else {
      res.status(400).json({ error: `Script "${scriptName}" not available` }); return;
    }

    const procId = `${projectName}_${scriptName || 'custom'}_${Date.now()}`;
    const output = [];
    const proc = spawn(cmd, args, { cwd: codePath, shell: true, env: { ...process.env, FORCE_COLOR: '0' } });

    runningProcesses[procId] = proc;
    processOutputs[procId] = output;

    proc.stdout.on('data', (data) => {
      output.push(data.toString());
      if (output.length > 500) output.shift();
    });
    proc.stderr.on('data', (data) => {
      output.push(`[STDERR] ${data.toString()}`);
      if (output.length > 500) output.shift();
    });
    proc.on('close', (code) => {
      output.push(`\n[Process exited with code ${code}]`);
      delete runningProcesses[procId];
    });
    proc.on('error', (err) => {
      output.push(`\n[Error: ${err.message}]`);
      delete runningProcesses[procId];
    });

    setTimeout(() => {
      res.json({ success: true, procId, cmd: `${cmd} ${args.join(' ')}`, output: output.join('') });
    }, 2000);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/project/output', (req, res) => {
  const { procId } = req.body;
  const proc = runningProcesses[procId];
  const output = processOutputs[procId] || [];
  if (!proc) {
    res.json({ running: false, output: output.join('') });
    return;
  }
  res.json({ running: true, pid: proc.pid, output: output.join('') });
});

app.post('/api/project/stop', (req, res) => {
  const { procId } = req.body;
  const proc = runningProcesses[procId];
  if (!proc) { res.json({ success: false, message: 'Process not found' }); return; }
  proc.kill('SIGTERM');
  delete runningProcesses[procId];
  res.json({ success: true, message: 'Process stopped' });
});

// ===== .gitignore =====

app.post('/api/gitignore/preview', (req, res) => {
  try {
    const { codePath } = req.body;
    if (!fs.existsSync(codePath)) { res.status(400).json({ error: 'Path does not exist' }); return; }
    const types = detectProjectType(codePath);
    const content = generateGitignore(codePath);
    const existingPath = path.join(codePath, '.gitignore');
    const existing = fs.existsSync(existingPath) ? fs.readFileSync(existingPath, 'utf-8') : null;
    res.json({ detectedTypes: types, generated: content, existing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
