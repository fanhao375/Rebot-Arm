// reBot 驾驶舱 · 站点公共导航栏
// [Added by fanhao375 2026-06-30] 训/采/看 等叶子站共用左导航栏。**解锁新站只改这里一处**：
//   把对应项的 {locked:true} 换成 {href:'/xxx.html', key:'xxx'}，三页同时生效。
// 用法：页面里放 <nav class="rail" data-active="train"></nav>，引入本脚本即自动渲染（active 高亮该项）。
// 注：cockpit.html 是特例（rail 含站内视图 toggle），不用本组件，自己维护一份。
(function () {
  'use strict';
  var STATIONS = [
    { label: '玩', sm: true, title: '总览 / 驾驶舱', href: '/cockpit.html', key: 'play' },
    { div: true },
    { label: '装', title: '装配（文档）', locked: true },
    { label: '连', title: '连接', locked: true },
    { label: '▦', title: '玩 · 驾驶舱', href: '/cockpit.html', key: 'console' },
    { label: '采', title: '采数据', href: '/record.html', key: 'record' },
    { label: '看', title: '看数据', href: '/data.html', key: 'data' },
    { label: '训', title: '训练', href: '/train.html', key: 'train' },
    { label: '部', title: '部署（待上线）', locked: true, key: 'deploy' }
  ];

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function railHTML(active) {
    var html = '<div class="logo">rB</div>';
    STATIONS.forEach(function (s) {
      if (s.div) { html += '<div class="div"></div>'; return; }
      var cls = [];
      if (s.sm) cls.push('sm');
      if (s.locked) cls.push('locked');
      if (s.key && s.key === active) cls.push('active');
      var attrs = 'title="' + esc(s.title) + '"';
      if (s.locked || !s.href) {
        html += '<a class="' + cls.join(' ') + '" ' + attrs + '>' + esc(s.label) + '</a>';
      } else {
        html += '<a class="' + cls.join(' ') + '" ' + attrs + ' href="' + esc(s.href) + '">' + esc(s.label) + '</a>';
      }
    });
    return html;
  }

  function render() {
    var rail = document.querySelector('.rail[data-active]');
    if (!rail) return;
    rail.innerHTML = railHTML(rail.getAttribute('data-active'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
  window.renderRail = function (active) {
    var rail = document.querySelector('.rail[data-active]');
    if (rail) { rail.setAttribute('data-active', active); rail.innerHTML = railHTML(active); }
  };
})();
