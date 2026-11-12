# 私有开发、私有构建与对应源码发布规范

## 必须保持的边界

- 开发仓库、构建仓库保持私有；公开仓库名为 `desktop-source-archive`，只接收审查过的源码快照，不复制私有 Git 历史。
- “精简”只移除生产配置、真实联系资源、缓存和内部运维记录。通用接口、登录、聚合、主题、插件、会话、手机连接等完整功能实现及必要构建输入保留；不是另做功能残缺的开源替代品。
- 开源默认不预置运营线路和联系方式。需要远程服务的功能由部署者自行配置；未配置不静默连接原运营方，不等于删掉功能源码。
- **以后每个含受 AGPL 约束实现的发行版本，都必须提供该版本的完整对应源码。** 不能只公开一次旧版或精简功能代码，然后把后续改动全部闭源发行。
- 保留 LICENSE、第三方许可/署名、可复现构建说明及准确源码入口。环境配置不能藏匿额外功能代码；非秘密构建参数是否属于对应源码范围需单独核查。

公开内容包括通用实现、配置格式、占位示例、脚本、测试和必要资源。生产域名/IP/服务器目录、联系人及二维码、部署凭证、账号数据、签名私钥、内部运维记录不进入公开快照。

实际软件访问运营服务时，地址仍可能从安装包或网络请求识别；配置分离不等于接口隐身，也不能代替服务端认证、授权、限流和审计。所有 `VITE_*` 配置都会进入前端产物，绝不能放 API 密钥、登录令牌或签名私钥。

## 九项部署配置

私有 `.release.local.json` 的 `deployment` 对象仅接受以下九个键，**每个键必须显式提供字符串**；联系方式可用 `[]` 或空字符串关闭。不要把该文件提交或上传为源码。

| 配置键 | 用途与格式 |
| --- | --- |
| `GAOGE_DEFAULT_API_BASE_URL` | 后端账户/余额默认 API 基址；会话中明确保存的服务地址优先。正式发布需真实 HTTPS 地址。 |
| `GAOGE_ACCOUNT_RELAY_URL` | 账户令牌允许访问的可信手机中继地址；HTTPS/443，可带干净路径前缀。任意用户地址不会自动变为可信。 |
| `GAOGE_MOBILE_COMPONENT_MANIFEST_URL` | 手机组件 JSON 清单完整地址，必须在专用目录；实际下载继续检查同源/目录、签名及哈希。 |
| `VITE_GAOGE_CODEX_RELAY_ORIGINS` | 可信第一方线路 origin，逗号分隔；只有协议、主机和默认端口，不带 API 路径。 |
| `VITE_GAOGE_MOBILE_RELAY_URL` | 前端手机中继默认值，必须与后端 `GAOGE_ACCOUNT_RELAY_URL` 一致。 |
| `VITE_GAOGE_CONTACT_ITEMS` | JSON 数组文本；支持字符串字段 `id/title/content/description/icon/imageUrl`。无联系方式填 `[]`。 |
| `VITE_GAOGE_DESKTOP_EMAIL_DOMAIN` | 自动生成桌面注册邮箱所用域名；不是联系邮箱或凭据。公开缺省为占位域名。 |
| `VITE_GAOGE_SUPPORT_GROUP` | 可选支持群/支持说明字符串；空字符串不显示该项。 |
| `VITE_GAOGE_SUPPORT_QR_URL` | 可选支持二维码图片；空字符串关闭，或 HTTPS 图片 URL / PNG、WebP base64 data URL。 |

示意片段如下；合并进 `.release.local.example.json` 的完整结构，不替换其他发布字段：

```json
{
  "deployment": {
    "GAOGE_DEFAULT_API_BASE_URL": "https://api.example.invalid/api/v1",
    "GAOGE_ACCOUNT_RELAY_URL": "https://relay.example.invalid/mobile",
    "GAOGE_MOBILE_COMPONENT_MANIFEST_URL": "https://downloads.example.invalid/mobile-components/stable.json",
    "VITE_GAOGE_CODEX_RELAY_ORIGINS": "https://api.example.invalid,https://backup.example.invalid",
    "VITE_GAOGE_MOBILE_RELAY_URL": "https://relay.example.invalid/mobile",
    "VITE_GAOGE_CONTACT_ITEMS": "[]",
    "VITE_GAOGE_DESKTOP_EMAIL_DOMAIN": "desktop.example.invalid",
    "VITE_GAOGE_SUPPORT_GROUP": "",
    "VITE_GAOGE_SUPPORT_QR_URL": ""
  }
}
```

这些均为占位地址，正式 `validate` 会拒绝，需在私有文件填部署者自己的实际配置。发布校验拒绝未知键、控制字符、不安全 URL、不一致中继和超长值；单字段不得超过 47,000 UTF-8 字节，较大图片应自行托管。其他既有配置仍单独保留：`bootstrapConfigUrls`、`buildRepo/buildBranch/sourceBranch`、`sshHosts`、`updateMirrors`；九项配置不取代它们。

## 本地开发和 CI

- 本地根目录 `.env.local` 应被 Git 忽略，不进入源码导出。Vite 读取所需 `VITE_*` 字段；Rust 构建脚本只读取三个 `GAOGE_*` 后端键，不把整份环境或任意秘密嵌入程序。
- Rust 进程环境优先，**显式空值也覆盖本地值**。只在缺少该进程变量时回退到 `.env.local`；无文件、无变量时编译为空配置。
- Rust 本地解析采用简单 dotenv：每行 `KEY=VALUE`，支持整行注释、可选 `export `、CRLF、首部 BOM 和配对单/双引号；不做插值/转义，不支持多行或行尾注释。选中键重复、控制字符会失败。此规则只描述 Rust 后端解析，不替代 Vite 自身 dotenv 行为。
- `CI` 或 `GITHUB_ACTIONS` 环境变量只要存在，Rust 就不读取 `.env.local`，包括值为空或 `false`。CI 必须通过进程环境显式传值。
- `scripts/deployment-config.mjs sync` 将九项值写入**私有构建仓库** GitHub Actions variables；`.github/workflows/release-build.yml` 将对应 `vars` 映射到构建环境。它们是部署元数据，不是秘密保险箱。令牌、签名私钥等继续使用 Actions secrets，不属于该九项。
- 同步脚本把值通过 stdin 传给 `gh`，不回显值；不要手动把私有配置打印到日志。CLI `sync` 并不替代仓库可见性审查，操作前确认目标是自己的私有构建库。
- 一键发布另外同步引导目录、更新基址、最低版本等原有变量；本地 `.env.local` 不会自动等同于 `.release.local.json`，维护者应核对二者。

在项目根目录执行，仓库名为示例占位：

```powershell
# 仅检查 deployment 九项；不修改远程
node scripts/deployment-config.mjs validate .release.local.json

# 写入已确认的私有构建仓库变量；不会构建或发布安装包
node scripts/deployment-config.mjs sync .release.local.json OWNER/private-build
```

## 每次正式更新

1. 私有开发库完成修改并测试；确保发行只包含确认过的改动。
2. 明确新版本和不可变标签，保持 package/npm lock/Cargo/Tauri 版本一致；`package.json` 的 `sourceReleaseTag` 与本次标签匹配。不可重用或覆盖旧标签、包和校验文件。
3. 清理生产配置与联系资源，校验九项私有部署配置；执行前端类型检查、测试和受影响的 Rust/Python 回归，覆盖无配置、登录、余额、聚合、手机组件和更新。
4. 提交确认源码，从固定 commit 导出；隐私、许可、素材、必要输入、文件哈希全部通过。不能把 review/development/privacy-maintenance 当正式发行源码。
5. 将**同一份**正式导出目录同步到公开源码库与私有构建库；包含两个 metadata JSON，Git tree 必须一致。不要只改公开副本，也不要把私有开发历史推公开。
6. 公开标签先完成匿名逐文件验收。私有构建注入部署变量和签名秘密，只构建/打包，不把值写回源码。
7. 验证各系统安装包、签名及旧版自动更新路径，成功后才提升更新清单。保存私有验收记录，不记录密钥。
8. 每次新发行重复上述流程，为该版本提供准确完整对应源码，不能以当前开源分支替代所有将来的版本。

以下 `1.7.2` **仅为未来新版本的语法示例**，不是本次提版或发布授权。命令会执行实际发布操作，先完成上面的源码公开、权限及配置检查：

```powershell
# 读取根目录 .release.local.json；正式发布，不是 dry-run
.\scripts\one-click-release.ps1 -Version 1.7.2 -MinimumVersion 0.0.0 -ReleaseTag v1.7.2 -PublicSourceRepository OWNER/desktop-source-archive -KeepBuildPrivate
```

`one-click-release.ps1` 没有任意配置路径或跳过源码门禁参数。其流程会验证公开源码，校验/同步私有构建部署变量并核对公开树与实际构建树。若某次修订确需 `vX.Y.Z-build.N`，应使用新的不可变标签并先同步 `sourceReleaseTag`；不覆盖现有 `v1.7.1-build.2`。

## 未发行源码和本次隐私维护

`SOURCE_MANIFEST.json` / `SOURCE_EXPORT_REPORT.json` 的 `publicationKind` 区分用途；`releaseReady` 仅在报告 `SOURCE_EXPORT_REPORT.json` 中，不能只看 package version：

| 类型 | `releaseReady` | 可用于什么 |
| --- | --- | --- |
| `release-source` | 全部门禁通过时为 `true` | 正式发行候选；仍需匿名公开验收和构建同树检查。 |
| `review-only` | `false` | 本地审查，不能上传为已批准公开源码。 |
| `development-snapshot` | `false` | 经过内容门禁的未发行开发快照；不是任何现有安装包对应源码。历史单次素材决定不能自动授权它。 |
| `privacy-maintenance` | `false` | 仅对固定既有公开 1.7.1 基准做隐私维护；不是新版本、安装包源码替换或更新发布许可。 |

未发行开发和隐私维护要求完整固定 Git commit，不接受 `HEAD`、分支、working-tree 或 review 混用。`publication_mode` 未通过是刻意阻止二进制发布；其他内容门禁必须通过，不能手改 report 的布尔值。

```powershell
$commit = (git rev-parse HEAD).Trim()

# 普通开发快照：需独立权利审查；当前保留的50项历史披露会阻止此模式
python scripts/export_public_source.py --ref $commit --development-snapshot --output-directory release/development-source

# 本次范围受限的隐私维护：baseline是完整、已核验的旧公开快照目录，不是Git仓库
python scripts/export_public_source.py --ref $commit --privacy-maintenance-baseline release/verified-public-1.7.1-baseline --output-directory release/privacy-maintenance-source
```

上述是互斥的两种流程，不是先后步骤；输出目录必须不存在。维护模式只接受代码中固定的旧公开 commit/tree，校验全部文件、两个 metadata 和哈希，并要求 50 项历史素材/披露、audit、原决定证据、许可证和署名字节保持不变。它生成 `PRIVACY_MAINTENANCE.md` 和 `maintenanceBaseline`，不修改旧决定，不产生新的第三方许可，也不授权后续版本。普通开发模式生成 `DEVELOPMENT_SNAPSHOT.md`。这些模式均不能通过正式发行验收。

## 仓库改名和历史保留

公开仓库新名为 `desktop-source-archive`，不改变私有开发/构建库及应用 identifier。源码入口、许可入口和后续发布参数同步新名；验证旧入口跳转有效，严格验收使用新直达地址。

旧 `v1.7.1-build.2` 标签、源码 ZIP、二进制和校验文件保持原样。清理当前分支不等于清理历史，已被下载或缓存的内容不能保证撤回。历史重写、附件删除或撤回既有源码必须单独审查。本次不提版、不覆盖安装包、不提升更新清单。

## 参考与限制

- GNU AGPL v3 对应源码及第 6、13 条：https://www.gnu.org/licenses/agpl-3.0.en.html
- GitHub 仓库改名：https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
- GitHub 历史敏感数据清理限制：https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository

本说明是工程发布规范，不表示所有历史素材权利或所有许可问题已经获法律确认。
