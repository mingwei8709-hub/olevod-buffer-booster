# 欧乐影院缓冲增强 v2.4.0：Chrome 安装与验证指南

## 1. 文件与适用范围

- 脚本文件：`olevod-buffer-booster.user.js`
- 脚本名称：`欧乐影院 HLS 缓冲增强`
- 版本：`2.4.0`
- 生效页面：`https://www.olevod.com/player/*`
- 默认目标缓冲：180 秒
- 默认脚本并发：3 路

> 本脚本只改善客户端预载与内存复用，不能提高目标服务器本身的速度，也不会绕过登录、VIP、DRM 或其他访问限制。

## 2. 安装 Tampermonkey

1. 打开 Chrome 网上应用店。
2. 搜索并安装 **Tampermonkey**。
3. 安装完成后，将 Tampermonkey 固定到 Chrome 工具栏。
4. 打开 Tampermonkey 设置，确认扩展已启用，并允许它在 `olevod.com` 上运行。

## 3. 添加 v2.4.0 脚本

### 方法一：从 GitHub 直接安装（推荐）

1. 确认 Chrome 已安装并启用 Tampermonkey。
2. 打开脚本直链：
   `https://raw.githubusercontent.com/mingwei8709-hub/olevod-buffer-booster/main/olevod-buffer-booster.user.js`
3. Tampermonkey 会显示安装确认页。
4. 检查名称和版本后，点击 **安装**。

如果浏览器只显示源码，没有弹出安装页，请使用下面的手动方法。

### 方法二：手动添加

1. 点击 Chrome 工具栏中的 Tampermonkey 图标。
2. 选择 **管理面板**。
3. 点击右上角的 **加号/添加新脚本**。
4. 删除编辑器中的默认模板。
5. 从 GitHub 下载或打开 `olevod-buffer-booster.user.js`。
6. 全选脚本内容并复制到 Tampermonkey 编辑器。
7. 按 `Ctrl+S` 保存。
8. 在 Tampermonkey 管理面板确认脚本版本显示为 `2.4.0`，状态为已启用。

### 避免脚本冲突

如果已经安装其他针对同一网站的 HLS 缓冲、视频预载或分片下载脚本，请先暂时禁用。多个脚本同时修改播放器或重复预载相同分片，可能导致重复请求、内存增加或播放异常。

## 4. 启动脚本

1. 确认 Tampermonkey 中没有启用功能重复的视频缓冲脚本。
2. 打开任意欧乐影院播放页面，例如：`https://www.olevod.com/player/...`。
3. 按 `Ctrl+Shift+R` 强制刷新页面。
4. 开始播放视频。
5. 页面右下角应出现 `Olevod buffer` 状态条。

脚本不需要额外点击“启动”。只要脚本已启用并进入匹配的播放页面，它会自动运行。

## 5. 状态条说明

正常运行时会看到类似内容：

```text
Olevod buffer: active | ahead 75s / 180s | current 18 | prefetch 3/3 [22,23,24] | memory 4 [19,20,21,25] | hits 12
```

字段含义：

| 字段 | 含义 | 正常表现 |
|---|---|---|
| `active` | HLS 缓冲配置已注入 | 应显示 `active` |
| `ahead` | 当前播放点之后已经可播放的秒数 | 播放时波动，暂停后通常上升 |
| `current` | 脚本判断的当前分片编号 | 应随播放进度增加 |
| `prefetch 3/3` | 脚本正在执行的预载数量/上限 | 网络较慢时通常为 `3/3` |
| `[22,23,24]` | 当前正在预载的分片编号 | 通常位于当前分片之后 |
| `memory` | 已完整下载并保存在内存中的分片数 | 应随预载完成而变化 |
| `hits` | 播放器直接使用内存分片的累计次数 | 正常播放一段时间后应持续增加 |
| `failed` | 预载失败次数 | 持续增加表示服务器、CORS 或网络异常 |

把鼠标停在状态条上，可以看到：

- 当前预载说明；
- `loader patched true/false`；
- 内存占用；
- 已取消的落后请求数量。

`loader patched true` 表示播放器的数据加载器已接入内存缓存，这是 v2.4.0 的关键状态。

## 6. 用 Console 确认脚本启动

1. 按 `F12` 或 `Ctrl+Shift+I` 打开开发者工具。
2. 切换到 **Console**。
3. 在过滤框输入：`Olevod Buffer`。
4. 正常情况下应看到：

```text
[Olevod Buffer] Hls.DefaultConfig patched.
```

还可以在 Console 中输入以下命令读取状态条：

```js
document.getElementById('olevod-buffer-booster-status')?.textContent
```

如果 Chrome 阻止粘贴，请先阅读提示并手动输入 `allow pasting`；只粘贴自己已经检查过的代码。

## 7. 用 Network 确认三路预载

1. 打开开发者工具的 **Network** 面板。
2. 勾选 **Preserve log** 可保留跳转前后的请求。
3. 在过滤框输入：`seg-`。
4. 观察名称类似 `seg-15-v1-a1.ts` 的分片请求。
5. 脚本预载通常显示为：
   - `Type`：`fetch`；
   - `Initiator`：Tampermonkey 的 `userscript.html...`。
6. 播放器自身请求通常显示为：
   - `Type`：`xhr` 或 `xmlhttprequest`；
   - `Initiator`：网站播放器脚本。

正常情况下：

- 同时存在最多 3 个脚本 `fetch` 请求；
- 预载编号位于当前分片之后；
- 状态条中的 `hits` 持续增加；
- 已通过内存命中的分片不应再出现一次完整的播放器 `XHR` 下载。

> Network 列表按完成时间显示时，分片编号看起来可能跳跃。判断顺序时应结合状态条中的 `current`、`prefetch` 和 `memory`，不要只看列表行顺序。

## 8. 功能正常检查清单

满足以下项目即可认为脚本基本正常：

- [ ] Tampermonkey 中版本为 `2.4.0` 且已启用。
- [ ] 其他欧乐缓冲脚本已禁用。
- [ ] 播放页右下角出现状态条。
- [ ] 状态为 `Olevod buffer: active`。
- [ ] 悬停显示 `loader patched true`。
- [ ] `prefetch` 在网络较慢时能达到 `3/3`。
- [ ] 正在预载的编号位于 `current` 之后。
- [ ] `memory` 会出现大于 0 的数值。
- [ ] 播放一段时间后 `hits` 持续增加。
- [ ] 拖动进度后，预载编号重新定位到新播放位置之后。
- [ ] 切换剧集后，旧剧集请求不再继续增加。

## 9. 常见问题

### 状态条没有出现

- 检查脚本是否启用；
- 检查网址是否以 `https://www.olevod.com/player/` 开头；
- 禁用重复或旧版欧乐脚本；
- 按 `Ctrl+Shift+R` 强制刷新；
- 检查 Tampermonkey 是否有权访问当前网站。

### 一直显示 `waiting`

- 等待播放器初始化并开始播放；
- 刷新页面重新注入；
- 查看 Console 是否有脚本语法错误；
- 如果当前视频不是 HLS/M3U8，脚本可能无法工作。

### `prefetch 0/3`

- 播放几秒，让脚本取得 M3U8 清单和当前分片；
- 查看 Network 中是否出现 `.m3u8` 和 `seg-*.ts`；
- 将鼠标停在状态条上查看失败原因。

### `failed` 持续增加

- 目标服务器可能超时、限流或拒绝跨域请求；
- 暂停播放，让已开始的请求完成；
- 刷新后重试；
- 并发只能缓解慢服务器，不能保证服务器一定返回数据。

### 仍然卡顿

- 查看 `ahead`：低于一个分片时仍可能卡顿；
- 暂停几十秒，让缓冲先积累；
- 如果三个请求都需要很长时间，瓶颈在目标服务器；
- 更高并发可能有帮助，也可能触发限流，不建议盲目提高；
- 最稳定的替代方案是使用合法的本地下载/缓存后播放。

### Console 中出现 message channel 错误

类似下面的错误通常来自其他 Chrome 扩展，不一定与本脚本有关：

```text
A listener indicated an asynchronous response by returning true, but the message channel closed...
```

判断本脚本是否正常，应优先看状态条、`Olevod Buffer` 日志及 Network 分片请求。

## 10. 停用或卸载

如果 v2.4.0 影响播放：

1. 打开 Tampermonkey 管理面板。
2. 找到 `欧乐影院 HLS 缓冲增强`。
3. 关闭脚本开关，或点击删除。
4. 返回播放页并按 `Ctrl+Shift+R`。
5. 如果问题仍存在，再检查其他扩展、网络线路或目标服务器状态。


