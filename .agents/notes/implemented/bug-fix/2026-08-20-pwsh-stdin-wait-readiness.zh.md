# Agent Note: pwsh 方言就绪不采用线程级 stdin 等待

Status: implemented

[英文](2026-08-20-pwsh-stdin-wait-readiness.md) | 中文

## Problem

Linux 终端检查器会在前台进程组的任一成员线程阻塞于 stdin 时，报告该进程组正在等待输入。bash 方言就绪策略可以在写入前状态转换后使用这个事实，但 `pwsh` 方言会话会在另一个线程仍执行已提交命令时，让控制台读取线程持续阻塞于 stdin。把读取线程视为命令完成，可能会在输出或受控提示符到达前结算 send，向上层暴露空 viewport、PSReadLine 输入回显或不完整的持久工具标记捕获。

PSReadLine 还可能发出标准 `CSI 6n` 光标位置请求，并在终端应答前等待，不渲染初始提示符也不接受 bootstrap 输入。逐行终端 sanitizer 过去会移除该请求但不作应答。在覆盖率或慢速 PTY 环境下，提示符 bootstrap 可能被当作设备输入消耗；其回显源码又包含受控提示符字面量，可能被误判为就绪。持久 PowerShell 工具的第二层提示符存在相同的所有权问题：私有提示符尚未安装时，shell 可能在静默结算后被发布。

并非所有终端提供方都会串行化写入。如果后端不拥有顺序，远程终端应答可能与当前用户写入或后续 send 重叠。仍在进行的应答还会使输出静默证据失效；如果每次空启动观察都重置整段 send 超时，提示符安装也就没有统一的绝对上限。

## Decision

`LocalPtySession` 只为 `bash` 方言接受 Linux syscall 级 stdin 等待证据。`pwsh` 方言通过受控 OSC 标记及精确可打印提示符、有界输出静默、超时或 shell 退出完成。进程检查器继续报告相同的底层进程组事实；方言语义仍由拥有命令就绪判定的终端后端负责。

sanitizer 只报告确切的 `CSI 6n` 请求。`pwsh` 方言的 `LocalPtySession` 用固定逻辑位置 `CSI 1;1R` 逐个应答；这个逐行后端不模拟屏幕网格。未完成控制序列的 carry 使用独立于可打印输出读取上限的有界存储。应答写入排在已经进行的提供方写入之后、后续输入之前；应答未完成时不能结算就绪，也不能释放 send 槽。应答写入失败会使终端传输失败，close 开始后则不再发起新应答。

PowerShell 启动先通过 `LocalPtySession.initialize()` 捕获初始交互输出，其中包括可见的光标位置交换；随后只提交一次 UTF-8 与受控提示符 bootstrap。静默结算后的后续操作都是空观察；只有自有 marker 或占据完整行尾的受控提示符才能发布会话。所有观察共用一个现有 `timeoutMs` deadline。持久 PowerShell 工具同样要先在当前 viewport 或保留的 scrollback 尾部观察到私有提示符，才能向第一条包装命令发布 shell。

bash 现有的写入前等待转换规则保持不变。`pwsh` 方言不新增配置开关或线程身份启发式：两者都无法把一个读取线程的 syscall 转化为求值线程已完成的证据。

## Alternatives considered

**选择一个推定的 PowerShell evaluator 线程。** .NET 不会通过进程表公开稳定的 evaluator 线程身份，而 syscall 快照无法证明哪个线程拥有命令完成状态。

**通过 PowerShell 配置开关保留精确档。** 可调项会把不可靠的结果变成运维者选择。提示符与静默就绪已经覆盖没有 syscall 检查的平台上的 PowerShell。

**为所有方言禁用 Linux stdin 检查。** 拒绝，因为 bash 方言策略保留了由现有 shell 与前台子进程测试覆盖的低延迟精确就绪；已观察到的无效推断发生在配置的 shell 方言为 `pwsh` 时。

**提高静默阈值、在 bootstrap 前等待固定时间或重复提交 setup。** 时序调整只能降低竞态概率，重复提交还可能多次安装相同 bootstrap；这些方案都不能确定下一条命令属于哪个提示符。

**接受包含受控提示符字面量的任意输出。** PSReadLine 会回显提交的 setup 源码，初始提示符也可能因 cwd 带有相同后缀。只有私有 marker 或完整的受控提示符行尾才是完成证据。

**增加完整终端模拟器。** 后端提供逐行输出，而不是光标寻址的屏幕状态。固定逻辑位置应答已能满足 PSReadLine，无需引入未使用的屏幕模型。

## Consequences

`pwsh` 方言 send 无法再从并发读取线程的等待状态完成，启动流程也不能因 setup 源码回显或尚未安装的提示符而发布。光标应答、用户写入、取消、超时和 close 在异步提供方上仍由同一个 send 所有者约束。使用受控后端提示符的原始 `pwsh` 方言会话仍通过 marker 快路径结算；不同的提示符使用有界静默档。bash 方言精确就绪与底层检查器保持不变。确定性的 fake-terminal 测试覆盖拆分及重复光标请求、写入排序、失败与 teardown、单次提示符安装和私有提示符握手；在可执行文件可用时，真实 PowerShell 套件覆盖输出、状态、UTF-8 编码与持久工具提取。
