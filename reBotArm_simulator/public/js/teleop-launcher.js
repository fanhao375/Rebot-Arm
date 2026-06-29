// reBot Arm Web 控制台 · 一键遥操启动器（自研，2026-06-29 fanhao375）
// 让网页直接启停 LeRobot 物理遥操(102 主动臂 → 601 跟随)，端口可在下拉里选。
// 把后端终端步骤搬到前端：选串口 → 点一下 → server 起 start_teleop.sh。
// 仅在装了 lerobot 环境的机器上能真正跑；与 ROS2 控制互斥(抢同一串口)。
// 纯前端 + /api/teleop/*，CERN-OHL-W 下可分离的新增组件。
(function () {
  'use strict';

  var btn = document.getElementById('teleop-toggle');
  var refreshBtn = document.getElementById('teleop-refresh-ports');
  var leaderSel = document.getElementById('teleop-leader');
  var followerSel = document.getElementById('teleop-follower');
  var pill = document.getElementById('teleop-pill');
  var msg = document.getElementById('teleop-message');
  var logEl = document.getElementById('teleop-log');
  if (!btn) return;

  var running = false;

  btn.addEventListener('click', function () {
    if (!running) {
      var leader = leaderSel ? leaderSel.value : '';
      var follower = followerSel ? followerSel.value : '';
      if (leader && follower && leader === follower) {
        if (!window.confirm('主动臂和跟随臂选了同一个端口(' + leader + ')，多半是错的，确定继续？')) return;
      }
      if (!window.confirm(
        '确认启动真机遥操？\n主动臂(102)=' + (leader || '默认') + '\n跟随臂(601)=' + (follower || '默认') +
        '\n\n102 一动，601 会跟随。请人站旁边，手放急停 / 断电旁。')) return;
      var qs = [];
      if (leader) qs.push('leader=' + encodeURIComponent(leader));
      if (follower) qs.push('follower=' + encodeURIComponent(follower));
      api('/api/teleop/start' + (qs.length ? '?' + qs.join('&') : ''));
    } else {
      api('/api/teleop/stop');
    }
  });

  if (refreshBtn) refreshBtn.addEventListener('click', loadPorts);

  function api(url) {
    // POST：配合 server 端 CSRF 防护（仅本机 + POST + 同源）
    fetch(url, { method: 'POST' }).then(function (r) { return r.json(); }).then(function (res) {
      if (res && res.message && msg) msg.textContent = res.message;
      if (res && res.status) applyStatus(res.status);
    }).catch(function (e) { if (msg) msg.textContent = '请求失败：' + e; });
  }

  function loadPorts() {
    fetch('/api/teleop/ports').then(function (r) { return r.json(); }).then(function (res) {
      var ports = (res && res.ports) || [];
      fillSelect(leaderSel, ports, ['ttyUSB', 'USB']);     // 102 多半是 CH340/USB 串口
      fillSelect(followerSel, ports, ['ttyACM', 'ACM']);   // 601 达妙桥多半是 ACM
      if (!ports.length && msg) {
        msg.textContent = '没扫到串口（host=' + ((res && res.host) || '?') + '）。插上两臂再点「刷新端口」；WSL 下需先 usbipd 绑定。';
      }
    }).catch(function () {});
  }

  function fillSelect(sel, ports, preferHints) {
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '';
    if (!ports.length) {
      var o = document.createElement('option');
      o.value = ''; o.textContent = '(未扫到，用脚本默认)';
      sel.appendChild(o);
      return;
    }
    ports.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p; o.textContent = p;
      sel.appendChild(o);
    });
    // 优先选名字像该臂的端口；否则保留上次选择
    var pick = ports.indexOf(prev) >= 0 ? prev : '';
    if (!pick) {
      for (var i = 0; i < ports.length; i++) {
        if (preferHints.some(function (h) { return ports[i].indexOf(h) >= 0; })) { pick = ports[i]; break; }
      }
    }
    if (pick) sel.value = pick;
  }

  function poll() {
    fetch('/api/teleop/status').then(function (r) { return r.json(); }).then(applyStatus).catch(function () {});
  }

  function applyStatus(s) {
    if (!s) return;
    running = !!s.running;
    if (pill) {
      pill.textContent = running ? '运行中' : '未运行';
      pill.className = 'mini-pill ' + (running ? 'error' : '');
    }
    if (btn) btn.textContent = running ? '⏹ 停止遥操' : '🕹 一键遥操';
    if (leaderSel) leaderSel.disabled = running;
    if (followerSel) followerSel.disabled = running;
    renderLog(s.log);
  }

  function renderLog(lines) {
    if (!logEl || !Array.isArray(lines)) return;
    logEl.innerHTML = '';
    lines.slice(-30).forEach(function (line) {
      var d = document.createElement('div');
      d.className = 'ros-log-line info';
      d.textContent = line;
      logEl.appendChild(d);
    });
    logEl.scrollTop = logEl.scrollHeight;
  }

  loadPorts();
  poll();
  window.setInterval(poll, 1500);
})();
