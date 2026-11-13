# 设备地址空间的路径与类型采集

本项目用于授权资料接入的单次查看与接收留存，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，随后采集地址空间清单作为基线、对来源执行命名空间重排、再对比前后清单，显示完整 JSON 后关闭服务并清理临时目录。通常在十秒内结束。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 逐节点诊断浏览（保留原始分页与续读句柄），`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

`GET /inventory` 采集地址空间清单：参数 `root` 可重复指定多个根，`reference` 可重复指定引用白名单（默认 HasComponent、Organizes），`maxDepth`、`maxNodes` 限制遍历规模。根节点支持 `nsu=<命名空间URI>;s=<标识符>` 形式，命名空间编号重排后仍可复用。清单中节点身份由命名空间 URI 与标识符构成，展示路径只是首次发现时到达该节点的一条路径；多个父节点、环（回边）、匿名显示名分别记录在 parents、cycles 与匿名回退路径段中。变量节点解析继承的类型约束（沿 HasTypeDefinition 与 HasSubtype）、数组维数、单位与可读性，读不到的字段保持 null 并列入 missing，不填默认值。`points` 汇总可读测点，可直接交给采集配置平台。

`GET /inventory/receive?key=base&root=...` 采集清单并留存为基线；`GET /inventory/diff?key=base&root=...` 重新采集并与留存基线对比，只报告真实变化（节点增删、父节点集合、变量元数据），ns= 编号与展示路径变化不算差异。若本次采集存在失败或截断，响应会附带 errors 与 truncated，避免把未到达的节点误读为删除。网关浏览句柄有限，遍历顺序拉取并在分页中断或取消时释放续读句柄；单个根或单条边失败不影响其他根。

`src/connector.mjs` 解释单次来源响应，`src/inventory.mjs` 负责清单采集、类型约束继承解析与清单对比，`fixtures/source.mjs` 提供可重复启动的本地来源，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果。`test/connector.test.mjs` 验证协议原语和演练源，`test/inventory.test.mjs` 验证清单身份、环与多父节点、句柄释放、根隔离、重排演练与清单对比，`test/service.test.mjs` 验证服务与留存边界。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
