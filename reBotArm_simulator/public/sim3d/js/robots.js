// reBot 驾驶舱 · 3D 物理仿真（浏览器内 MuJoCo）· 机器人库配置
// [Added by fanhao375 2026-07-01] 网页选机器人 → 浏览器里跑真 MuJoCo（mujoco-js WASM）→ 看 3D + 拖滑块驱动。
//
// 加新机器人 = 在 ROBOTS 里加一项 + 在 scenes/<dir>/ 放好 MJCF+网格+manifest.json（其它全自动）。
// scene 加载走 mujocoUtils.loadSceneFromURL（zalo 原版，未改）；这里只负责：机器人清单 + 把 MJCF/网格塞进 WASM 的虚拟文件系统。

export const ROBOTS = {
  amazing_hand: {
    label: 'Amazing Hand · 灵巧手（8 自由度 · 闭链并联）',
    dir: 'amazing_hand',
    // 相机：手很小（~0.15m），要凑近；不用 humanoid 那套 (2,1.7,1.7)。
    camera: { pos: [0.34, 0.16, 0.34], target: [0, 0.06, 0] },
    home: 0, // keyframes.xml 里的 "zero" 张开位姿
    note: 'Pollen Robotics 开源手。8 个舵机 = 4 指 × 2（finger?_motor1/2）。20 组 connect 闭链约束，MuJoCo 实时解。',
    source: 'github.com/pollen-robotics/AmazingHand（CC-BY-4.0 机械设计 / Apache-2.0 代码）'
  }
  // 之后可加： rebot_arm（我们已有 reBot_scene.xml）、lekiwi 等。加项即可，无需改 main.js。
};

export const DEFAULT_ROBOT = 'amazing_hand';

/** 把一个机器人的 MJCF + 网格下载进 MuJoCo(Emscripten) 的虚拟文件系统 /working/<dir>/。
 *  读 scenes/<dir>/manifest.json 决定要哪些文件（不写死清单）。
 *  @returns {string} 相对 /working/ 的入口场景路径，给 loadSceneFromURL 用（如 "amazing_hand/ah_scene.xml"）。 */
export async function downloadRobotScene(mujoco, robotKey, baseURL = './scenes/') {
  const robot = ROBOTS[robotKey];
  if (!robot) throw new Error('未知机器人: ' + robotKey);
  const base = baseURL + robot.dir + '/';
  const manifest = await (await fetch(base + 'manifest.json')).json();

  ensureDir(mujoco, '/working');
  const root = '/working/' + robot.dir;
  ensureDir(mujoco, root);

  // XML（文本）
  for (const f of manifest.xml) {
    const txt = await (await fetch(base + f)).text();
    mujoco.FS.writeFile(root + '/' + f, txt);
  }
  // 网格（二进制）
  if (manifest.meshes && manifest.meshes.length) {
    ensureDir(mujoco, root + '/' + manifest.meshDir);
    // 并发抓，串行写（写很快）
    const bufs = await Promise.all(
      manifest.meshes.map(m => fetch(base + manifest.meshDir + '/' + m).then(r => r.arrayBuffer()))
    );
    manifest.meshes.forEach((m, i) => {
      mujoco.FS.writeFile(root + '/' + manifest.meshDir + '/' + m, new Uint8Array(bufs[i]));
    });
  }
  return robot.dir + '/' + manifest.scene;
}

function ensureDir(mujoco, p) {
  if (!mujoco.FS.analyzePath(p).exists) mujoco.FS.mkdir(p);
}
