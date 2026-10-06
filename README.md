# micromod — 受限 ES 模块解释器

读取真实 `.mjs` 文件，用 Acorn 做语法解析，**自行管理导出绑定与模块生命周期**
（不使用原生 `import` / `vm.SourceTextModule` 代执行）。核心语义是**活绑定**
（live binding）：导入方读到的是导出方环境槽位的引用，而不是导入瞬间的数值
副本——计数器导出后再次被自增，导入方随后读到的是新值。

## 运行

```sh
npm install          # 仅依赖 acorn
node src/cli.js <模块目录> <入口文件> [--call <导出函数名>]
npm test             # 预言机对照测试 + 单元测试
```

示例：

```sh
$ node src/cli.js samples/live main.mjs --call main
trace: exec counter.mjs
trace: init counter.mjs
trace: exec main.mjs
trace: init main.mjs
result: main() = 2        # before=0、after=2：同一导入绑定在不同时刻读到不同值
```

输出：模块初始化轨迹（`trace:` 行，含 `exec`/`init`/`fail`），随后是调用结果
或错误报告。错误报告定位到**文件:行:列**并给出从入口出发的**导入链**：

```
error: [tdz] Cannot access 'ax' before initialization
  at b.mjs:5:17
  import chain: main.mjs -> a.mjs -> b.mjs
```

退出码：`0` 成功；`1` 模块错误（语法/链接/求值）；`2` 用法错误。

## 语法子集（其余一律明确拒绝）

- 具名导入 `import { a as b } from './x.mjs'`（仅限同目录 `./x.mjs` 说明符）
- 具名导出 `export let/const/function ...`、`export { x as y }`
- `let` / `const` 声明（`const` 必须有初始化式；`let x;` 保持未初始化）
- 零参数函数声明、零参数函数调用、`return <表达式>`
- 赋值语句 `x = <表达式>`
- 表达式：数字字面量、标识符、`+`、`-`、括号

拒绝示例：`if`/`while`、`*`/`/`、一元负号、箭头函数、字符串、`import *`、
`export default`、带参函数、复合赋值 `+=` 等，均报出具体语法名与位置。

## 模块语义

- **上限 6 个模块**，全部位于同一目录；目录可只读挂载。
- **两阶段**：先为完整可达图建立绑定（函数声明提升为已初始化、`let/const`
  进入暂时性死区、接线导入绑定）并**检查缺失导出**，再执行任何模块体。
- 依赖按**源码顺序**访问；每个模块体**只执行一次**（菱形依赖共享的模块
  不会重复执行）。
- **合法循环不拒绝**：环上回到正在求值的模块时直接返回，读到什么算什么——
  函数声明已提升可用；读取未初始化的 `let/const` 报 TDZ 错误。
- **失败不重跑**：求值失败的模块保持失败态并记录错误，后续依赖它的模块
  直接重抛该记录错误，失败模块的模块体不会再次执行；失败沿导入链传播。
- **导入绑定只读**：对导入名赋值报错（对照真实 Node 的 `TypeError`）。

## 样例（samples/）

| 目录 | 演示 | 结果 |
| --- | --- | --- |
| `cycle` | 循环依赖中的跨模块函数调用（提升生效） | `main() = 23` |
| `live` | 同一导出值在更新前后的两次读取（活绑定） | `main() = 2`（快照语义会错算成 0） |
| `tdz` | 循环中初始化前读取 → TDZ 错误 | 失败（`ReferenceError` 对照） |
| `failure` | 求值失败沿菱形图传播，失败体只跑一次 | 失败（`ReferenceError` 对照） |
| `missing-export` | 链接期缺失导出检查 | 失败（`SyntaxError` 对照） |
| `assign-import` | 对导入绑定赋值 | 失败（`TypeError` 对照） |

## 测试

`npm test`（`test/run.js`）：

1. **预言机对照**：每个样例在隔离子进程中跑两遍——一遍用本解释器 CLI，
   一遍用真实 Node 动态导入同一批原始文件——比对结果值或错误类别
   （`ReferenceError`/`TypeError`/`SyntaxError`），并校验初始化顺序与
   “失败模块体只执行一次”。
2. **单元测试**：6 模块上限、语法拒绝表、函数提升、TDZ、const 赋值、
   导入绑定赋值、菱形只执行一次、失败记录传播、调用非函数等。

## Docker / Compose

```sh
docker compose up --build     # 模块目录以只读方式挂载进工具容器
```

`docker-compose.yml` 将 `./samples/live` 以 `:ro` 挂载到容器的 `/modules`，
解释器只读该目录。换其他模块目录：修改 `volumes` 的宿主机路径与 `command`
参数即可。
