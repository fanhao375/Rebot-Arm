# 3D 物理仿真（sim3d）· 第三方来源与许可

本目录（`public/sim3d/`）在浏览器里用真 MuJoCo（WebAssembly）渲染机器人 3D，集成了以下第三方成果。原样复用的文件保留其原许可，二次创作的文件在文件头注明来源。

## 1. zalo/mujoco_wasm —— 加载/渲染代码（MIT）
- 来源：https://github.com/zalo/mujoco_wasm
- 原样复用：`js/mujocoUtils.js`、`js/utils/DragStateManager.js`、`js/utils/Reflector.js`
- 二次创作（改编）：`js/main.js`（改成机器人库配置驱动 + 自建 GUI）
- 许可：MIT

```
MIT License

Copyright (c) 2017 Konstantin Gredeskoul

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. MuJoCo + 官方 WASM bindings（Apache-2.0）
- MuJoCo：https://github.com/google-deepmind/mujoco
- `mujoco-js`（官方 WASM 绑定的 npm 包，运行时经 CDN importmap 引入，未打进本仓）
- 许可：Apache License 2.0

## 3. three.js（MIT）
- 来源：https://github.com/mrdoob/three.js （运行时经 CDN importmap 引入，未打进本仓）
- 许可：MIT

## 4. Amazing Hand 模型与网格（Apache-2.0 代码 / CC-BY-4.0 机械设计）
- 来源：https://github.com/pollen-robotics/AmazingHand （Pollen Robotics）
- 本仓收录：`scenes/amazing_hand/robot.xml`、`keyframes.xml`、`assets/*.stl`（onshape-to-robot 导出的 MJCF + 网格）
- `scenes/amazing_hand/ah_scene.xml` 为本项目基于其 `scene.xml` 改写（去掉 mink IK 的 mocap 目标球）
- 许可：项目代码 Apache-2.0；**机械设计（含 3D 网格）CC-BY-4.0**，署名 Pollen Robotics（https://www.pollen-robotics.com/）
