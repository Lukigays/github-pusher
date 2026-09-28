/**
 * test/mock-github.js
 * ------------------------------------------------------------------
 * Server tiruan GitHub REST API (Git Data API) untuk menguji alur push
 * tanpa token asli. Hanya untuk development/testing.
 *
 *   node test/mock-github.js 8080
 *
 * Lalu di app: GITHUB_API_URL=http://127.0.0.1:8080 GITHUB_TOKEN=ghp_mock...
 * ------------------------------------------------------------------
 */
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.argv[2] || 8080);
const sha = () => crypto.randomBytes(20).toString('hex');

/* ---------- state awal ---------- */
function newRepo(defaultBranch = 'main', initialFiles = { 'README.md': Buffer.from('# Demo\n') }) {
  const repo = { default_branch: defaultBranch, private: false, blobs: {}, trees: {}, commits: {}, branches: {} };
  const treeSha = sha();
  repo.trees[treeSha] = {};
  for (const [p, buf] of Object.entries(initialFiles)) {
    const bSha = sha();
    repo.blobs[bSha] = buf;
    repo.trees[treeSha][p] = { sha: bSha, mode: '100644', size: buf.length };
  }
  const cSha = sha();
  repo.commits[cSha] = { sha: cSha, message: 'Initial commit', tree: { sha: treeSha }, parents: [] };
  repo.branches[defaultBranch] = cSha;
  return repo;
}

const repos = { 'octo/demo-repo': newRepo() };
const callLog = [];

function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'X-OAuth-Scopes': 'repo, read:org',
    'X-RateLimit-Remaining': '4999',
    ...headers,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://mock');
    const p = u.pathname.replace(/\/+$/, '');
    const m = req.method;
    const body = raw ? JSON.parse(raw) : {};
    callLog.push(`${m} ${p}`);

    if (!/^Bearer .+/.test(req.headers.authorization || '')) return send(res, 401, { message: 'Bad credentials' });

    /* ---- user ---- */
    if (m === 'GET' && p === '/user') {
      return send(res, 200, {
        login: 'octo', name: 'Octo Mock', avatar_url: null,
        email: 'octo@example.com', html_url: 'https://github.com/octo', plan: { name: 'free' },
      });
    }
    if (m === 'GET' && p === '/user/repos') {
      return send(res, 200, Object.entries(repos).map(([full, r]) => ({
        full_name: full, name: full.split('/')[1], owner: { login: full.split('/')[0] },
        private: r.private, default_branch: r.default_branch, pushed_at: new Date().toISOString(),
        permissions: { admin: true, push: true, pull: true }, html_url: 'https://github.com/' + full,
      })));
    }
    if (m === 'GET' && p === '/user/orgs') return send(res, 200, []);
    if (m === 'POST' && p === '/user/repos') {
      const full = `octo/${body.name}`;
      repos[full] = newRepo('main', body.auto_init === false ? {} : { 'README.md': Buffer.from('# ' + body.name + '\n') });
      return send(res, 201, { full_name: full, default_branch: 'main', html_url: 'https://github.com/' + full });
    }

    /* ---- repo scope ---- */
    const rm = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!rm) return send(res, 404, { message: 'Mock: ' + m + ' ' + p + ' belum ditiru' });
    const full = `${decodeURIComponent(rm[1])}/${decodeURIComponent(rm[2])}`;
    const rest = rm[3] || '';
    const repo = repos[full];
    if (!repo) return send(res, 404, { message: 'Not Found' });

    if (m === 'GET' && rest === '') return send(res, 200, {
      full_name: full, private: repo.private, default_branch: repo.default_branch, size: 42,
      permissions: { admin: true, push: true, pull: true }, html_url: 'https://github.com/' + full,
    });

    if (m === 'GET' && rest === '/branches') {
      return send(res, 200, Object.entries(repo.branches).map(([name, cSha]) => ({
        name, commit: { sha: cSha }, protected: false,
      })));
    }
    const brGet = rest.match(/^\/branches\/(.+)$/);
    if (m === 'GET' && brGet) {
      const name = decodeURIComponent(brGet[1]);
      const cSha = repo.branches[name];
      return cSha ? send(res, 200, { name, commit: { sha: cSha }, protected: false })
                  : send(res, 404, { message: 'Branch not found' });
    }

    if (m === 'POST' && rest === '/git/blobs') {
      const buf = Buffer.from(body.content || '', body.encoding === 'base64' ? 'base64' : 'utf8');
      const bSha = sha();
      repo.blobs[bSha] = buf;
      return send(res, 201, { sha: bSha, url: `mock/blobs/${bSha}` });
    }

    const treeGet = rest.match(/^\/git\/trees\/([0-9a-f]+)$/);
    if (m === 'GET' && treeGet) {
      const t = repo.trees[treeGet[1]];
      if (!t) return send(res, 404, { message: 'Not Found' });
      return send(res, 200, {
        sha: treeGet[1], truncated: false,
        tree: Object.entries(t).map(([path, v]) => ({ path, mode: v.mode, type: 'blob', sha: v.sha, size: v.size })),
      });
    }

    if (m === 'POST' && rest === '/git/trees') {
      const items = {};
      if (body.base_tree) {
        if (!repo.trees[body.base_tree]) return send(res, 404, { message: 'Git Reference is not a tree' });
        Object.assign(items, repo.trees[body.base_tree]);
      }
      for (const t of body.tree || []) {
        if (!repo.blobs[t.sha] && !body.base_tree) return send(res, 422, { message: 'Git Repository is empty.' });
        items[t.path] = { sha: t.sha, mode: t.mode, size: (repo.blobs[t.sha] || Buffer.alloc(0)).length };
      }
      const tSha = sha();
      repo.trees[tSha] = items;
      return send(res, 201, { sha: tSha, truncated: false, tree: body.tree });
    }

    const commitGet = rest.match(/^\/git\/commits\/([0-9a-f]+)$/);
    if (m === 'GET' && commitGet) {
      const c = repo.commits[commitGet[1]];
      return c ? send(res, 200, c) : send(res, 404, { message: 'Not Found' });
    }
    if (m === 'POST' && rest === '/git/commits') {
      if (!repo.trees[body.tree]) return send(res, 422, { message: 'Git Repository is empty.' });
      for (const par of body.parents || []) if (!repo.commits[par]) return send(res, 422, { message: 'Parent commit does not exist' });
      const cSha = sha();
      repo.commits[cSha] = {
        sha: cSha, message: body.message, tree: { sha: body.tree },
        parents: body.parents || [], author: body.author || null,
      };
      return send(res, 201, repo.commits[cSha]);
    }

    if (m === 'POST' && rest === '/git/refs') {
      const name = String(body.ref || '').replace(/^refs\/heads\//, '');
      if (!repo.commits[body.sha]) return send(res, 422, { message: 'Reference does not exist' });
      if (repo.branches[name]) return send(res, 422, { message: 'Reference already exists' });
      repo.branches[name] = body.sha;
      return send(res, 201, { ref: body.ref, object: { sha: body.sha, type: 'commit' } });
    }
    const refPatch = rest.match(/^\/git\/refs\/heads\/(.+)$/);
    if (m === 'PATCH' && refPatch) {
      const name = decodeURIComponent(refPatch[1]);
      if (!repo.branches[name]) return send(res, 404, { message: 'Not Found' });
      if (!repo.commits[body.sha]) return send(res, 422, { message: 'Reference does not exist' });
      repo.branches[name] = body.sha;
      return send(res, 200, { ref: `refs/heads/${name}`, object: { sha: body.sha, type: 'commit' }, forced: !!body.force });
    }

    if (m === 'GET' && rest.startsWith('/contents')) return send(res, 200, []);

    return send(res, 404, { message: 'Mock: ' + m + ' ' + p + ' belum ditiru' });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-github] mendengarkan http://127.0.0.1:${PORT}`);
  console.log(`[mock-github] repo tersedia: ${Object.keys(repos).join(', ')}`);
});

if (process.env.MOCK_DUMP_ON_EXIT !== '0') {
  process.on('SIGINT', () => {
    console.log('\n[mock-github] ringkasan panggilan:');
    console.log(callLog.join('\n'));
    process.exit(0);
  });
}

module.exports = { repos, callLog };
