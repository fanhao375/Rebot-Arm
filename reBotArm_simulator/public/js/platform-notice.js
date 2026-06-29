// reBot Arm Web 控制台 · 平台提示条（自研，2026-06-29 fanhao375）
// 探测本网页服务宿主平台，提示真机控制的实时性限制。
// WSL 下 USB 经 usbipd 透传 ≈ 2Hz —— 本项目当初因此上的双系统，必须提醒用户。
// 纯前端 + /api/platform，不依赖 ROS2；作为 CERN-OHL-W 下可分离的新增组件。
(function () {
  'use strict';

  var CFG = {
    wsl:     { cls: 'bad',  icon: '⚠️', text: '本服务跑在 <b>WSL</b>：USB 经 usbipd 透传，真机<b>实时遥操约 2Hz</b>（仅够点动 / 调试）。要全速实时遥操，请把 ROS2 跑在<b>原生 Linux</b>。仿真模式不受影响。' },
    windows: { cls: 'info', icon: 'ℹ️', text: '本服务跑在 <b>Windows 原生</b>：仿真全速。真机走 COM 口（实时遥操未实测）。' },
    linux:   { cls: 'ok',   icon: '✅', text: '本服务跑在 <b>原生 Linux</b>：真机可全速 60Hz+，实时遥操 / 重力补偿无瓶颈。' },
    mac:     { cls: 'info', icon: 'ℹ️', text: '本服务跑在 <b>macOS</b>：可做仿真；真机驱动需在 Linux / Windows。' }
  };
  var COLORS = { // 跟随上游深色主题
    bad:  { bg: '#3a1e1e', bd: '#6b2f2f', fg: '#ffb4b4' },
    info: { bg: '#1e2a3a', bd: '#2f4f6b', fg: '#a8cdff' },
    ok:   { bg: '#1e3a2f', bd: '#2f6b4f', fg: '#6ee7a8' }
  };

  fetch('/api/platform')
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function () { /* 探测失败就不显示，不打扰 */ });

  function render(info) {
    var host = (info && info.host) || 'unknown';
    var cfg = CFG[host] || { cls: 'info', icon: 'ℹ️', text: '平台未知，真机实时性请自行确认。' };
    var col = COLORS[cfg.cls];

    var mount = document.querySelector('.control-panel');
    if (!mount) return;

    var box = document.createElement('div');
    box.className = 'platform-notice platform-' + cfg.cls;
    box.style.cssText = [
      'margin:0 0 14px', 'padding:10px 12px', 'border-radius:8px', 'font-size:12px',
      'line-height:1.6', 'background:' + col.bg, 'border:1px solid ' + col.bd, 'color:' + col.fg
    ].join(';');
    box.innerHTML =
      '<div style="font-weight:600">' + cfg.icon + ' 平台：' + ((info && info.label) || host) + '</div>' +
      '<div style="margin-top:3px">' + cfg.text + '</div>' +
      '<div style="margin-top:5px;opacity:.75;font-size:11px">注：真机实时性取决于跑 ROS2 / 接 USB 的那台机，不一定是本机。</div>';

    // 插到控制台最顶部（标题之后）
    var title = mount.querySelector('.panel-title');
    if (title && title.nextSibling) mount.insertBefore(box, title.nextSibling);
    else mount.insertBefore(box, mount.firstChild);
  }
})();
