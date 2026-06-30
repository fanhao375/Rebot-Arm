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

// [Added by fanhao375 2026-06-30] 训练站后端：起 lerobot-train（照搬遥操范式）+ 解析 stdout 的 step/loss 画曲线
const TRAIN_SCRIPT = process.env.TRAIN_SCRIPT
  || path.resolve(ROOT, '..', '..', 'tools', 'lerobot_native_linux', 'start_train.sh');
let trainProc = null;
let trainLog = [];
let trainSeries = []; // [{step, loss}]
let trainJob = null;  // {dataset, policy, steps, mock}
// lerobot-train 实际 stdout 的 step 带 K/M 后缀（如 step:20K），mock 则是裸数字（step: 6000）；都要能解析。
function parseBig(str) {
  const m = String(str).match(/^([0-9]*\.?[0-9]+)\s*([kKmMgGtT]?)/);
  if (!m) return NaN;
  const mult = { k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[(m[2] || '').toLowerCase()] || 1;
  return parseFloat(m[1]) * mult;
}
// [M4 修复] 把 stdout/stderr 的 chunk 按行缓冲：跨 chunk 的半行（如 "step:20K lo" | "ss:0.063"）拼好再交给 onLine，
// 避免真实 lerobot 高频日志在 chunk 边界被切断而丢点。返回的处理器带 flush()，进程退出时冲掉残行。
function streamLines(onLine) {
  let buf = '';
  const handler = function (chunk) {
    buf += String(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim()) onLine(line);
    }
  };
  handler.flush = function () { if (buf.trim()) onLine(buf.trim()); buf = ''; };
  return handler;
}
// 单行记录（手动消息 + streamLines 喂来的整行都走这里）。
function pushTrainLog(line) {
  line = String(line);
  if (!line.trim()) return;
  trainLog.push(line);
  const sm = line.match(/step[:\s=]+([0-9]*\.?[0-9]+[kKmMgGtT]?)/i);
  const lm = line.match(/loss[:\s=]+([0-9]*\.?[0-9]+(?:e[-+]?\d+)?)/i);
  if (sm && lm) {
    const step = Math.round(parseBig(sm[1]));
    const loss = parseFloat(lm[1]);
    if (!isNaN(step) && !isNaN(loss)) trainSeries.push({ step, loss });
    if (trainSeries.length > 5000) trainSeries = trainSeries.slice(-5000);
  }
  if (trainLog.length > 200) trainLog = trainLog.slice(-200);
}
function trainStatus() {
  const last = trainSeries.length ? trainSeries[trainSeries.length - 1] : null;
  return {
    running: !!trainProc, host: os.platform(), script: TRAIN_SCRIPT, job: trainJob,
    step: last ? last.step : null, loss: last ? last.loss : null,
    series: trainSeries, log: trainLog.slice(-30)
  };
}
function startTrain(opts) {
  if (trainProc) return { ok: false, message: '已有训练在跑' };
  if (!fs.existsSync(TRAIN_SCRIPT)) return { ok: false, message: '找不到 start_train.sh：' + TRAIN_SCRIPT };
  opts = opts || {};
  const env = Object.assign({}, process.env);
  if (opts.dataset) env.DATASET_REPO_ID = String(opts.dataset);
  if (opts.policy) env.POLICY_TYPE = String(opts.policy);
  if (opts.steps) env.STEPS = String(opts.steps);
  if (opts.batch) env.BATCH = String(opts.batch);
  if (opts.mock) env.TRAIN_MOCK = '1';
  trainLog = []; trainSeries = [];
  trainJob = { dataset: opts.dataset || '默认', policy: opts.policy || 'act', steps: Number(opts.steps) || null, mock: !!opts.mock, startedAt: Date.now() };
  pushTrainLog('>>> 启动训练' + (opts.mock ? '（演示 mock）' : '') + '：数据集=' + trainJob.dataset + ' 策略=' + trainJob.policy + ' 步数=' + (opts.steps || '默认'));
  try {
    trainProc = spawn('bash', [TRAIN_SCRIPT], { cwd: path.dirname(TRAIN_SCRIPT), env });
  } catch (e) {
    trainProc = null;
    return { ok: false, message: '启动失败（本机可能无 bash / 训练环境）：' + e.message };
  }
  const outBuf = streamLines(pushTrainLog);
  const errBuf = streamLines(pushTrainLog);
  trainProc.stdout.on('data', outBuf);
  trainProc.stderr.on('data', errBuf);
  trainProc.on('exit', (code) => { outBuf.flush(); errBuf.flush(); pushTrainLog('[训练进程退出 code=' + code + ']'); trainProc = null; });
  trainProc.on('error', (err) => { pushTrainLog('[进程错误：本机可能无 bash / 训练环境] ' + err.message); trainProc = null; });
  return { ok: true, message: '训练已启动（真训练若起不来，看下方日志）' };
}
function stopTrain() {
  if (!trainProc) return { ok: false, message: '没有在跑的训练' };
  trainProc.kill('SIGINT');
  pushTrainLog('>>> 已发送停止信号 (SIGINT)');
  return { ok: true, message: '已请求停止训练' };
}

// [Added by fanhao375 2026-06-30] 采数据站后端：扫相机 + 起 lerobot-record（照搬遥操/训练范式）
// 解析 stdout 的 "Recording episode N" / "Encoding episode N" → 当前条数 + 录制/编码相位（坑：编码冻结期 601 卡住=正常）。
function listCameras() {
  if (os.platform() !== 'linux') {
    return { available: false, note: '相机扫描仅原生 Linux 有效（采集要在接臂+相机的机器人机上跑本服务）', byId: [], byPath: [] };
  }
  const scan = (dir) => {
    try { return fs.readdirSync(dir).filter((n) => /video/i.test(n)).map((n) => dir + '/' + n).sort(); }
    catch (e) { return []; }
  };
  const byId = scan('/dev/v4l/by-id');
  const byPath = scan('/dev/v4l/by-path');
  return { available: byId.length > 0 || byPath.length > 0, byId, byPath };
}

const RECORD_SCRIPT = process.env.RECORD_SCRIPT
  || path.resolve(ROOT, '..', '..', 'tools', 'lerobot_native_linux', 'start_record.sh');
let recordProc = null;
let recordLog = [];
let recordEpisode = null; // 最近一条 "Recording episode N"（0 起）
let recordPhase = null;   // 'recording' | 'encoding'
let recordJob = null;     // {dataset, task, numEpisodes, mock, startedAt}
function pushRecordLog(line) { // 单行（M4：streamLines 已按行缓冲，跨 chunk 不丢点）
  line = String(line);
  if (!line.trim()) return;
  recordLog.push(line);
  const rm = line.match(/Recording episode\s+(\d+)/i);
  const em = line.match(/Encoding episode\s+(\d+)/i);
  if (rm) { recordEpisode = parseInt(rm[1], 10); recordPhase = 'recording'; }
  else if (em) { recordPhase = 'encoding'; }
  if (recordLog.length > 200) recordLog = recordLog.slice(-200);
}
function recordStatus() {
  return {
    running: !!recordProc, host: os.platform(), script: RECORD_SCRIPT, job: recordJob,
    episode: recordEpisode, phase: recordPhase,
    total: recordJob ? recordJob.numEpisodes : null,
    log: recordLog.slice(-30)
  };
}
function startRecord(opts) {
  if (recordProc) return { ok: false, message: '已有采集在跑' };
  if (teleopProc) return { ok: false, message: '遥操作在跑，先停遥操作（与采集抢同一串口/臂）' };
  if (!fs.existsSync(RECORD_SCRIPT)) return { ok: false, message: '找不到 start_record.sh：' + RECORD_SCRIPT };
  opts = opts || {};
  const env = Object.assign({}, process.env);
  if (opts.dataset) env.DATASET_REPO_ID = String(opts.dataset);
  if (opts.task) env.SINGLE_TASK = String(opts.task);
  if (opts.episodes) env.NUM_EPISODES = String(opts.episodes);
  if (opts.episodeTime) env.EPISODE_TIME_S = String(opts.episodeTime);
  if (opts.resetTime) env.RESET_TIME_S = String(opts.resetTime);
  if (opts.follower) env.FOLLOWER_PORT = String(opts.follower);
  if (opts.leader) env.LEADER_PORT = String(opts.leader);
  if (opts.top) env.TOP_CAM = String(opts.top);
  if (opts.wrist) env.WRIST_CAM = String(opts.wrist);
  if (opts.resume) env.RESUME = '1';
  if (opts.mock) env.RECORD_MOCK = '1';
  recordLog = []; recordEpisode = null; recordPhase = null;
  recordJob = { dataset: opts.dataset || '默认', task: opts.task || '', numEpisodes: Number(opts.episodes) || null, mock: !!opts.mock, startedAt: Date.now() };
  pushRecordLog('>>> 启动采集' + (opts.mock ? '（演示 mock）' : '') + '：数据集=' + recordJob.dataset + ' 目标条数=' + (opts.episodes || '默认') + '。人站旁边，手放急停旁。');
  try {
    recordProc = spawn('bash', [RECORD_SCRIPT], { cwd: path.dirname(RECORD_SCRIPT), env });
  } catch (e) {
    recordProc = null;
    return { ok: false, message: '启动失败（本机可能无 bash / lerobot 环境）：' + e.message };
  }
  const outBuf = streamLines(pushRecordLog);
  const errBuf = streamLines(pushRecordLog);
  recordProc.stdout.on('data', outBuf);
  recordProc.stderr.on('data', errBuf);
  recordProc.on('exit', (code) => { outBuf.flush(); errBuf.flush(); pushRecordLog('[采集进程退出 code=' + code + ']'); recordProc = null; recordPhase = null; });
  recordProc.on('error', (err) => { pushRecordLog('[进程错误：本机可能无 bash / lerobot 环境] ' + err.message); recordProc = null; });
  return { ok: true, message: '采集已启动（真采集若起不来，看下方日志）' };
}
function stopRecord() {
  if (!recordProc) return { ok: false, message: '没有在跑的采集' };
  recordProc.kill('SIGINT'); // 等同 ESC：停止收尾（注意 Windows 无 POSIX 信号，停子进程靠本机为 Linux）
  pushRecordLog('>>> 已发送停止信号 (SIGINT，等同 ESC 收尾)');
  return { ok: true, message: '已请求停止采集' };
}

// [Added by fanhao375 2026-06-30] 看数据站后端：列数据集 + parquet 质检 + 视频回放 + 删废条
// 数据集落 ~/.cache/huggingface/lerobot/<owner>/<name>；视频 videos/observation.images.{top,wrist}/chunk-000/*.mp4。
const LEROBOT_HOME = process.env.LEROBOT_HOME
  || path.join(os.homedir(), '.cache', 'huggingface', 'lerobot');
const QUALITY_SCRIPT = process.env.QUALITY_SCRIPT
  || path.resolve(ROOT, '..', '..', 'tools', 'lerobot_native_linux', 'dataset_quality.py');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

// repo_id 来自前端 → 必须防路径穿越：只允许 owner/name 两段、字符受限、解析后须落在 LEROBOT_HOME 内。
function safeDatasetPath(repoId) {
  if (!repoId || !/^[\w.-]+\/[\w.-]+$/.test(repoId)) return null;
  const p = path.resolve(path.join(LEROBOT_HOME, repoId));
  const base = path.resolve(LEROBOT_HOME);
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  return p;
}
function isDataset(dir) {
  return fs.existsSync(path.join(dir, 'data')) || fs.existsSync(path.join(dir, 'meta'));
}
function countEpisodes(dir) {
  try {
    let n = 0;
    const dataDir = path.join(dir, 'data');
    const walk = (d) => {
      fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (/\.parquet$/i.test(e.name)) n++;
      });
    };
    if (fs.existsSync(dataDir)) walk(dataDir);
    return n;
  } catch (e) { return null; }
}
function listDatasets() {
  if (!fs.existsSync(LEROBOT_HOME)) {
    return { available: false, home: LEROBOT_HOME, note: '没有 ~/.cache/huggingface/lerobot —— 看数据要在采过数据的机器上跑本服务（采集机/训练机）。', datasets: [] };
  }
  const out = [];
  try {
    fs.readdirSync(LEROBOT_HOME, { withFileTypes: true }).filter((o) => o.isDirectory()).forEach((owner) => {
      const ownerDir = path.join(LEROBOT_HOME, owner.name);
      // 直接是数据集（无 owner 层）或 owner/name 两层
      if (isDataset(ownerDir)) {
        out.push({ repo_id: owner.name, episodes: countEpisodes(ownerDir), hasVideos: fs.existsSync(path.join(ownerDir, 'videos')) });
        return;
      }
      try {
        fs.readdirSync(ownerDir, { withFileTypes: true }).filter((o) => o.isDirectory()).forEach((name) => {
          const dir = path.join(ownerDir, name.name);
          if (isDataset(dir)) out.push({ repo_id: owner.name + '/' + name.name, episodes: countEpisodes(dir), hasVideos: fs.existsSync(path.join(dir, 'videos')) });
        });
      } catch (e) { /* skip */ }
    });
  } catch (e) {
    return { available: false, home: LEROBOT_HOME, note: '读取失败: ' + e.message, datasets: [] };
  }
  return { available: true, home: LEROBOT_HOME, datasets: out.sort((a, b) => a.repo_id.localeCompare(b.repo_id)) };
}

function mockEpisodes() {
  // 给无数据的机器联调前端：6 条，混入 2 条废条
  const eps = [];
  for (let i = 0; i < 6; i++) {
    const bad = (i === 2 || i === 4);
    eps.push({
      episode: i, frames: bad ? (i === 2 ? 3 : 40) : 120 + i * 5,
      leaderAmp: bad && i === 2 ? 1 : 60 + i, followerAmp: bad ? (i === 2 ? 1 : 12) : 58 + i,
      verdict: bad ? 'bad' : 'ok',
      reason: bad ? (i === 2 ? '主臂≈0°，空条（当时没动 102）' : '主臂动了、从臂没跟（601 当时没跟上）') : ''
    });
  }
  return { ok: true, count: eps.length, episodes: eps, mock: true };
}
function datasetEpisodes(repoId, mock, cb) {
  if (mock) return cb(mockEpisodes());
  const dir = safeDatasetPath(repoId);
  if (!dir) return cb({ ok: false, error: '非法数据集名（要 owner/name 形式）' });
  if (!fs.existsSync(dir)) return cb({ ok: false, error: '数据集不存在：' + dir });
  let out = '', err = '';
  let proc;
  try {
    proc = spawn(PYTHON_BIN, [QUALITY_SCRIPT, dir]);
  } catch (e) {
    return cb({ ok: false, error: '起 python 失败（本机可能无 python3）：' + e.message });
  }
  const timer = setTimeout(() => { try { proc.kill(); } catch (e) {} cb({ ok: false, error: '质检超时（数据集太大或卡住）' }); }, 60000);
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('error', (e) => { clearTimeout(timer); cb({ ok: false, error: '起 python 失败：' + e.message }); });
  proc.on('close', () => {
    clearTimeout(timer);
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
    try { cb(JSON.parse(line)); }
    catch (e) { cb({ ok: false, error: '质检输出解析失败：' + (err.trim() || out.trim() || e.message).slice(0, 400) }); }
  });
}

// 视频回放（带 HTTP Range，支持 <video> 拖动）。cam 白名单，ep 取整，路径须落在数据集内。
function datasetVideoPath(repoId, cam, ep) {
  const dir = safeDatasetPath(repoId);
  if (!dir) return null;
  if (cam !== 'top' && cam !== 'wrist') return null;
  const epi = parseInt(ep, 10);
  if (isNaN(epi) || epi < 0) return null;
  const camDir = path.join(dir, 'videos', 'observation.images.' + cam, 'chunk-000');
  const padded = String(epi).padStart(6, '0');
  const direct = path.join(camDir, 'episode_' + padded + '.mp4');
  if (fs.existsSync(direct)) return direct;
  // 兜底：目录命名有出入时按 episode 号 glob 一下
  try {
    const hit = fs.readdirSync(camDir).find((n) => n.indexOf(padded) >= 0 && /\.mp4$/i.test(n));
    if (hit) return path.join(camDir, hit);
  } catch (e) { /* no dir */ }
  return null;
}
function sendVideoFile(req, res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { sendJson(res, 404, { error: '视频不存在' }); return; }
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res); return;
    }
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || start < 0) start = 0;
    if (isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size }); res.end(); return; }
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });
}

// 删废条：lerobot-edit-dataset delete_episodes（破坏性 → 过安全闸；注意默认重编码会转 AV1）。
function deleteEpisodes(repoId, indices, cb) {
  const dir = safeDatasetPath(repoId);
  if (!dir) return cb({ ok: false, message: '非法数据集名' });
  if (!fs.existsSync(dir)) return cb({ ok: false, message: '数据集不存在' });
  const idx = String(indices || '').split(',').map((s) => parseInt(s, 10)).filter((n) => !isNaN(n) && n >= 0);
  if (!idx.length) return cb({ ok: false, message: '没选要删的 episode' });
  let out = '', err = '';
  let proc;
  try {
    proc = spawn('lerobot-edit-dataset', [
      '--repo_id=' + repoId,
      '--operation.type=delete_episodes',
      '--operation.episode_indices=[' + idx.join(',') + ']'
    ], { env: Object.assign({}, process.env, { HF_HUB_OFFLINE: '1' }) });
  } catch (e) {
    return cb({ ok: false, message: '起 lerobot-edit-dataset 失败（需 lerobot 环境）：' + e.message });
  }
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('error', (e) => cb({ ok: false, message: '起删除工具失败：' + e.message }));
  proc.on('close', (code) => cb({ ok: code === 0, message: code === 0 ? ('已删 ' + idx.length + ' 条（原数据自动备份为 <repo_id>_old，重建需耐心等编码）' ) : ('删除失败 code=' + code + '：' + (err.trim() || out.trim()).slice(0, 400)) }));
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

  // [Added by fanhao375 2026-06-30] GPU 监控（训练站第一块真功能）：nvidia-smi → JSON
  if (urlPath === '/api/gpu') {
    sendJson(res, 200, gpuInfo());
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

  // [Added by fanhao375 2026-06-30] 训练站：状态 / 起 / 停（start|stop 过安全闸）
  if (urlPath === '/api/train/status') {
    sendJson(res, 200, trainStatus());
    return;
  }
  if (urlPath === '/api/train/start') {
    if (!teleopGuard(req, res)) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const r = startTrain({ dataset: q.get('dataset'), policy: q.get('policy'), steps: q.get('steps'), batch: q.get('batch'), mock: q.get('mock') === '1' });
    sendJson(res, 200, Object.assign(r, { status: trainStatus() }));
    return;
  }
  if (urlPath === '/api/train/stop') {
    if (!teleopGuard(req, res)) return;
    const r = stopTrain();
    sendJson(res, 200, Object.assign(r, { status: trainStatus() }));
    return;
  }

  // [Added by fanhao375 2026-06-30] 采数据站：扫相机 / 状态 / 起 / 停（start|stop 过安全闸，真机写）
  if (urlPath === '/api/cameras') {
    sendJson(res, 200, listCameras());
    return;
  }
  if (urlPath === '/api/record/status') {
    sendJson(res, 200, recordStatus());
    return;
  }
  if (urlPath === '/api/record/start') {
    if (!teleopGuard(req, res)) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const r = startRecord({
      dataset: q.get('dataset'), task: q.get('task'), episodes: q.get('episodes'),
      episodeTime: q.get('episodeTime'), resetTime: q.get('resetTime'),
      follower: q.get('follower'), leader: q.get('leader'),
      top: q.get('top'), wrist: q.get('wrist'),
      resume: q.get('resume') === '1', mock: q.get('mock') === '1'
    });
    sendJson(res, 200, Object.assign(r, { status: recordStatus() }));
    return;
  }
  if (urlPath === '/api/record/stop') {
    if (!teleopGuard(req, res)) return;
    const r = stopRecord();
    sendJson(res, 200, Object.assign(r, { status: recordStatus() }));
    return;
  }

  // [Added by fanhao375 2026-06-30] 看数据站：列数据集 / 质检 episode / 视频回放(range) / 删废条(过闸)
  if (urlPath === '/api/datasets') {
    sendJson(res, 200, listDatasets());
    return;
  }
  if (urlPath === '/api/dataset/episodes') {
    const q = new URL(req.url, 'http://x').searchParams;
    datasetEpisodes(q.get('id'), q.get('mock') === '1', (result) => sendJson(res, 200, result));
    return;
  }
  if (urlPath === '/api/dataset/video') {
    const q = new URL(req.url, 'http://x').searchParams;
    const fp = datasetVideoPath(q.get('id'), q.get('cam'), q.get('ep'));
    if (!fp) { sendJson(res, 404, { error: '视频不存在或参数非法' }); return; }
    sendVideoFile(req, res, fp);
    return;
  }
  if (urlPath === '/api/dataset/delete') {
    if (!teleopGuard(req, res)) return;
    const q = new URL(req.url, 'http://x').searchParams;
    deleteEpisodes(q.get('id'), q.get('episodes'), (result) => sendJson(res, 200, result));
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

// [Added by fanhao375 2026-06-30] GPU 监控：训练站第一块真功能，nvidia-smi → JSON（无 GPU 诚实报错）
// [M5 修复] execSync('nvidia-smi') 同步阻塞事件循环；GPU 卡每 2s 轮询 + 训练每 1s 轮询会互相拖。
// 加 1.5s 结果缓存：多个轮询/页面共享一次采样，避免事件循环被反复阻塞。
let gpuCache = null, gpuCacheAt = 0;
function gpuInfo() {
  const now = Date.now();
  if (gpuCache && (now - gpuCacheAt) < 1500) return gpuCache;
  gpuCache = gpuInfoRaw();
  gpuCacheAt = now;
  return gpuCache;
}
function gpuInfoRaw() {
  try {
    const fields = 'name,temperature.gpu,utilization.gpu,utilization.memory,memory.used,memory.total,power.draw,power.limit,clocks.sm,fan.speed';
    const out = execSync(`nvidia-smi --query-gpu=${fields} --format=csv,noheader,nounits`, { encoding: 'utf8', timeout: 4000 });
    const num = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
    const gpus = out.trim().split('\n').filter(Boolean).map((line, i) => {
      const c = line.split(',').map((s) => s.trim());
      return {
        index: i, name: c[0],
        temp: num(c[1]), gpuUtil: num(c[2]), memUtil: num(c[3]),
        memUsed: num(c[4]), memTotal: num(c[5]),     // MiB
        power: num(c[6]), powerLimit: num(c[7]),      // W
        clock: num(c[8]), fan: num(c[9])              // MHz / %
      };
    });
    return { available: true, gpus };
  } catch (e) {
    return { available: false, error: 'nvidia-smi 不可用（本机无 NVIDIA GPU 或未装驱动）。训练监控需在有 GPU 的机器上跑本服务。' };
  }
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
