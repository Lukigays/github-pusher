/**
 * lib/github.js
 * ------------------------------------------------------------------
 * Klien tipis untuk GitHub REST API (tanpa `git` CLI).
 *
 * Push memakai Git Data API:
 *   1. POST /git/blobs   (isi tiap file, base64)
 *   2. POST /git/trees   (base_tree = tree branch tujuan agar file lama tetap ada)
 *   3. POST /git/commits (parent = SHA branch tujuan)
 *   4. PATCH /git/refs/heads/<branch>  (force = true -> branch bergeser ke commit baru)
 *
 * => 1 commit untuk seluruh folder/ZIP, berapa pun jumlah filenya.
 * ------------------------------------------------------------------
 */
const { getContentBase64 } = require('./filesource');

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const CONCURRENCY = Number(process.env.GITHUB_CONCURRENCY || 5);
const MAX_API_FILE_BYTES = 100 * 1024 * 1024; // batas blob Contents/Git Data API

/** Jalankan promise factory dengan batas konkurensi. */
async function pMap(items, limit, worker, onEach) {
  const results = new Array(items.length);
  let cursor = 0;
  let finished = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
      finished++;
      if (onEach) onEach(finished, items.length, items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

class GitHub {
  constructor(token) {
    this.token = token;
  }

  async request(method, urlPath, body, extraHeaders = {}) {
    const url = urlPath.startsWith('http') ? urlPath : API + urlPath;
    const res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-zip-pusher',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const headers = Object.fromEntries(res.headers.entries());
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.details = data;
      err.headers = headers;
      throw err;
    }
    return { data, headers, status: res.status };
  }

  /* ---------------- Auth / user ---------------- */

  async me() {
    const { data, headers } = await this.request('GET', '/user');
    const oauthScopes = (headers['x-oauth-scopes'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return {
      login: data.login,
      name: data.name || data.login,
      avatar: data.avatar_url,
      email: data.email,
      html_url: data.html_url,
      scopes: oauthScopes,
      plan: data.plan && data.plan.name,
    };
  }

  /** Cek izin push pada sebuah repo (untuk memberi peringatan dini). */
  async repoPermission(owner, repo) {
    const { data } = await this.request('GET', `/repos/${owner}/${repo}`);
    return {
      full_name: data.full_name,
      private: data.private,
      default_branch: data.default_branch,
      permission: data.permissions && (data.permissions.admin ? 'admin' : data.permissions.push ? 'push' : 'pull'),
      size_kb: data.size,
    };
  }

  /* ---------------- Repo & branch ---------------- */

  async listRepos({ perPage = 100, page = 1, type = 'all', sort = 'pushed' } = {}) {
    const q = `?per_page=${perPage}&page=${page}&type=${type}&sort=${sort}`;
    const { data } = await this.request('GET', `/user/repos${q}`);
    return (data || []).map((r) => ({
      full_name: r.full_name,
      name: r.name,
      owner: r.owner.login,
      private: r.private,
      default_branch: r.default_branch,
      pushed_at: r.pushed_at,
      permission: r.permissions && (r.permissions.admin ? 'admin' : r.permissions.push ? 'push' : 'pull'),
      html_url: r.html_url,
    }));
  }

  /** Repo milik organisasi tempat user punya akses push (pelengkap /user/repos). */
  async listOrgPushRepos() {
    const { data: orgs } = await this.request('GET', '/user/orgs?per_page=100');
    const out = [];
    for (const org of orgs || []) {
      try {
        const { data } = await this.request('GET', `/orgs/${org.login}/repos?per_page=100&type=all`);
        for (const r of data || []) {
          const perm = r.permissions && (r.permissions.admin ? 'admin' : r.permissions.push ? 'push' : 'pull');
          if (perm !== 'pull') {
            out.push({
              full_name: r.full_name, name: r.name, owner: r.owner.login, private: r.private,
              default_branch: r.default_branch, pushed_at: r.pushed_at, permission: perm, html_url: r.html_url,
            });
          }
        }
      } catch (_) { /* lewati org tanpa akses */ }
    }
    return out;
  }

  async listBranches(owner, repo) {
    const { data } = await this.request('GET', `/repos/${owner}/${repo}/branches?per_page=100`);
    return (data || []).map((b) => ({ name: b.name, sha: b.commit.sha, protected: !!b.protected }));
  }

  async branchExists(owner, repo, branch) {
    try {
      const { data } = await this.request('GET', `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
      return data.commit.sha;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /** Isi sebuah folder di repo (dipakai UI untuk menelusuri path tujuan). */
  async tree(owner, repo, treePath = '') {
    const rel = String(treePath || '').replace(/^\/+/, '');
    const url = `/repos/${owner}/${repo}/contents/${rel.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
    const { data } = await this.request('GET', url);
    if (!Array.isArray(data)) return [];
    return data.map((d) => ({ name: d.name, path: d.path, type: d.type, size: d.size, sha: d.sha }));
  }

  async createRepo({ name, private: isPrivate = false, description = '', autoInit = true, org }) {
    const urlPath = org ? `/orgs/${org}/repos` : '/user/repos';
    const { data } = await this.request('POST', urlPath, {
      name, private: isPrivate, description, auto_init: autoInit,
      gitignore_template: '', license_template: '',
    });
    return { full_name: data.full_name, default_branch: data.default_branch, html_url: data.html_url };
  }

  /* ---------------- Push ---------------- */

  /**
   * @param {object} p
   *  owner, repo, branch, destPath ('' = root), message,
   *  files: [{ path, absPath, size, mode }],
   *  createBranch, baseBranch, overwrite, deleteExisting,
   *  onProgress(stage, info)
   */
  async pushFiles(p) {
    const {
      owner, repo, branch, destPath = '', message = 'Upload via github-zip-pusher',
      files, createBranch = false, baseBranch = null, overwrite = true, deleteExisting = false,
      author, onProgress = () => {},
    } = p;

    const norm = (s) => String(s || '').replace(/^\/+|\/+$/g, '');
    const base = norm(destPath);
    const prefix = base ? base + '/' : '';

    const tooBig = files.filter((f) => f.size > MAX_API_FILE_BYTES);
    if (tooBig.length) {
      const e = new Error(`File melebihi batas 100 MB GitHub API: ${tooBig.slice(0, 3).map((f) => f.path).join(', ')}`);
      e.status = 413;
      throw e;
    }
    if (files.length === 0) {
      const e = new Error('Tidak ada file yang bisa di-push (semua terfilter / folder kosong).');
      e.status = 400;
      throw e;
    }

    onProgress('start', { total: files.length, branch, destPath: base || '(root)' });

    /* --- tentukan base ref --- */
    let parentSha = null;
    let baseTreeSha = null;
    let existingFiles = new Set();

    const targetExists = await this.branchExists(owner, repo, branch);
    /* v1.1.5: "buat branch baru" hanya berlaku bila branch benar-benar belum ada.
       Bila sudah ada, tulis ke branch itu (update) — sebelumnya GitHub membalas
       422 "Reference already exists". */
    if (targetExists) {
      parentSha = targetExists;
    } else {
      const fromBranch = baseBranch || (await this.repoPermission(owner, repo)).default_branch;
      const fromSha = await this.branchExists(owner, repo, fromBranch);
      if (!fromSha) {
        const e = new Error(`Branch basis "${fromBranch}" tidak ditemukan di ${owner}/${repo}.`);
        e.status = 404;
        throw e;
      }
      parentSha = fromSha;
    }

    const { data: commitInfo } = await this.request('GET', `/repos/${owner}/${repo}/git/commits/${parentSha}`);
    baseTreeSha = commitInfo.tree.sha;

    /* --- file yang sudah ada di folder tujuan (untuk overwrite / deleteExisting) --- */
    if (base) {
      try {
        const { data } = await this.request('GET', `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`);
        for (const t of data.tree || []) if (t.type === 'blob') existingFiles.add(t.path);
        if (data.truncated) onProgress('warn', { message: 'Tree repo sangat besar (terpotong), daftar file lama mungkin tidak lengkap.' });
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    } else {
      const { data } = await this.request('GET', `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`);
      for (const t of data.tree || []) if (t.type === 'blob') existingFiles.add(t.path);
    }

    const finalFiles = files.map((f) => ({ ...f, repoPath: prefix + f.path }));
    const conflicts = finalFiles.filter((f) => existingFiles.has(f.repoPath));
    if (conflicts.length && !overwrite) {
      const e = new Error(`${conflicts.length} file sudah ada di tujuan dan opsi "timpa" dimatikan. Contoh: ${conflicts.slice(0, 5).map((c) => c.repoPath).join(', ')}`);
      e.status = 409;
      e.conflicts = conflicts.map((c) => c.repoPath);
      throw e;
    }

    /* --- 1) buat blob --- */
    onProgress('blobs', { total: finalFiles.length, done: 0 });
    const withSha = await pMap(finalFiles, CONCURRENCY, async (f) => {
      // mendukung 2 mode: file di disk (absPath) atau buffer di memori (content) — Vercel
      const content = await getContentBase64(f);
      const { data } = await this.request('POST', `/repos/${owner}/${repo}/git/blobs`, {
        content,
        encoding: 'base64',
      });
      // jangan bawa buffer ke respons (hemat memori & ukuran JSON)
      const { content: _drop, absPath: _drop2, ...safe } = f;
      return { ...safe, sha: data.sha };
    }, (done, total) => onProgress('blobs', { total, done }));

    /* --- 2) buat tree --- */
    onProgress('tree', {});
    const treeItems = withSha.map((f) => ({
      path: f.repoPath,
      mode: (f.mode & 0o111) ? '100755' : '100644',
      type: 'blob',
      sha: f.sha,
    }));

    // hapus file lama di folder tujuan bila diminta -> cukup tidak menyertakannya di tree
    let treePayload = { base_tree: baseTreeSha, tree: treeItems };
    const removed = [];
    if (deleteExisting && base) {
      const kept = [];
      for (const ex of existingFiles) {
        if (ex.startsWith(prefix) && !treeItems.some((t) => t.path === ex)) removed.push(ex);
      }
      if (removed.length) {
        // susun ulang tree lengkap tanpa file yang dihapus
        const { data } = await this.request('GET', `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`);
        const drop = new Set(removed);
        const full = (data.tree || [])
          .filter((t) => t.type === 'blob' && !drop.has(t.path))
          .map((t) => ({ path: t.path, mode: t.mode, type: 'blob', sha: t.sha }));
        treePayload = { tree: [...full, ...treeItems] };
      }
    }

    const { data: newTree } = await this.request('POST', `/repos/${owner}/${repo}/git/trees`, treePayload);

    /* --- 3) buat commit --- */
    onProgress('commit', {});
    const commitBody = { message, tree: newTree.sha, parents: [parentSha] };
    if (author && author.name) {
      commitBody.author = { name: author.name, email: author.email || `${author.login || 'user'}@users.noreply.github.com` };
    }
    const { data: newCommit } = await this.request('POST', `/repos/${owner}/${repo}/git/commits`, commitBody);

    /* --- 4) update / buat ref --- */
    onProgress('ref', { createBranch: !targetExists });
    const refPath = `refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
    let refData;
    if (targetExists) {
      refData = (await this.request('PATCH', `/repos/${owner}/${repo}/git/${refPath}`, { sha: newCommit.sha, force: true })).data;
    } else {
      try {
        refData = (await this.request('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: newCommit.sha })).data;
      } catch (e) {
        // race: branch muncul di antara pengecekan dan pembuatan -> fallback update
        if (e.status === 422 && /already exists/i.test(String(e.message))) {
          refData = (await this.request('PATCH', `/repos/${owner}/${repo}/git/${refPath}`, { sha: newCommit.sha, force: true })).data;
        } else throw e;
      }
    }

    onProgress('done', { sha: newCommit.sha });
    return {
      sha: newCommit.sha,
      shortSha: newCommit.sha.slice(0, 7),
      branch,
      branchCreated: !targetExists,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
      treeUrl: `https://github.com/${owner}/${repo}/tree/${branch}${base ? '/' + base : ''}`,
      files: withSha.map((f) => ({ path: f.repoPath, size: f.size, sha: f.sha })),
      serverless: finalFiles.some((f) => f.content !== undefined),
      overwritten: conflicts.map((c) => c.repoPath),
      removed,
    };
  }

  /**
   * Hapus SEMUA file di sebuah branch: commit baru dengan tree kosong, lalu ref
   * digeser paksa ke commit itu. Riwayat tetap utuh — pemulihan = revert commit.
   */
  async wipeBranch({ owner, repo, branch, message, author } = {}) {
    const head = await this.branchExists(owner, repo, branch);
    if (!head) {
      const e = new Error(`Branch "${branch}" tidak ditemukan di ${owner}/${repo}.`);
      e.status = 404;
      throw e;
    }

    // hitung file yang akan hilang (untuk laporan)
    let removed = 0;
    try {
      const { data: headCommit } = await this.request('GET', `/repos/${owner}/${repo}/git/commits/${head}`);
      const { data: oldTree } = await this.request('GET', `/repos/${owner}/${repo}/git/trees/${headCommit.tree.sha}?recursive=1`);
      removed = (oldTree.tree || []).filter((t) => t.type === 'blob').length;
    } catch (_) { /* laporan bersifat opsional */ }

    const { data: emptyTree } = await this.request('POST', `/repos/${owner}/${repo}/git/trees`, { tree: [] });
    const commitBody = { message, tree: emptyTree.sha, parents: [head] };
    if (author && author.name) {
      commitBody.author = { name: author.name, email: author.email || `${author.login || 'user'}@users.noreply.github.com` };
    }
    const { data: newCommit } = await this.request('POST', `/repos/${owner}/${repo}/git/commits`, commitBody);
    const refPath = `refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
    await this.request('PATCH', `/repos/${owner}/${repo}/git/${refPath}`, { sha: newCommit.sha, force: true });

    return {
      sha: newCommit.sha,
      shortSha: newCommit.sha.slice(0, 7),
      branch,
      removed,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`,
      treeUrl: `https://github.com/${owner}/${repo}/tree/${branch}`,
    };
  }
}

/**
 * GitHub "tiruan" di memori — dipakai MODE DEMO supaya seluruh alur push
 * (blob -> tree -> commit -> ref) bisa dicoba tanpa token & tanpa repo asli.
 * Mengembalikan URL ke github.com/mock/<repo> agar jelas itu bukan commit nyata.
 */
function createMockGitHub(seedRepos = []) {
  const repos = new Map();
  const sha = () => require('crypto').randomBytes(20).toString('hex');

  for (const r of seedRepos) {
    const readme = Buffer.from(`# ${r.name || r.full_name}\n\nRepo contoh (mode demo).\n`);
    const blobSha = sha();
    const treeSha = sha();
    const commitSha = sha();
    repos.set(r.full_name, {
      meta: { ...r, default_branch: r.default_branch || 'main' },
      blobs: new Map([[blobSha, readme]]),
      trees: new Map([[treeSha, new Map([['README.md', { sha: blobSha, mode: '100644', size: readme.length }]])]]),
      commits: new Map([[commitSha, { sha: commitSha, tree: { sha: treeSha }, parents: [], message: 'Initial commit' }]]),
      branches: new Map([[r.default_branch || 'main', commitSha]]),
    });
  }

  const gh = new GitHub('mock');
  gh.isMock = true;

  gh.me = async () => ({ login: 'demo-user', name: 'Demo User', avatar: null, email: 'demo@example.com', html_url: 'https://github.com/', scopes: ['repo (mock)'] });

  gh.repoPermission = async (owner, repo) => {
    const key = `${owner}/${repo}`;
    const r = repos.get(key);
    if (!r) { const e = new Error(`Repo ${key} tidak ada di data mock.`); e.status = 404; throw e; }
    return { full_name: key, private: !!r.meta.private, default_branch: r.meta.default_branch, permission: 'admin', size_kb: 1 };
  };

  gh.listRepos = async () => [...repos.values()].map((r) => ({ ...r.meta, pushed_at: new Date().toISOString() }));
  gh.listOrgPushRepos = async () => [];

  gh.listBranches = async (owner, repo) => {
    const r = repos.get(`${owner}/${repo}`);
    if (!r) return [];
    return [...r.branches].map(([name, commitSha]) => ({ name, sha: commitSha, protected: false }));
  };

  gh.branchExists = async (owner, repo, branch) => repos.get(`${owner}/${repo}`)?.branches.get(branch) || null;

  gh.tree = async (owner, repo, p = '') => {
    const r = repos.get(`${owner}/${repo}`);
    if (!r) return [];
    const head = r.branches.get(r.meta.default_branch);
    const treeSha = r.commits.get(head)?.tree.sha;
    const items = r.trees.get(treeSha) || new Map();
    return [...items].filter(([path]) => !p || path.startsWith(p.replace(/\/$/, '') + '/')).map(([path, v]) => ({
      name: path.split('/').pop(), path, type: 'file', size: v.size, sha: v.sha,
    }));
  };

  gh.createRepo = async ({ name, private: isPrivate }) => {
    const full = `demo-user/${name}`;
    const blobSha = sha(); const treeSha = sha(); const commitSha = sha();
    const readme = Buffer.from(`# ${name}\n`);
    repos.set(full, {
      meta: { full_name: full, name, owner: 'demo-user', private: isPrivate, default_branch: 'main', html_url: `https://github.com/mock/${full}` },
      blobs: new Map([[blobSha, readme]]),
      trees: new Map([[treeSha, new Map([['README.md', { sha: blobSha, mode: '100644', size: readme.length }]])]]),
      commits: new Map([[commitSha, { sha: commitSha, tree: { sha: treeSha }, parents: [], message: 'init' }]]),
      branches: new Map([['main', commitSha]]),
    });
    return { full_name: full, default_branch: 'main', html_url: `https://github.com/mock/${full}` };
  };

  /* POST blob */
  const origRequest = gh.request.bind(gh);
  gh.request = async (method, urlPath, body) => {
    const clean = String(urlPath).split('?')[0]; // buang query string (?recursive=1, dsb.)
    const m = clean.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if (!m) return origRequest(method, urlPath, body);
    const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
    const r = repos.get(key);
    if (!r) { const e = new Error(`Repo ${key} tidak ada di data mock.`); e.status = 404; throw e; }
    const sub = m[3] || '';

    /* metadata repo & branch (dipakai pushFiles sebagai pre-flight) */
    if (method === 'GET' && sub === '') {
      return { data: { full_name: key, private: !!r.meta.private, default_branch: r.meta.default_branch, size: 1, permissions: { admin: true, push: true, pull: true } }, headers: {}, status: 200 };
    }
    if (method === 'GET' && sub === 'branches') {
      return { data: [...r.branches].map(([name, s]) => ({ name, commit: { sha: s }, protected: false })), headers: {}, status: 200 };
    }
    const brGet = sub.match(/^branches\/(.+)$/);
    if (method === 'GET' && brGet) {
      const name = brGet[1].split('/').map(decodeURIComponent).join('/');
      const s = r.branches.get(name);
      if (!s) { const e = new Error('Branch not found'); e.status = 404; throw e; }
      return { data: { name, commit: { sha: s }, protected: false }, headers: {}, status: 200 };
    }
    if (!sub.startsWith('git/')) return origRequest(method, urlPath, body);
    const gitSub = sub.slice(4);

    if (method === 'POST' && gitSub === 'blobs') {
      const buf = Buffer.from(body.content || '', body.encoding === 'base64' ? 'base64' : 'utf8');
      const s = sha(); r.blobs.set(s, buf);
      return { data: { sha: s }, headers: {}, status: 201 };
    }
    if (method === 'GET' && gitSub.startsWith('commits/')) {
      const c = r.commits.get(gitSub.split('/')[1].split('?')[0]);
      if (!c) { const e = new Error('Not Found'); e.status = 404; throw e; }
      return { data: c, headers: {}, status: 200 };
    }
    if (method === 'GET' && gitSub.startsWith('trees/')) {
      const treeSha = gitSub.split('/')[1].split('?')[0];
      const t = r.trees.get(treeSha);
      if (!t) { const e = new Error('Not Found'); e.status = 404; throw e; }
      return { data: { sha: treeSha, truncated: false, tree: [...t].map(([path, v]) => ({ path, mode: v.mode, type: 'blob', sha: v.sha, size: v.size })) }, headers: {}, status: 200 };
    }
    if (method === 'POST' && gitSub === 'trees') {
      const items = new Map();
      if (body.base_tree) {
        const bt = r.trees.get(body.base_tree);
        if (!bt) { const e = new Error('Git Reference is not a tree'); e.status = 404; throw e; }
        for (const [k, v] of bt) items.set(k, v);
      }
      for (const t of body.tree || []) items.set(t.path, { sha: t.sha, mode: t.mode, size: (r.blobs.get(t.sha) || Buffer.alloc(0)).length });
      const s = sha(); r.trees.set(s, items);
      return { data: { sha: s, truncated: false }, headers: {}, status: 201 };
    }
    if (method === 'POST' && gitSub === 'commits') {
      if (!r.trees.has(body.tree)) { const e = new Error('Git Repository is empty.'); e.status = 422; throw e; }
      for (const p of body.parents || []) if (!r.commits.has(p)) { const e = new Error('Parent commit does not exist'); e.status = 422; throw e; }
      const s = sha();
      r.commits.set(s, { sha: s, message: body.message, tree: { sha: body.tree }, parents: body.parents || [], author: body.author || null });
      return { data: r.commits.get(s), headers: {}, status: 201 };
    }
    if (method === 'POST' && gitSub === 'refs') {
      const name = String(body.ref || '').replace(/^refs\/heads\//, '');
      if (!r.commits.has(body.sha)) { const e = new Error('Reference does not exist'); e.status = 422; throw e; }
      if (r.branches.has(name)) { const e = new Error('Reference already exists'); e.status = 422; throw e; }
      r.branches.set(name, body.sha);
      return { data: { ref: body.ref, object: { sha: body.sha } }, headers: {}, status: 201 };
    }
    const refPatch = gitSub.match(/^refs\/heads\/(.+)$/);
    if (method === 'PATCH' && refPatch) {
      const name = refPatch[1].split('/').map(decodeURIComponent).join('/');
      if (!r.branches.has(name)) { const e = new Error('Not Found'); e.status = 404; throw e; }
      if (!r.commits.has(body.sha)) { const e = new Error('Reference does not exist'); e.status = 422; throw e; }
      r.branches.set(name, body.sha);
      return { data: { ref: `refs/heads/${name}`, object: { sha: body.sha }, forced: !!body.force }, headers: {}, status: 200 };
    }
    return origRequest(method, urlPath, body);
  };

  return gh;
}

module.exports = { GitHub, API, pMap, MAX_API_FILE_BYTES, createMockGitHub };
