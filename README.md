# reBot Arm B601-DM Web Simulator

reBot Arm B601-DM Web Simulator 是一个面向 reBot 机械臂的网页仿真与远程控制面板。这个版本重点完成了网页端机械臂模拟、ROS2 Jazzy 工作空间接入，以及通过 rosbridge WebSocket 进行本地、局域网或云端连接的基础链路。

![Simulator Home](./reBotArm_simulator/analysis_report/webpage-home.png)

## 版本重点

- 网页端 3D 机械臂仿真，基于 URDF 与 STL 网格资源加载 reBot Arm B601-DM 模型。
- 支持 6 个机械臂关节与夹爪执行器显示，夹爪行程按 ROS2 示例映射为 0-90 mm。
- 支持 ROS2 Jazzy，面向 Ubuntu 24.04+ 环境。
- 支持通过 rosbridge WebSocket 连接 ROS2 topic、service 和 action。
- 支持 fake driver 联调，便于先在网页和 ROS2 仿真链路中验证控制逻辑。
- 支持 HTTP 局域网访问，也支持 HTTPS/PWA 方式部署到手机或远程环境。
- 适合网页模拟、远程调试、云端接通和后续真实机械臂控制开发。

## 项目结构

```text
reBotArm_simulator/
  public/                  Web 仿真界面、Three.js/URDF 加载、ROS 连接 UI
  public/js/ros/           rosbridge WebSocket 客户端与控制面板逻辑
  split_meshes/            仿真用分离网格与夹爪模型
  scripts/                 本地 HTTPS 证书生成脚本
  README.md                仿真器详细运行说明

reBotArmController_ROS2-main/
  src/rebotarm_bringup/    ROS2 launch、URDF、RViz、配置文件
  src/rebotarm_msgs/       自定义 msg/srv/action
  src/rebotarmcontroller/  ROS2 控制节点、fake driver、服务与 action
```

## 网页仿真运行

进入仿真器目录并启动服务：

```bash
cd reBotArm_simulator
npm start
```

浏览器打开：

```text
http://localhost:3001
```

Windows PowerShell 也可以直接运行：

```powershell
Set-Location E:\reBot-DevArm-main\reBotArm_simulator
node server.js
```

## ROS2 Jazzy 接通

默认 rosbridge WebSocket 目标：

```text
ws://192.168.60.128:9090
```

在 Ubuntu 24.04 + ROS2 Jazzy 中启动 ROS2 工作空间：

```bash
source /opt/ros/jazzy/setup.bash
cd ~/reBotArmController_ROS2-main
colcon build --symlink-install
source install/setup.bash
ros2 launch rebotarm_bringup fake_bringup.launch.py
```

另开一个 Ubuntu 终端启动 rosbridge：

```bash
source /opt/ros/jazzy/setup.bash
source ~/reBotArmController_ROS2-main/install/setup.bash
ros2 launch rosbridge_server rosbridge_websocket_launch.xml port:=9090 address:=0.0.0.0
```

然后在网页仿真器中点击 `连接 ROS`。建议先保持 `允许网页向真实机械臂发控制` 关闭，确认 fake driver 状态同步正常后，再接入真实硬件。

## HTTPS / PWA / 云端接通

手机安装 PWA 或远程访问时，建议使用 HTTPS。先生成本地开发证书：

```powershell
cd reBotArm_simulator
npm run cert:dev
```

启动 HTTPS 服务：

```powershell
npm run start:https
```

访问服务打印出的局域网地址，例如：

```text
https://192.168.x.x:3443
```

如果部署到云端或公网环境，网页页面与 ROS 连接协议需要匹配：

```text
HTTPS 页面 -> 使用 wss:// rosbridge，或通过同源 HTTPS 代理 rosbridge
HTTP 页面  -> 使用 ws://，适合本地或局域网调试
```

## 模型来源

网页仿真器读取 ROS2 工作空间中的 URDF 与 mesh：

```text
reBotArmController_ROS2-main/src/rebotarm_bringup/description/urdf/reBot-DevArm_fixend.urdf
reBotArmController_ROS2-main/src/rebotarm_bringup/description/meshes
```

## 相关说明

- 仿真器详细说明：[reBotArm_simulator/README.md](./reBotArm_simulator/README.md)
- ROS2 Jazzy 控制工作空间：[reBotArmController_ROS2-main/README_zh.md](./reBotArmController_ROS2-main/README_zh.md)
- 本地 HTTPS 证书目录 `reBotArm_simulator/.certs/` 已加入 `.gitignore`，不会上传私钥。
