'use strict';
// Máy chủ nhỏ, không cần cài thư viện nào: chỉ cần Node.js 18 trở lên.
// Chức năng: tài khoản (giáo viên/học sinh), kho dữ liệu dùng chung, tải ảnh bài làm, bảng chung thời gian thực.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const SECURE = process.env.COOKIE_SECURE === '1';           // đặt 1 khi chạy sau HTTPS
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });

// ---- khoá ký phiên đăng nhập (tự tạo một lần, lưu lại để không bị đăng xuất khi khởi động lại)
const secretFile = path.join(DATA, 'secret.txt');
if (!process.env.SESSION_SECRET && !fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
const SECRET = process.env.SESSION_SECRET || fs.readFileSync(secretFile, 'utf8').trim();

// ---- cơ sở dữ liệu dạng tệp JSON (đủ cho một trường học nhỏ)
const dbFile = path.join(DATA, 'db.json');
let DB = { users: {}, docs: {}, files: {} };
try { DB = Object.assign(DB, JSON.parse(fs.readFileSync(dbFile, 'utf8'))); } catch (e) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB));
    fs.renameSync(tmp, dbFile);
  }, 300);
}
process.on('SIGINT', () => { try { fs.writeFileSync(dbFile, JSON.stringify(DB)); } catch (e) {} process.exit(0); });
process.on('SIGTERM', () => { try { fs.writeFileSync(dbFile, JSON.stringify(DB)); } catch (e) {} process.exit(0); });

// ---- tiện ích
const COLORS = ['#4f46e5', '#d6336c', '#16a34a', '#f59e0b', '#0ea5e9', '#8b5cf6'];
const rid = () => crypto.randomBytes(9).toString('base64url');
function send(res, code, obj, headers) { const b = JSON.stringify(obj); res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers)); res.end(b); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
const readJson = async (req, limit = 1.5e6) => { const b = await readBody(req, limit); try { return JSON.parse(b.toString() || '{}'); } catch (e) { throw Object.assign(new Error('bad json'), { status: 400 }); } };
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function makeCookie(uid) { const v = Buffer.from(JSON.stringify({ u: uid, e: Date.now() + 30 * 864e5 })).toString('base64url'); return 'sid=' + v + '.' + sign(v) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' + (SECURE ? '; Secure' : ''); }
function userOf(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  const [v, sg] = m[1].split('.'); if (!v || !sg) return null;
  const a = Buffer.from(sign(v)), b = Buffer.from(sg); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(v, 'base64url').toString()); if (p.e < Date.now()) return null; return DB.users[p.u] || null; } catch (e) { return null; }
}
const pub = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, color: u.color });

// ---- chống dò mật khẩu: tối đa 8 lần sai mỗi phút cho mỗi địa chỉ
const tries = new Map();
function tooMany(ip) { const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 6e4); tries.set(ip, t); return t.length >= 8; }

// ---- phân quyền kho dữ liệu (tương ứng các quy tắc đã dùng trong bản trên claude.ai)
function allowed(u, op, p) {
  const s = p.split('/'), teacher = u.role === 'teacher';
  switch (s[0]) {
    case 'classes': return op === 'read' || op === 'list' || teacher;
    case 'admin': case 'team': return teacher;
    case 'grades': if (s.length === 1) return teacher; return op === 'read' ? (teacher || s[1] === u.id) : teacher;
    case 'subs': if (s.length === 1) return teacher && op === 'list'; return op === 'read' ? (teacher || s[1] === u.id) : s[1] === u.id;
    case 'boards': return true;
    case 'data': return s[1] === 'users' && s[2] === u.id;
    default: return false;
  }
}
const okPath = p => typeof p === 'string' && /^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*$/.test(p) && p.length <= 200;

// ---- bảng chung thời gian thực (SSE)
const clients = new Set(), presence = new Map();
function bcast(ev, data) { const msg = 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'; for (const c of clients) c.res.write(msg); }
const peerList = () => [...presence].map(([id, v]) => ({ id, presence: v.d }));
setInterval(() => { let ch = false; for (const [id, v] of presence) if (Date.now() - v.t > 20000) { presence.delete(id); ch = true; } if (ch) bcast('peers', peerList()); for (const c of clients) c.res.write(': ping\n\n'); }, 10000);

// ---- tệp tĩnh
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, url) {
  let f = decodeURIComponent(url.pathname); if (f === '/') f = '/index.html';
  const full = path.normalize(path.join(PUB, f));
  if (!full.startsWith(PUB) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Không tìm thấy trang'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' }); fs.createReadStream(full).pipe(res);
}

const ALLOWED_UP = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  try {
    // ảnh bài làm đã tải lên
    if (req.method === 'GET' && p.startsWith('/_blob/')) {
      const u = userOf(req); if (!u) { res.writeHead(401); return res.end(); }
      const id = p.slice(7), meta = DB.files[id];
      if (!meta || !/^[A-Za-z0-9_\-]+$/.test(id)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': meta.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return fs.createReadStream(path.join(DATA, 'uploads', id)).pipe(res);
    }
    if (!p.startsWith('/api/')) return serveStatic(req, res, url);

    // chống giả mạo yêu cầu từ trang khác: mọi yêu cầu ghi phải kèm tiêu đề này (trình duyệt không tự thêm được từ trang lạ)
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'fetch') return send(res, 403, { error: 'forbidden' });

    if (p === '/api/me' && req.method === 'GET') {
      const u = userOf(req); if (u) return send(res, 200, pub(u));
      return send(res, 401, { error: 'login', setup: Object.keys(DB.users).length === 0 });
    }
    if (p === '/api/register' && req.method === 'POST') {              // chỉ dùng được để tạo giáo viên đầu tiên
      if (Object.keys(DB.users).length) return send(res, 403, { error: 'Đã có tài khoản. Hãy nhờ giáo viên tạo tài khoản cho bạn.' });
      const b = await readJson(req), username = String(b.username || '').trim().toLowerCase(), pw = String(b.password || '');
      if (!/^[a-z0-9._-]{3,30}$/.test(username) || pw.length < 6) return send(res, 400, { error: 'Tên đăng nhập 3–30 ký tự (chữ không dấu, số), mật khẩu tối thiểu 6 ký tự.' });
      const salt = crypto.randomBytes(16).toString('hex'), u = { id: rid(), username, name: String(b.name || username).slice(0, 60), role: 'teacher', salt, hash: hashPw(pw, salt), color: COLORS[0] };
      DB.users[u.id] = u; save(); return send(res, 200, pub(u), { 'Set-Cookie': makeCookie(u.id) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress; if (tooMany(ip)) return send(res, 429, { error: 'Thử quá nhiều lần. Hãy đợi một phút.' });
      const b = await readJson(req), uname = String(b.username || '').trim().toLowerCase();
      const u = Object.values(DB.users).find(x => x.username === uname);
      const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(String(b.password || ''), u.salt)), Buffer.from(u.hash));
      if (!ok) { tries.get(ip).push(Date.now()); return send(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu.' }); }
      return send(res, 200, pub(u), { 'Set-Cookie': makeCookie(u.id) });
    }
    if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; Max-Age=0' });

    const u = userOf(req); if (!u) return send(res, 401, { error: 'login' });

    // ---- quản lý tài khoản (giáo viên)
    if (p === '/api/users') {
      if (u.role !== 'teacher') return send(res, 403, { error: 'forbidden' });
      if (req.method === 'GET') return send(res, 200, { users: Object.values(DB.users).map(pub) });
      if (req.method === 'POST') {
        const b = await readJson(req), username = String(b.username || '').trim().toLowerCase(), pw = String(b.password || '');
        if (!/^[a-z0-9._-]{3,30}$/.test(username) || pw.length < 6) return send(res, 400, { error: 'Tên đăng nhập 3–30 ký tự không dấu, mật khẩu tối thiểu 6 ký tự.' });
        if (Object.values(DB.users).some(x => x.username === username)) return send(res, 409, { error: 'Tên đăng nhập đã tồn tại.' });
        const salt = crypto.randomBytes(16).toString('hex'), n = Object.keys(DB.users).length;
        const nu = { id: rid(), username, name: String(b.name || username).slice(0, 60), role: b.role === 'teacher' ? 'teacher' : 'student', salt, hash: hashPw(pw, salt), color: COLORS[n % COLORS.length] };
        DB.users[nu.id] = nu; save(); return send(res, 200, pub(nu));
      }
    }
    let m = /^\/api\/users\/([\w-]+)$/.exec(p);
    if (m) {
      if (u.role !== 'teacher') return send(res, 403, { error: 'forbidden' });
      const t = DB.users[m[1]]; if (!t) return send(res, 404, { error: 'not found' });
      if (req.method === 'DELETE') { if (t.id === u.id) return send(res, 400, { error: 'Không thể xoá chính mình.' }); delete DB.users[t.id]; save(); return send(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        const b = await readJson(req);
        if (b.name) t.name = String(b.name).slice(0, 60);
        if (b.role === 'teacher' || b.role === 'student') { if (t.id === u.id && b.role !== 'teacher') return send(res, 400, { error: 'Không thể tự hạ quyền.' }); t.role = b.role; }
        if (b.password) { if (String(b.password).length < 6) return send(res, 400, { error: 'Mật khẩu tối thiểu 6 ký tự.' }); t.salt = crypto.randomBytes(16).toString('hex'); t.hash = hashPw(String(b.password), t.salt); }
        save(); return send(res, 200, pub(t));
      }
    }
    if (p === '/api/profiles' && req.method === 'GET') {
      const out = {}; (url.searchParams.get('ids') || '').split(',').slice(0, 300).forEach(id => { const x = DB.users[id]; if (x) out[id] = { name: x.name }; });
      return send(res, 200, out);
    }

    // ---- kho dữ liệu
    if (p === '/api/doc') {
      const dp = url.searchParams.get('path'); if (!okPath(dp)) return send(res, 400, { error: 'bad path' });
      if (req.method === 'GET') { if (!allowed(u, 'read', dp)) return send(res, 403, { error: 'forbidden' }); return DB.docs[dp] === undefined ? send(res, 404, { error: 'not found' }) : send(res, 200, { data: DB.docs[dp] }); }
      if (req.method === 'PUT') { if (!allowed(u, 'write', dp)) return send(res, 403, { error: 'forbidden' }); const b = await readJson(req); if (b.data === null || typeof b.data !== 'object') return send(res, 400, { error: 'bad data' }); DB.docs[dp] = b.data; save(); return send(res, 200, { ok: true }); }
      if (req.method === 'DELETE') { if (!allowed(u, 'write', dp)) return send(res, 403, { error: 'forbidden' }); delete DB.docs[dp]; save(); return send(res, 200, { ok: true }); }
    }
    if (p === '/api/col' && req.method === 'GET') {
      const cp = url.searchParams.get('path'); if (!okPath(cp) || cp.includes('/')) return send(res, 400, { error: 'bad path' });
      if (!allowed(u, 'list', cp)) return send(res, 403, { error: 'forbidden' });
      const docs = Object.keys(DB.docs).filter(k => k.startsWith(cp + '/') && !k.slice(cp.length + 1).includes('/')).map(k => ({ id: k.slice(cp.length + 1), data: DB.docs[k] }));
      return send(res, 200, { docs });
    }

    // ---- tải ảnh bài làm
    if (p === '/api/upload' && req.method === 'PUT') {
      const type = String(req.headers['content-type'] || '').split(';')[0];
      if (!ALLOWED_UP.test(type)) return send(res, 415, { error: 'Chỉ nhận ảnh (png, jpg, gif, webp) hoặc pdf.' });
      const buf = await readBody(req, 15e6), id = rid();
      fs.writeFileSync(path.join(DATA, 'uploads', id), buf); DB.files[id] = { type, by: u.id, name: String(url.searchParams.get('name') || '').slice(0, 100), t: Date.now() }; save();
      return send(res, 200, { id, url: '/_blob/' + id });
    }

    // ---- bảng chung
    if (p === '/api/room/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const c = { res, id: u.id }; clients.add(c); res.write('event: peers\ndata: ' + JSON.stringify(peerList()) + '\n\n');
      req.on('close', () => clients.delete(c)); return;
    }
    if (p === '/api/room/emit' && req.method === 'POST') { const b = await readJson(req, 3e6); if (b.topic !== 'board') return send(res, 400, { error: 'topic' }); bcast('msg', { topic: b.topic, data: b.data, from: u.id }); return send(res, 200, { ok: true }); }
    if (p === '/api/room/presence' && req.method === 'POST') { const b = await readJson(req, 4e3); presence.set(u.id, { d: Object.assign({}, b.data, { n: u.name, c: u.color }), t: Date.now() }); bcast('peers', peerList()); return send(res, 200, { ok: true }); }

    return send(res, 404, { error: 'not found' });
  } catch (e) { send(res, e.status || 500, { error: e.status ? e.message : 'server error' }); }
});
server.listen(PORT, () => console.log('Soạn đề thi Toán đang chạy tại http://localhost:' + PORT));
