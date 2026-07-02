// reBot 驾驶舱 · 3D 物理仿真主程序（浏览器内 MuJoCo，mujoco-js WASM + three.js）
// [Added by fanhao375 2026-07-01] 改编自 zalo/mujoco_wasm 的 src/main.js（MIT）。
//   改动仅三处：① import 改成 importmap 裸名/CDN；② 场景加载改成「机器人库」配置驱动（robots.js）；
//   ③ 用自己的 GUI（机器人下拉 + 8 舵机滑块 + 重置），替掉原来写死的示例场景下拉。
//   渲染/物理步进/拖拽施力（render()）原样保留 —— 那是 zalo 调好的，别动。
import * as THREE           from 'three';
import { GUI              } from 'three/addons/libs/lil-gui.module.min.js';
import { OrbitControls    } from 'three/addons/controls/OrbitControls.js';
import { DragStateManager } from './utils/DragStateManager.js';
import { loadSceneFromURL, drawTendonsAndFlex, getPosition, getQuaternion, toMujocoPos, standardNormal } from './mujocoUtils.js';
import   load_mujoco        from 'mujoco-js';
import { ROBOTS, DEFAULT_ROBOT, downloadRobotScene } from './robots.js';

// 载入 MuJoCo WASM 模块 + 建虚拟文件系统（一次）
const mujoco = await load_mujoco();
mujoco.FS.mkdir('/working');
mujoco.FS.mount(mujoco.MEMFS, { root: '.' }, '/working');

export class MuJoCoDemo {
  constructor() {
    this.mujoco = mujoco;
    this.currentRobot = DEFAULT_ROBOT;
    this.model = null; this.data = null;

    this.params = { robot: DEFAULT_ROBOT, paused: false, ctrlnoiserate: 0.0, ctrlnoisestd: 0.0 };
    this.mujoco_time = 0.0;
    this.bodies  = {}, this.lights = {};
    this.tmpVec  = new THREE.Vector3();
    this.tmpQuat = new THREE.Quaternion();
    this.actuatorGUIs = [];

    this.container = document.createElement('div');
    document.body.appendChild(this.container);

    this.scene = new THREE.Scene();
    this.scene.name = 'scene';

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.001, 100);
    this.camera.name = 'PerspectiveCamera';
    this.scene.add(this.camera);

    this.scene.background = new THREE.Color(0.15, 0.25, 0.35);
    this.scene.fog = new THREE.Fog(this.scene.background, 15, 25.5);

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.1 * 3.14);
    this.ambientLight.name = 'AmbientLight';
    this.scene.add(this.ambientLight);

    this.spotlight = new THREE.SpotLight();
    this.spotlight.angle = 1.11;
    this.spotlight.distance = 10000;
    this.spotlight.penumbra = 0.5;
    this.spotlight.castShadow = true;
    this.spotlight.intensity = this.spotlight.intensity * 3.14 * 10.0;
    this.spotlight.shadow.mapSize.width = 1024;
    this.spotlight.shadow.mapSize.height = 1024;
    this.spotlight.shadow.camera.near = 0.1;
    this.spotlight.shadow.camera.far = 100;
    this.spotlight.position.set(0, 3, 3);
    const targetObject = new THREE.Object3D();
    this.scene.add(targetObject);
    this.spotlight.target = targetObject;
    targetObject.position.set(0, 1, 0);
    this.scene.add(this.spotlight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    THREE.ColorManagement.enabled = false;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.useLegacyLights = true;
    this.renderer.setAnimationLoop(this.render.bind(this));
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.panSpeed = 2;
    this.controls.zoomSpeed = 1;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.10;
    this.controls.screenSpacePanning = true;
    this.applyCameraForRobot(this.currentRobot);

    window.addEventListener('resize', this.onWindowResize.bind(this));
    this.dragStateManager = new DragStateManager(this.scene, this.renderer, this.camera, this.container.parentElement, this.controls);
  }

  applyCameraForRobot(key) {
    const cam = (ROBOTS[key] && ROBOTS[key].camera) || { pos: [2, 1.7, 1.7], target: [0, 0.7, 0] };
    this.camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    this.controls.target.set(cam.target[0], cam.target[1], cam.target[2]);
    this.controls.update();
  }

  async init() {
    setStatus('正在载入 ' + (ROBOTS[this.currentRobot] ? ROBOTS[this.currentRobot].label : this.currentRobot) + ' 模型…');
    const sceneFile = await downloadRobotScene(mujoco, this.currentRobot);
    [this.model, this.data, this.bodies, this.lights] = await loadSceneFromURL(mujoco, sceneFile, this);
    this.applyHome();
    this.gui = new GUI({ title: '控制台' });
    this.buildGUI();
    setStatus('');
    setNote(ROBOTS[this.currentRobot] ? ROBOTS[this.currentRobot].note : '');
  }

  /** 切换机器人：清掉旧场景、下载并加载新场景、重建控件、复位相机。 */
  async loadRobot(key) {
    // 防重入：下拉连点两次会让两个 loadRobot 交错，把半换好的 model/data 喂进 mj_step → 硬崩 WASM 堆。
    if (!ROBOTS[key] || this._switching) { this.params.robot = this.currentRobot; return; }
    this._switching = true;
    const wasPaused = this.params.paused;
    this.params.paused = true;            // 交换期间停物理步进
    try {
      setStatus('正在切换到 ' + ROBOTS[key].label + '…');
      this.currentRobot = key;
      this.params.robot = key;
      const old = this.scene.getObjectByName('MuJoCo Root');
      if (old) this.scene.remove(old);
      // 释放旧 model 原生内存（loadSceneFromURL 只释放 data 不释放 model）；先置 null，render() 的 !this.model 卫语句会早退。
      if (this.model && this.model.delete) { this.model.delete(); }
      this.model = null;
      const sceneFile = await downloadRobotScene(mujoco, key);
      [this.model, this.data, this.bodies, this.lights] = await loadSceneFromURL(mujoco, sceneFile, this);
      this.applyHome();
      this.applyCameraForRobot(key);
      this.rebuildActuators();
      setStatus('');
      setNote(ROBOTS[key].note);
    } catch (err) {
      console.error(err);
      setStatus('切换失败：' + (err && err.message ? err.message : err));
    } finally {
      this.params.paused = wasPaused;
      this._switching = false;
    }
  }

  /** 复位到 home 关键帧（张开手），并让控制目标=当前关节，避免松手瞬间跳。 */
  applyHome() {
    const home = ROBOTS[this.currentRobot] && ROBOTS[this.currentRobot].home;
    if (home != null && home < this.model.nkey) {
      this.data.qpos.set(this.model.key_qpos.slice(home * this.model.nq, (home + 1) * this.model.nq));
      // 若关键帧带 ctrl，把控制目标也对齐到 home，避免松手瞬间被物理拉回旧目标（未来 home≠ctrl0 的机器人才需要；
      // AmazingHand 的 home 就是 ctrl=0 平衡位，这里 set 的全是 0，无变化）。
      if (this.model.key_ctrl && this.model.nu > 0) {
        this.data.ctrl.set(this.model.key_ctrl.slice(home * this.model.nu, (home + 1) * this.model.nu));
      }
    }
    // 让滑块显示对齐到当前控制目标
    const decoder = new TextDecoder('utf-8');
    const nul = decoder.decode(new ArrayBuffer(1));
    for (let i = 0; i < this.model.nu; i++) {
      const name = decoder.decode(this.model.names.subarray(this.model.name_actuatoradr[i])).split(nul)[0];
      this.params[name] = this.data.ctrl[i];
    }
    mujoco.mj_forward(this.model, this.data);
  }

  buildGUI() {
    // 机器人选择
    const opts = {};
    Object.keys(ROBOTS).forEach(k => { opts[ROBOTS[k].label] = k; });
    this.gui.add(this.params, 'robot', opts).name('机器人').onChange(v => this.loadRobot(v));

    // 播放/暂停
    this.gui.add(this.params, 'paused').name('暂停物理').listen();
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { this.params.paused = !this.params.paused; e.preventDefault(); }
    });

    // 重置姿态（回到张开 home）
    this.gui.add({ reset: () => this.applyHome() }, 'reset').name('重置姿态（张开）');

    // 8 舵机滑块
    this.actuatorFolder = this.gui.addFolder('舵机（拖动让手指动）');
    this.rebuildActuators();
    this.actuatorFolder.open();

    this.gui.open();
  }

  rebuildActuators() {
    for (const g of this.actuatorGUIs) { g.destroy(); }
    this.actuatorGUIs = [];
    const model = this.model, data = this.data;
    const decoder = new TextDecoder('utf-8');
    const nul = decoder.decode(new ArrayBuffer(1));
    const range = model.actuator_ctrlrange;
    for (let i = 0; i < model.nu; i++) {
      if (!model.actuator_ctrllimited[i]) { continue; }
      const name = decoder.decode(model.names.subarray(model.name_actuatoradr[i])).split(nul)[0];
      if (!(name in this.params)) { this.params[name] = data.ctrl[i]; }
      const gui = this.actuatorFolder.add(this.params, name, range[2 * i], range[2 * i + 1], 0.001).name(name).listen();
      gui.onChange((value) => { data.ctrl[i] = value; });
      this.actuatorGUIs.push(gui);
    }
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // ===== 以下 render() 原样取自 zalo/mujoco_wasm（物理步进 + 拖拽施力 + 同步 three.js 变换），未改 =====
  render(timeMS) {
    this.controls.update();
    if (!this.model) { this.renderer.render(this.scene, this.camera); return; }

    if (!this.params["paused"]) {
      let timestep = this.model.opt.timestep;
      if (timeMS - this.mujoco_time > 35.0) { this.mujoco_time = timeMS; }
      while (this.mujoco_time < timeMS) {
        if (this.params["ctrlnoisestd"] > 0.0) {
          let rate  = Math.exp(-timestep / Math.max(1e-10, this.params["ctrlnoiserate"]));
          let scale = this.params["ctrlnoisestd"] * Math.sqrt(1 - rate * rate);
          let currentCtrl = this.data.ctrl;
          for (let i = 0; i < currentCtrl.length; i++) {
            currentCtrl[i] = rate * currentCtrl[i] + scale * standardNormal();
            this.params["Actuator " + i] = currentCtrl[i];
          }
        }

        for (let i = 0; i < this.data.qfrc_applied.length; i++) { this.data.qfrc_applied[i] = 0.0; }
        let dragged = this.dragStateManager.physicsObject;
        if (dragged && dragged.bodyID) {
          for (let b = 0; b < this.model.nbody; b++) {
            if (this.bodies[b]) {
              getPosition  (this.data.xpos , b, this.bodies[b].position);
              getQuaternion(this.data.xquat, b, this.bodies[b].quaternion);
              this.bodies[b].updateWorldMatrix();
            }
          }
          let bodyID = dragged.bodyID;
          this.dragStateManager.update();
          let force = toMujocoPos(this.dragStateManager.currentWorld.clone().sub(this.dragStateManager.worldHit).multiplyScalar(this.model.body_mass[bodyID] * 250));
          let point = toMujocoPos(this.dragStateManager.worldHit.clone());
          mujoco.mj_applyFT(this.model, this.data, [force.x, force.y, force.z], [0, 0, 0], [point.x, point.y, point.z], bodyID, this.data.qfrc_applied);
        }

        mujoco.mj_step(this.model, this.data);
        this.mujoco_time += timestep * 1000.0;
      }
    } else if (this.params["paused"]) {
      this.dragStateManager.update();
      let dragged = this.dragStateManager.physicsObject;
      if (dragged && dragged.bodyID) {
        let b = dragged.bodyID;
        getPosition  (this.data.xpos , b, this.tmpVec , false);
        getQuaternion(this.data.xquat, b, this.tmpQuat, false);

        let offset = toMujocoPos(this.dragStateManager.currentWorld.clone()
          .sub(this.dragStateManager.worldHit).multiplyScalar(0.3));
        if (this.model.body_mocapid[b] >= 0) {
          let addr = this.model.body_mocapid[b] * 3;
          let pos  = this.data.mocap_pos;
          pos[addr+0] += offset.x; pos[addr+1] += offset.y; pos[addr+2] += offset.z;
        } else {
          let root = this.model.body_rootid[b];
          let addr = this.model.jnt_qposadr[this.model.body_jntadr[root]];
          let pos  = this.data.qpos;
          pos[addr+0] += offset.x; pos[addr+1] += offset.y; pos[addr+2] += offset.z;
        }
      }
      mujoco.mj_forward(this.model, this.data);
    }

    for (let b = 0; b < this.model.nbody; b++) {
      if (this.bodies[b]) {
        getPosition  (this.data.xpos , b, this.bodies[b].position);
        getQuaternion(this.data.xquat, b, this.bodies[b].quaternion);
        this.bodies[b].updateWorldMatrix();
      }
    }

    for (let l = 0; l < this.model.nlight; l++) {
      if (this.lights[l]) {
        getPosition(this.data.light_xpos, l, this.lights[l].position);
        getPosition(this.data.light_xdir, l, this.tmpVec);
        this.lights[l].lookAt(this.tmpVec.add(this.lights[l].position));
      }
    }

    drawTendonsAndFlex(this.mujocoRoot, this.model, this.data);
    this.renderer.render(this.scene, this.camera);
  }
}

// 顶栏状态/说明文字钩子（sim3d.html 里有对应元素）
function setStatus(t) { const e = document.getElementById('sim-status'); if (e) { e.textContent = t; e.style.display = t ? 'block' : 'none'; } }
function setNote(t)   { const e = document.getElementById('sim-note');   if (e) { e.textContent = t || ''; } }

let demo = new MuJoCoDemo();
try {
  await demo.init();
  window.__demo = demo;
} catch (err) {
  console.error(err);
  setStatus('加载失败：' + (err && err.message ? err.message : err) + '　（多半是没连网拿 CDN，或某个网格没找到——按 F12 看 Console）');
}
