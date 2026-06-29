const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process'); // [Added by fanhao375 2026-06-29] 一键遥操起子进程 + 列串口

const USE_HTTPS = process.env.HTTPS === '1';
const PORT = Number(process.env.PORT || (USE_HTTPS ? 3443 : 3001));
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// [Modified by fanhao375 2026-06-29] 模型目录优先指向主仓维护的 controller submodule
// (software/reBotArmController_ROS2)，作单一数据源；不存在时回退到本仓自带旧副本，保证可独立运行。
// 可用环境变量 BRINGUP_DIR 显式覆盖。
const OUR_BRINGUP = path.resolve(ROOT, '..', '..', 'software', 'reBotArmController_ROS2', 'src', 'rebotarm_bringup');
const VENDORED_BRINGUP = path.resolve(ROOT, '..', 'reBotArmController_ROS2-main', 'src', 'rebotarm_bringup');
const BRINGUP_DIR = process.env.BRINGUP_DIR
  ? path.resolve(process.env.BRINGUP_DIR)
  : (fs.existsSync(OUR_BRINGUP) ? OUR_BRINGUP : VENDORED_BRINGUP);
const URDF_FILE = path.join(BRINGUP_DIR, 'description', 'urdf', 'reBot-DevArm_fixend.urdf');
const MESHES_DIR = path.join(BRINGUP_DIR, 'description', 'meshes');
const GRIPPER_MESHES_DIR = path.join(ROOT, 'split_meshes', 'grouped_gripper');
const DEFAULT_KEY_FILE = path.join(ROOT, '.certs', 'rebotarm-local-server.key');
const DEFAULT_CERT_FILE = path.join(ROOT, '.certs', 'rebotarm-local-server.crt');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.stl': 'model/stl',
  '.STL': 'model/stl',
  '.urdf': 'application/xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body, null, 2), MIME_TYPES['.json']);
}

function sendFile(res, filePath) {
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      sendJson(res, 404, { error: 'File not found' });
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext.toLowerCase() === '.stl' ? 'public, max-age=3600' : 'no-store'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function safePublicPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
  const relative = cleanPath === '/' ? 'index.html' : cleanPath.replace(/^\/+/, '');
  const filePath = path.resolve(path.join(PUBLIC_DIR, relative));
  if (!filePath.startsWith(PUBLIC_DIR)) return null;
  return filePath;
}

function sendMesh(res, filename) {
  const safeName = path.basename(filename);
  sendFile(res, path.join(MESHES_DIR, safeName));
}

function sendGripperMesh(res, filename) {
  const safeName = path.basename(filename);
  sendFile(res, path.join(GRIPPER_MESHES_DIR, safeName));
}

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

// [Added by fanhao375 2026-06-29] 一键遥操：server 启停 LeRobot 物理遥操(102 主动→601 跟随)
// 仅原生 Linux 有效(需 102/601 串口 + lerobot conda 环境)；与 ROS2 控制互斥(抢 /dev/ttyACM0)。
const TELEOP_SCRIPT = process.env.TELEOP_SCRIPT
  || path.resolve(ROOT, '..', '..', 'tools', 'lerobot_native_linux', 'start_teleop.sh');
let teleopProc = null;
let teleopLog = [];
function pushTeleopLog(chunk) {
  String(chunk).split(/\r?\n/).forEach((line) => { if (line.trim()) teleopLog.push(line); });
  if (teleopLog.length > 60) teleopLog = teleopLog.slice(-60);
}
function teleopStatus() {
  return { running: !!teleopProc, host: os.platform(), script: TELEOP_SCRIPT, log: teleopLog.slice(-30) };
}
function listPorts() {
  const plat = os.platform();
  try {
    if (plat === 'win32') {
      const out = execSync('reg query HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM', { encoding: 'utf8', timeout: 3000 });
      return Array.from(new Set(out.match(/COM\d+/g) || []));
    }
    const re = plat === 'darwin' ? /^(tty|cu)\./ : /^(ttyUSB|ttyACM)\d+$/;
    return fs.readdirSync('/dev').filter((d) => re.test(d)).map((d) => '/dev/' + d).sort();
  } catch (e) {
    return [];
  }
}

function startTeleop(opts) {
  if (teleopProc) return { ok: false, message: '遥操作已在运行' };
  if (!fs.existsSync(TELEOP_SCRIPT)) return { ok: false, message: '找不到 start_teleop.sh：' + TELEOP_SCRIPT };
  const leader = opts && opts.leader ? String(opts.leader) : '';
  const follower = opts && opts.follower ? String(opts.follower) : '';
  teleopLog = [];
  pushTeleopLog('>>> 启动遥操作' + (leader ? ' 主动臂=' + leader : '') + (follower ? ' 跟随臂=' + follower : '') + '：动 102 主动臂，601 跟随。人站旁边，手放急停/断电旁。');
  const env = Object.assign({}, process.env);
  if (leader) env.LEADER_PORT = leader;
  if (follower) env.FOLLOWER_PORT = follower;
  try {
    teleopProc = spawn('bash', [TELEOP_SCRIPT], { cwd: path.dirname(TELEOP_SCRIPT), env });
  } catch (e) {
    teleopProc = null;
    return { ok: false, message: '启动失败（本机可能无 bash / lerobot 环境）：' + e.message };
  }
  teleopProc.stdout.on('data', pushTeleopLog);
  teleopProc.stderr.on('data', pushTeleopLog);
  teleopProc.on('exit', (code) => { pushTeleopLog('[遥操作进程退出 code=' + code + ']'); teleopProc = null; });
  teleopProc.on('error', (err) => { pushTeleopLog('[进程错误] ' + err.message); teleopProc = null; });
  return { ok: true, message: '遥操作已启动' };
}
function stopTeleop() {
  if (!teleopProc) return { ok: false, message: '遥操作未在运行' };
  teleopProc.kill('SIGINT'); // lerobot-teleoperate 靠 Ctrl+C(SIGINT) 优雅停止
  pushTeleopLog('>>> 已发送停止信号 (SIGINT)');
  return { ok: true, message: '已请求停止遥操作' };
}

// [Added by fanhao375 2026-06-29] 遥操作控制端点安全闸：仅本机 + POST + 同源
// 防止 LAN 设备或同机恶意网页(CSRF)用一个 GET/跨源请求远程启动真机运动。
function isLoopback(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 无 Origin（同源直访/非浏览器）放行
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}
function teleopGuard(req, res) {
  if (!isLoopback(req)) { sendJson(res, 403, { ok: false, message: '遥操作仅允许本机(127.0.0.1)控制' }); return false; }
  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, message: '遥操作控制需用 POST' }); return false; }
  if (!isSameOrigin(req)) { sendJson(res, 403, { ok: false, message: '跨源请求被拒（CSRF 防护）' }); return false; }
  return true;
}

function requestHandler(req, res) {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/api/config') {
    sendJson(res, 200, {
      name: 'reBot Arm B601-DM',
      frame: {
        rosX: 'forward',
        rosY: 'left',
        rosZ: 'up',
        threeMapping: { x: 'ros_x', y: 'ros_z', z: '-ros_y' }
      },
      reachMeters: 0.65,
      payloadKg: 1.5,
      gripper: {
        name: 'gripper',
        motorId: '0x07',
        closedMeters: 0,
        openMeters: 0.09,
        visualOpenMeters: 0.057,
        rosService: '/rebotarm/gripper/set'
      }
    });
    return;
  }

  // [Added by fanhao375 2026-06-29] 平台探测：供前端判断本服务宿主是否 WSL（usbipd 透传约 2Hz）
  if (urlPath === '/api/platform') {
    sendJson(res, 200, detectHost());
    return;
  }

  // [Added by fanhao375 2026-06-29] 一键遥操：列串口 / 状态 / 启动（带端口）/ 停止
  if (urlPath === '/api/teleop/ports') {
    sendJson(res, 200, { host: os.platform(), ports: listPorts() });
    return;
  }
  if (urlPath === '/api/teleop/status') {
    sendJson(res, 200, teleopStatus());
    return;
  }
  if (urlPath === '/api/teleop/start') {
    if (!teleopGuard(req, res)) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const r = startTeleop({ leader: q.get('leader'), follower: q.get('follower') });
    sendJson(res, 200, Object.assign(r, { status: teleopStatus() }));
    return;
  }
  if (urlPath === '/api/teleop/stop') {
    if (!teleopGuard(req, res)) return;
    const r = stopTeleop();
    sendJson(res, 200, Object.assign(r, { status: teleopStatus() }));
    return;
  }

  if (urlPath === '/api/urdf') {
    sendFile(res, URDF_FILE);
    return;
  }

  const meshMatch = urlPath.match(/^\/api\/(?:description\/)?meshes\/(.+)$/);
  if (meshMatch) {
    sendMesh(res, meshMatch[1]);
    return;
  }

  const gripperMeshMatch = urlPath.match(/^\/api\/gripper_meshes\/(.+)$/);
  if (gripperMeshMatch) {
    sendGripperMesh(res, gripperMeshMatch[1]);
    return;
  }

  const filePath = safePublicPath(urlPath);
  if (!filePath) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  sendFile(res, filePath);
}

// [Added by fanhao375 2026-06-29] 探测本服务宿主平台；WSL 下 USB 经 usbipd 透传，实时遥操约 2Hz
function detectHost() {
  const plat = os.platform();
  if (plat === 'win32') return { host: 'windows', label: 'Windows 原生', realtime: true };
  if (plat === 'darwin') return { host: 'mac', label: 'macOS', realtime: false };
  try {
    const v = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    if (v.includes('microsoft') || v.includes('wsl')) {
      return { host: 'wsl', label: 'WSL2', realtime: false, note: 'USB 经 usbipd 透传，实时遥操约 2Hz' };
    }
  } catch (e) { /* 非 Linux 或无 /proc */ }
  return { host: 'linux', label: '原生 Linux', realtime: true };
}

function createServer() {
  if (!USE_HTTPS) return http.createServer(requestHandler);

  const keyFile = process.env.HTTPS_KEY || DEFAULT_KEY_FILE;
  const certFile = process.env.HTTPS_CERT || DEFAULT_CERT_FILE;

  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    console.error(`HTTPS certificate not found: ${keyFile} / ${certFile}`);
    console.error('Run: npm run cert:dev');
    process.exit(1);
  }

  return https.createServer({
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile)
  }, requestHandler);
}

const server = createServer();

server.listen(PORT, () => {
  const protocol = USE_HTTPS ? 'https' : 'http';
  const lanAddresses = getLanAddresses();
  console.log('========================================');
  console.log('  reBot Arm B601-DM Simulator Started');
  console.log('========================================');
  console.log(`  Local: ${protocol}://localhost:${PORT}`);
  lanAddresses.forEach((address) => console.log(`  LAN:   ${protocol}://${address}:${PORT}`));
  console.log(`  URDF:  ${protocol}://localhost:${PORT}/api/urdf`);
  console.log(`  Mesh:  ${protocol}://localhost:${PORT}/api/description/meshes/base_link.STL`);
  console.log(`  Gripper meshes: ${GRIPPER_MESHES_DIR}`);
  console.log('----------------------------------------');
  console.log(`  URDF file: ${URDF_FILE}`);
  console.log(`  Mesh dir:  ${MESHES_DIR}`);
});
