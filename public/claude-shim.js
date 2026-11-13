/* Lớp tương thích: giúp ứng dụng chạy trên website riêng.
   - Không có máy chủ (chỉ đưa thư mục public lên hosting tĩnh): ứng dụng chạy độc lập, dữ liệu lưu trong trình duyệt,
     tải file xuống bằng trình duyệt; các tính năng cần tài khoản (lớp học, nộp bài, bảng chung...) tự ẩn.
   - Có máy chủ (node server.js): thêm đăng nhập, kho dữ liệu dùng chung, tải ảnh, bảng chung. */
(function () {
  var H = { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' };
  function j(u, o) {
    o = o || {}; o.credentials = 'same-origin'; o.headers = Object.assign({}, H, o.headers);
    return fetch(u, o).then(function (r) {
      if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return r.json();
    });
  }
  var ME = null, SERVER = false, meP = null;
  function me() {
    return meP || (meP = fetch('/api/me', { credentials: 'same-origin' }).then(function (r) {
      var ct = r.headers.get('content-type') || ''; SERVER = /json/.test(ct);
      return r.ok ? r.json() : (SERVER ? r.json().then(function (b) { SERVER = true; window.__setup = !!b.setup; return null; }) : null);
    }).catch(function () { SERVER = false; return null; }).then(function (u) { ME = u; return u; }));
  }
  function doc(p) {
    var q = '/api/doc?path=' + encodeURIComponent(p);
    return {
      get: function () { return j(q).then(function (r) { return { exists: true, data: function () { return r.data; } }; }, function (e) { if (e.status === 404) return { exists: false, data: function () { return undefined; } }; throw e; }); },
      set: function (d) { return j(q, { method: 'PUT', body: JSON.stringify({ data: d }) }).then(function () { }); },
      delete: function () { return j(q, { method: 'DELETE' }).then(function () { }); }
    };
  }
  function col(p) {
    function get() { return j('/api/col?path=' + encodeURIComponent(p)).then(function (r) { return { docs: r.docs.map(function (d) { return { id: d.id, data: function () { return d.data; } }; }) }; }); }
    return {
      get: get,
      onSnapshot: function (cb) {
        var last = '', off = false;
        function tick() { if (off || document.hidden) return; get().then(function (s) { var k = JSON.stringify(s.docs.map(function (d) { return [d.id, d.data()]; })); if (k !== last) { last = k; cb(s); } }).catch(function () { }); }
        tick(); var t = setInterval(tick, 5000); return function () { off = true; clearInterval(t); };
      }
    };
  }
  var es = null, subs = {}, peerSubs = [], peers = [];
  function openRoom() {
    if (es) return; es = new EventSource('/api/room/stream');
    es.addEventListener('msg', function (e) { var m = JSON.parse(e.data); (subs[m.topic] || []).forEach(function (f) { f({ data: m.data, from: m.from, isMe: ME && m.from === ME.id }); }); });
    es.addEventListener('peers', function (e) { peers = JSON.parse(e.data).map(function (p) { return { id: p.id, isMe: ME && p.id === ME.id, presence: p.presence }; }); peerSubs.forEach(function (f) { f(peers); }); });
  }
  var caps = {
    downloads: function () {
      return Promise.resolve({
        save: function (o) {
          var b = o.data instanceof Blob ? o.data : new Blob([o.data]), a = document.createElement('a');
          a.href = URL.createObjectURL(b); a.download = o.filename; document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return Promise.resolve({ status: 'saved' });
        }
      });
    },
    db: function () { return me().then(function (u) { return u ? { doc: doc, collection: col } : null; }); },
    user: function () {
      return me().then(function (u) {
        if (!u) return null;
        return {
          id: function () { return Promise.resolve(u.id); },
          canEdit: function () { return Promise.resolve(u.role === 'teacher'); },
          me: function () { return Promise.resolve({ name: u.name, color: u.color }); },
          profiles: function (ids) { return j('/api/profiles?ids=' + encodeURIComponent((ids || []).join(','))); }
        };
      });
    },
    assets: function () {
      return me().then(function (u) {
        if (!u) return null;
        return {
          upload: function (f) {
            return fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'PUT', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', 'Content-Type': f.type || 'application/octet-stream' }, body: f })
              .then(function (r) { if (!r.ok) throw new Error('upload'); return r.json(); });
          }
        };
      });
    },
    room: function () {
      return me().then(function (u) {
        if (!u) return null; openRoom();
        return {
          on: function (t, f) { (subs[t] = subs[t] || []).push(f); return function () { subs[t] = subs[t].filter(function (x) { return x !== f; }); }; },
          emit: function (t, d) { return j('/api/room/emit', { method: 'POST', body: JSON.stringify({ topic: t, data: d }) }); },
          presence: function (d) { return j('/api/room/presence', { method: 'POST', body: JSON.stringify({ data: d }) }); },
          onPeers: function (f) { peerSubs.push(f); f(peers); return function () { var i = peerSubs.indexOf(f); if (i >= 0) peerSubs.splice(i, 1); }; }
        };
      });
    }
  };
  window.claude = { use: function (n) { return caps[n] ? caps[n]() : Promise.resolve(null); } };

  // ---- khung đăng nhập nhỏ ở góc dưới bên trái (chỉ hiện khi có máy chủ)
  function ui() {
    me().then(function (u) {
      if (!SERVER) return;
      var box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:60;font:13px system-ui,sans-serif;background:#1e2029;color:#fff;border-radius:10px;padding:6px 10px;box-shadow:0 2px 10px #0004;display:flex;gap:8px;align-items:center';
      if (u) {
        box.innerHTML = '<span>👤 ' + esc(u.name) + ' · ' + (u.role === 'teacher' ? 'Giáo viên' : 'Học sinh') + '</span>' + (u.role === 'teacher' ? '<a href="/admin.html" style="color:#9fb0ff">Tài khoản</a>' : '') + '<button id="lgo" style="background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:3px 8px;cursor:pointer">Đăng xuất</button>';
        document.body.appendChild(box);
        document.getElementById('lgo').onclick = function () { j('/api/logout', { method: 'POST', body: '{}' }).then(function () { location.reload(); }); };
      } else {
        box.innerHTML = '<button id="lgi" style="background:#4f46e5;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer">🔑 Đăng nhập</button>';
        document.body.appendChild(box); document.getElementById('lgi').onclick = loginForm;
        if (window.__setup) loginForm();
      }
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function loginForm() {
    var setup = !!window.__setup, w = document.createElement('div');
    w.style.cssText = 'position:fixed;inset:0;background:#0007;z-index:70;display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif';
    w.innerHTML = '<form style="background:#fff;color:#111;padding:20px;border-radius:12px;width:min(340px,92vw);display:grid;gap:10px"><b style="font-size:16px">' + (setup ? 'Tạo tài khoản giáo viên đầu tiên' : 'Đăng nhập') + '</b>' + (setup ? '<input name="name" placeholder="Họ và tên" style="padding:8px">' : '') + '<input name="username" placeholder="Tên đăng nhập" autocomplete="username" style="padding:8px"><input name="password" type="password" placeholder="Mật khẩu (tối thiểu 6 ký tự)" autocomplete="' + (setup ? 'new-password' : 'current-password') + '" style="padding:8px"><div id="lge" style="color:#c0392b;min-height:18px"></div><div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" id="lgc" style="padding:7px 12px">Đóng</button><button style="padding:7px 12px;background:#4f46e5;color:#fff;border:0;border-radius:6px">' + (setup ? 'Tạo tài khoản' : 'Đăng nhập') + '</button></div></form>';
    document.body.appendChild(w);
    w.querySelector('#lgc').onclick = function () { w.remove(); };
    w.querySelector('form').onsubmit = function (e) {
      e.preventDefault(); var f = e.target, body = { username: f.username.value, password: f.password.value, name: f.name ? f.name.value : '' };
      j(setup ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(body) }).then(function () { location.reload(); }, function (err) {
        fetch(setup ? '/api/register' : '/api/login', { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify(body) }).then(function (r) { return r.json(); }).then(function (b) { w.querySelector('#lge').textContent = b.error || 'Không đăng nhập được.'; });
      });
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ui); else ui();
})();
