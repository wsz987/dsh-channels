# AI Coding Agent Desktop & Registry 设计方案

> **v2（2026-09-06）**：新增 DeepSeek Harness（dsh）对接设计，对齐官方 [dsh-v0.1.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1)。v1 的 Codex 分发设计全部保留并泛化为多 Agent 模型；dsh 对接专章见 §52–§63。
>
> ⚠️ **版本时效声明（2026-09-12）**：本文是 2026-09-06 的**设计快照**，文中所有 `dsh-v0.1.2-rc.1` / `0.1.1-rc.2` 引用均为**当时的历史证据标签**，不是当前基线。
> 当前实际基线是 **DeepSeek Harness `0.1.5-rc.2`**（位于 npm `next` 标签；`latest` 仍是 `0.1.5-rc.1`），权威来源见
> [`docs/harness-0.5.x-migration-plan.md`](harness-0.5.x-migration-plan.md) 与
> [`docs/compatibility-matrix.md`](compatibility-matrix.md)。设计结论（分发模型、注册表、Skill 治理）
> 与具体 Harness 版本号无关，仍然有效；涉及具体 API/字段时以当前基线文档为准。

## 1. 项目定位

本项目不是简单的「CC Switch + Codex 安装器」，而是一个面向国内受限网络环境的：

> **AI Coding Agent Distribution Platform**

核心目标：

- 用户无需访问 GitHub、npm、Microsoft Store 等外部服务
- 用户无需自行安装 Node.js、npm、Git
- 一键安装和维护 Codex
- 一键安装和维护 DeepSeek Harness（dsh，官方 npm 分发的 CLI/Host），对齐 dsh-v0.1.2-rc.1 规范
- 服务器统一维护经过验证的 Skill
- 用户通过客户端搜索、安装、更新 Skill
- Skill 支持全局仓库 + 项目级启用
- Provider 支持 API URL、API Key、Model 等配置
- 服务端通过 Docker 部署，便于自建和维护
- 首发支持双 Agent：Codex + DeepSeek Harness（dsh）
- 后续可以扩展 Claude Code、Gemini CLI、OpenCode 等 Agent

---

# 2. 核心设计结论

## Desktop

推荐：

```text
Tauri 2
  +
React
  +
TypeScript
  +
Rust
```

不建议：

```text
Tauri
  ↓
Node.js
  ↓
npm
  ↓
Codex
```

最终用户**不需要安装 Node.js**。

Codex 使用官方 standalone binary，由客户端从自己的 Registry/CDN 下载、校验和管理。

DeepSeek Harness（dsh）没有官方 standalone binary：官方通过 npm 分发（`@deepseek-ai/dsh`），依赖 Node.js ≥ 22。因此 dsh 走「Runtime Pack」分发——客户端下载平台预先构建的「便携 Node.js 运行时 + dsh 依赖闭包」，最终用户依然不需要自己安装 Node.js。详见 §54。

---

## Server

推荐：

```text
Node.js
TypeScript
Fastify
PostgreSQL
S3 / OSS / COS
Docker
Docker Compose
```

服务端职责：

```text
Registry API
Skill Registry
Agent Release Registry（Codex / dsh）
Manifest
Provider Template
Artifact Metadata
Admin API
```

大文件不经过 API，统一走：

```text
CDN / OSS / COS
```

---

# 3. 总体架构

```text
                         ┌──────────────────────┐
                         │       Admin Web      │
                         │                      │
                         │ Skill 管理           │
                         │ Codex 版本管理       │
                         │ Release 管理         │
                         │ Provider 模板         │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │    Registry API      │
                         │                      │
                         │ Auth                 │
                         │ Manifest             │
                         │ Skill Registry       │
                         │ Agent Registry       │
                         │ Provider Registry    │
                         └──────────┬───────────┘
                                    │
                         ┌──────────┴───────────┐
                         │                      │
                         ▼                      ▼
                 ┌──────────────┐       ┌──────────────┐
                 │ PostgreSQL   │       │ Object Store │
                 │              │       │              │
                 │ Metadata     │       │ Skills       │
                 │ Versions     │       │ Codex        │
                 │ Users        │       │ Packages     │
                 └──────────────┘       └──────┬───────┘
                                               │
                                               ▼
                                              CDN
                                               │
                                               │ HTTPS
                                               ▼
                                  ┌──────────────────────┐
                                  │     Desktop App      │
                                  │       Tauri 2        │
                                  ├──────────────────────┤
                                  │ Codex Manager        │
                                  │ dsh Manager          │
                                  │ Skill Manager        │
                                  │ Provider Manager     │
                                  │ Project Manager      │
                                  │ Download Manager     │
                                  └──────────┬───────────┘
                                             │
                                             ▼
                                     Codex / dsh
                                             │
                                             ▼
                                      User's API Provider
```

---

# 4. Server 与 Desktop 的职责边界

## Server 负责

```text
发现
版本
元数据
发布
审核
下载地址
SHA256
Skill
Codex Release
dsh Release（Runtime Pack）
Provider Template
```

## Desktop 负责

```text
安装
卸载
升级
降级
文件操作
Skill 本地管理
Project 管理
Provider 配置
API Key 本地保存
启动 Codex / dsh
```

Server **不要直接管理用户机器上的 Codex 进程**。

---

# 5. 为什么不依赖 CC Switch

CC Switch 可以作为设计参考，也可以考虑未来兼容它的数据和 Skill 目录。

但不建议：

```text
YourApp
   ↓
CC Switch
   ↓
Codex
```

也不建议 Fork CC Switch 后把整个产品建立在它上面。

原因：

1. 产品目标不同
2. 需要自己的 Skill Registry
3. 需要自己的 Codex Distribution
4. 需要自己的 Provider/Project 模型
5. 未来需要企业私有 Skill
6. 需要完全控制版本和发布流程

建议：

```text
YourApp
├── CodexManager
├── SkillManager
├── ProviderManager
└── ProjectManager
```

同时兼容标准 Codex Skill 目录。

---

# 6. Codex 分发

用户不需要：

```text
Node.js
npm
Git
GitHub
Microsoft Store
```

客户端第一次启动：

```text
检测 Codex
    ↓
未安装
    ↓
查询 Registry
    ↓
获取最新版本
    ↓
从 CDN 下载
    ↓
SHA256 校验
    ↓
安装
```

服务器维护：

```text
codex/
├── windows-x64/
│   ├── 0.152.0/
│   └── 0.153.0/
├── macos-x64/
└── macos-arm64/
```

建议保留官方原始发行物，不修改 Codex binary。

---

# 7. Codex 本地目录

不建议把 Codex 强制安装到系统 PATH。

建议由 Desktop 自己管理：

```text
YourApp/
├── bin/
│   └── codex/
│       └── 0.153.0/
│           └── codex.exe
│
├── skills/
├── config/
├── cache/
└── logs/
```

优点：

- 不污染用户 PATH
- 不影响用户已有 Codex
- 支持多个 Codex 版本
- 支持回滚
- 支持离线安装
- 支持企业环境

---

# 8. Skill 架构

Skill 不应该简单理解为：

```text
下载
  ↓
~/.codex/skills
```

推荐三级模型：

```text
Server Skill Registry
        ↓
Local Skill Store
        ↓
Project Enabled Skills
        ↓
Codex
```

---

# 9. Skill 的三个概念

## 9.1 Skill Registry

服务器提供：

```text
frontend-design
code-review
typescript
github-pr
react-best-practices
```

这是：

> 可下载的 Skill。

---

## 9.2 Local Skill Store

用户下载后：

```text
YourApp/
└── skills/
    ├── frontend-design/
    ├── code-review/
    └── typescript/
```

这是：

> 用户已经拥有的 Skill。

---

## 9.3 Project Enabled Skills

项目 A：

```text
project-a

frontend-design
typescript
react-best-practices
```

项目 B：

```text
project-b

code-review
github-pr
```

这是：

> 当前项目实际使用的 Skill。

---

# 10. Skill 最终模型

推荐：

> **仓库全局，启用项目化。**

即：

```text
Server Registry
      ↓
Local Skill Store
      ↓
Project Skill Set
      ↓
Codex
```

不要默认把所有 Skill 都复制到：

```text
~/.codex/skills
```

否则用户安装几十、上百个 Skill 后会越来越混乱。

---

# 11. Skill 包结构

一个 Skill：

```text
frontend-design/
├── SKILL.md
├── skill.json
├── scripts/
├── references/
└── assets/
```

`skill.json` 示例：

```json
{
  "schemaVersion": 1,
  "id": "frontend-design",
  "name": "Frontend Design",
  "version": "2.3.0",
  "description": "Frontend UI design skill",
  "targets": [
    "codex"
  ],
  "requirements": {
    "codex": ">=0.150.0"
  }
}
```

---

# 12. Skill 版本管理

服务器：

```text
frontend-design/
├── 1.0.0/
├── 1.1.0/
└── 2.3.0/
```

数据库：

```text
skill_versions

id
skill_id
version
manifest
artifact_id
sha256
size
status
created_at
```

状态：

```text
Draft
Published
Deprecated
```

---

# 13. Skill 发布流程

不能直接：

```text
上传 ZIP
 ↓
上线
```

推荐：

```text
上传
 ↓
解析 SKILL.md
 ↓
解析 skill.json
 ↓
结构校验
 ↓
计算 SHA256
 ↓
兼容性检查
 ↓
安全扫描
 ↓
Draft
 ↓
管理员 Publish
 ↓
CDN
```

这样方便维护大量 Skill。

---

# 14. Skill Registry API

核心 API：

```http
GET /api/v1/manifest

GET /api/v1/skills
GET /api/v1/skills/:slug
GET /api/v1/skills/:slug/versions
GET /api/v1/skills/:slug/versions/:version

GET /api/v1/skills?q=frontend
```

单个版本返回：

```json
{
  "id": "frontend-design",
  "version": "2.3.0",
  "sha256": "abc123...",
  "size": 183721,
  "downloadUrl": "https://cdn.example.com/..."
}
```

API 不传大文件。

---

# 15. Artifact 模型

建议统一 Artifact Registry。

```text
artifacts

Codex
├── windows-x64
├── macos-x64
└── macos-arm64

Skills
├── frontend-design
├── code-review
└── typescript
```

以后可以继续加入：

```text
MCP
Templates
Extensions
Runtime
```

因此不要把服务器设计死成：

```text
Skill Server
```

而是：

```text
Agent / Artifact Registry
```

---

# 16. Manifest

客户端启动时只需要拉一个 Manifest：

```http
GET /api/v1/manifest
```

示例：

```json
{
  "schemaVersion": 2,

  "client": {
    "latest": "1.2.0"
  },

  "agents": {
    "codex": {
      "latest": "0.153.0"
    },
    "dsh": {
      "latest": "0.1.2-rc.1",
      "prerelease": true
    }
  },

  "runtimes": {
    "node": {
      "lts": "22.x"
    }
  },

  "skills": {
    "frontend-design": "2.3.0",
    "code-review": "1.4.0",
    "typescript": "3.1.0"
  }
}
```

> dsh 的 `latest` 是平台验证过的 testedVersion，不是 npm dist-tag；`prerelease: true` 的版本默认不进稳定轨，用户显式切换「rc 轨道」后才可见（§53、§54）。Node 运行时版本线独立于 dsh 版本（§54）。

客户端：

```text
启动
 ↓
拉 Manifest
 ↓
本地版本比较
 ↓
显示更新
```

---

# 17. Provider 设计

Provider 不应该由服务器保存用户 API Key。

服务器保存：

> Provider Template。

例如：

```text
DeepSeek
Company API
OpenAI
Local Ollama
```

模板：

```json
{
  "id": "company-api",
  "name": "Company API",
  "baseUrl": "https://api.example.com/v1",
  "models": [
    "xxx",
    "yyy"
  ]
}
```

客户端再加：

```text
API Key
```

形成最终 Provider。

---

# 18. API Key 安全

API Key 不建议明文保存到普通配置文件。

Windows：

```text
Windows Credential Manager
```

macOS：

```text
Keychain
```

Linux：

```text
Secret Service / Keyring
```

Provider Template：

```text
baseUrl
model
protocol
```

用户 Secret：

```text
apiKey
```

两者分离。

---

# 19. Provider Profile

可以进一步抽象成 Profile：

```text
Profiles

公司开发
  Provider: Company API
  Skills: 12

开源项目
  Provider: DeepSeek
  Skills: 8

本地模型
  Provider: Ollama
  Skills: 4
```

Project 选择 Profile：

```text
Project
   ↓
Profile
   ├── Provider
   └── Skills
```

---

# 20. Project 配置

项目可以保存：

```text
.yourapp/
└── project.json
```

示例：

```json
{
  "provider": "company-api",
  "skills": [
    "frontend-design",
    "typescript",
    "code-review"
  ]
}
```

客户端：

```text
打开 Project
 ↓
读取 project.json
 ↓
解析 Skills
 ↓
同步 Codex
 ↓
启动 Codex
```

---

# 21. Server 数据库设计

推荐 PostgreSQL。

核心表：

```text
users
organizations

agents
agent_versions

skills
skill_versions

providers
provider_templates

projects

releases
artifacts
```

第一版如果暂时没有账号体系：

```text
organizations
users
```

可以先不启用。

`agents` 表增加分发形态字段（Codex 与 dsh 共用一张表）：

```text
distribution    binary | runtime-pack
upstream        github-release | npm
testedVersion   平台验证过的固定版本（禁止 dist-tag 寻址）
```

`agent_versions` 对 runtime-pack 形态（dsh）需要额外记录 Node 运行时版本依赖，以及依赖闭包 artifact 的 sha256（§54）。

---

# 22. 推荐数据库关系

```text
Organization
      │
      ├──────────────┐
      ▼              ▼
 Providers         Skills
      │              │
      │         Skill Versions
      │              │
      │              ▼
      │           Artifact
      │
      ▼
   Project
      │
      ├── Provider
      └── Skills
             │
             ▼
          Codex
```

---

# 23. 企业私有 Skill

后期建议支持 Namespace：

```text
official/frontend-design
official/code-review
official/typescript

company/internal-api
company/deploy

user/my-skill
```

这样可以实现：

```text
官方 Skill
+
团队 Skill
+
企业私有 Skill
```

---

# 24. Admin Web

服务端必须有管理后台。

首页：

```text
Dashboard

Codex
  最新版本：0.153.0

Skills
  36

Published
  28

Draft
  8
```

Skill 管理：

```text
Skills

Frontend Design       2.3.0   Published
Code Review           1.4.0   Published
TypeScript            3.1.0   Published
GitHub PR             2.0.1   Draft
```

支持：

```text
新增
编辑
上传版本
发布
下架
回滚
删除
```

---

# 25. Agent Release 管理

本节以 Codex 为例；dsh 的 Release 管理是双工件线（dsh 版本 + Node 运行时版本），见 §54、§62。

后台：

```text
Codex Releases

0.153.0
 ├── Windows x64
 ├── macOS x64
 └── macOS ARM64

0.152.0
 ├── Windows x64
 ├── macOS x64
 └── macOS ARM64
```

每个 Artifact：

```text
version
platform
arch
url
sha256
size
status
```

---

# 26. Object Storage

数据库不保存 Skill ZIP / Codex Binary。

推荐：

```text
S3
OSS
COS
```

国内部署可以：

```text
阿里云 OSS
+
阿里云 CDN
```

或者：

```text
腾讯云 COS
+
腾讯云 CDN
```

目录：

```text
bucket/
├── skills/
│   └── frontend-design/
│       ├── 1.0.0.zip
│       ├── 1.1.0.zip
│       └── 2.3.0.zip
│
├── codex/
│   └── 0.153.0/
│       ├── windows-x64.zip
│       ├── macos-x64.tar.gz
│       └── macos-arm64.tar.gz
│
├── dsh/
│   ├── 0.1.2-rc.1/
│   │   ├── runtime-win-x64.tar.gz        # dsh 依赖闭包（node_modules，服务端锁定构建）
│   │   ├── runtime-macos-x64.tar.gz
│   │   ├── runtime-macos-arm64.tar.gz
│   │   └── runtime-linux-x64.tar.gz
│   └── node/
│       └── 22.x/
│           ├── win-x64.tar.gz            # 便携 Node 运行时（独立版本线）
│           ├── macos-x64.tar.gz
│           └── macos-arm64.tar.gz
│
└── client/
    └── 1.2.0/
```

---

# 27. CDN

下载链路：

```text
Desktop
   ↓
Registry API
   ↓
获取 downloadUrl
   ↓
CDN
   ↓
OSS
```

不要：

```text
Desktop
   ↓
Registry API
   ↓
API Server
   ↓
读取 ZIP
   ↓
返回文件
```

否则 API Server 很容易成为带宽瓶颈。

---

# 28. Docker 部署

服务端推荐 Docker Compose。

```text
server/
├── docker-compose.yml
├── .env
├── api/
├── admin/
└── nginx/
```

核心服务：

```text
┌─────────────────────────────┐
│          Nginx              │
│        Reverse Proxy        │
└──────────────┬──────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
   Registry API      Admin Web
       │
       ▼
 PostgreSQL
```

如果 OSS/CDN 使用云服务：

```text
Docker Compose
├── nginx
├── api
├── admin
└── postgres
```

即可。

---

# 29. Docker Compose 示例

```yaml
services:

  api:
    image: your-registry-api:latest
    restart: unless-stopped
    env_file:
      - .env
    depends_on:
      postgres:
        condition: service_healthy

  admin:
    image: your-registry-admin:latest
    restart: unless-stopped

  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: registry
      POSTGRES_USER: registry
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U registry -d registry"]
      interval: 5s
      timeout: 5s
      retries: 10

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - api
      - admin

volumes:
  postgres_data:
```

---

# 30. 第一版不需要 Redis

第一版：

```text
Nginx
API
Admin
PostgreSQL
OSS/CDN
```

就够。

不要一开始：

```text
Redis
RabbitMQ
Kafka
Elasticsearch
MinIO
Kubernetes
```

全部堆进去。

只有出现实际需求再增加。

---

# 31. 如果需要本地对象存储

如果希望整个 Registry 可以自部署：

```text
Nginx
API
Admin
PostgreSQL
MinIO
```

Docker Compose：

```text
                 Nginx
                   │
          ┌────────┴────────┐
          ▼                 ▼
        Admin              API
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
               PostgreSQL          MinIO
```

这样可以完全私有化部署。

如果生产环境使用阿里云/腾讯云，则直接使用 OSS/COS + CDN，少维护一个 MinIO。

---

# 32. Docker 环境变量

`.env`：

```env
NODE_ENV=production

DATABASE_URL=postgresql://registry:password@postgres:5432/registry

JWT_SECRET=change-me

STORAGE_DRIVER=s3

S3_ENDPOINT=https://oss-cn-xxx.aliyuncs.com
S3_BUCKET=your-bucket
S3_ACCESS_KEY_ID=xxx
S3_SECRET_ACCESS_KEY=xxx

CDN_BASE_URL=https://cdn.example.com

REGISTRY_BASE_URL=https://registry.example.com
```

生产环境不要把真实 Secret 提交 Git。

---

# 33. Server API 分层

推荐：

```text
/api/v1/
├── manifest
│
├── agents
│   └── codex
│
├── skills
│
├── providers
│
├── projects
│
└── client
```

Admin：

```text
/api/admin/v1/
├── skills
├── skill-versions
├── releases
├── artifacts
├── providers
└── users
```

---

# 34. Client 更新

客户端自身也通过 Registry 更新：

```text
Client
 ↓
GET /api/v1/manifest
 ↓
发现新版本
 ↓
下载 Installer
 ↓
SHA256
 ↓
更新
```

因此服务器最终统一管理：

```text
Desktop
Codex
Skills
```

---

# 35. 离线安装包

必须考虑国内/企业网络环境。

提供：

```text
YourApp-Setup.exe
```

以及：

```text
YourApp-Offline-Bundle.exe
```

Offline Bundle 可以包含：

```text
Desktop
+
Codex
+
基础 Skills
```

用户完全断网也能完成首次安装。

有网络时：

```text
同步 Registry
 ↓
发现更新
 ↓
在线更新
```

---

# 36. 下载器设计

Desktop 需要独立 Download Manager：

```text
DownloadManager

download()
pause()
resume()
cancel()
verify()
install()
```

要求：

- HTTP Range 断点续传
- 下载进度
- 暂停/继续
- SHA256 校验
- 下载失败重试
- 临时文件
- 原子替换

下载流程：

```text
download.part
      ↓
SHA256
      ↓
校验成功
      ↓
rename
      ↓
install
```

避免下载一半损坏正式文件。

---

# 37. Desktop 模块

```text
src-tauri/
├── codex/
│   ├── manager.rs
│   ├── installer.rs
│   └── process.rs
│
├── dsh/
│   ├── manager.rs          # Runtime Pack 生命周期
│   ├── installer.rs        # 解包 / SHA256 / 原子替换
│   ├── profile.rs          # Profile 生成与 patch 整体替换
│   ├── credentials.rs      # Keyring ↔ dsh 凭据面物化
│   └── process.rs          # 交互 / web / headless 启动与输出解析
│
├── skills/
│   ├── manager.rs
│   ├── installer.rs
│   └── registry.rs
│
├── providers/
│   └── manager.rs
│
├── projects/
│   └── manager.rs
│
├── download/
│   └── manager.rs
│
└── security/
    └── credential.rs
```

React：

```text
src/
├── pages/
│   ├── dashboard/
│   ├── codex/
│   ├── skills/
│   ├── providers/
│   ├── projects/
│   └── settings/
│
├── components/
└── api/
```

---

# 38. Desktop 页面

一级导航：

```text
首页
Codex
Providers
Skills
Projects
设置
```

首页：

```text
环境状态

Codex       0.153.0 ✓
Skills      12
Provider    公司 API ✓

[开始使用 Codex]
```

---

# 39. Skill Marketplace

```text
Skills

[市场] [已安装]

搜索：________________

Frontend Design
专业前端设计
v2.3.0

[安装]


Code Review
TypeScript / React
v1.4.0

[已安装]
```

Skill 详情：

```text
Frontend Design

版本：2.3.0

简介
...

要求
Codex >= 0.150.0

已安装项目：

✓ project-a
✓ project-b
□ project-c

[安装]
```

---

# 40. Project

```text
Projects

dsh-channels
Provider: Company API
Skills: 8

[打开]
```

项目 Skill：

```text
☑ typescript
☑ react
☑ github-pr
☑ code-review

☐ frontend-design
☐ python

[同步到 Codex]
```

---

# 41. 安全设计

重点：

## Artifact

每个下载物必须：

```text
SHA256
```

客户端校验。

## Skill

Skill 是可执行能力，必须考虑：

```text
恶意脚本
路径穿越
Zip Slip
任意文件覆盖
不可信依赖
```

安装 ZIP 时：

```text
禁止 ../
禁止绝对路径
限制最终安装目录
```

## API Key

```text
只存本机 Credential Store
```

Server 不保存用户真实 API Key。

## dsh 集成

官方安全声明（dsh-v0.1.2-rc.1 原文）：

```text
DeepSeek Harness 尚未接受安全审计，沙箱、审批与权限控制不能保证隔离
```

平台必须在 dsh 首次启动与设置页展示该声明；dsh Web 远程访问必须使用一次性 token（§57）；隐私行为披露见 §61。

---

# 42. 第一阶段不要做账号

MVP：

```text
公开 Registry
      ↓
Desktop
```

用户直接：

```text
下载
安装
使用
```

Server：

```text
Public Skills
Public Codex Releases
Public Provider Templates
```

这样最快。

---

# 43. 第二阶段增加账号

```text
User
 ↓
Login
 ↓
Registry
```

增加：

```text
用户 Skill
同步配置
收藏 Skill
Project Sync
```

---

# 44. 第三阶段企业版

```text
Organization
      │
      ├── Members
      ├── Private Skills
      ├── Provider
      ├── Policies
      └── Projects
```

企业员工：

```text
登录
 ↓
自动获得公司 Skills
 ↓
自动获得 Provider
 ↓
自动获得开发规范
```

---

# 45. 企业内网 Registry

这是非常重要的扩展。

公网：

```text
Your Registry
      │
      ▼
Enterprise Registry
      │
      ▼
Employee Desktop
```

企业服务器缓存：

```text
Codex
dsh（npm 依赖闭包 + 便携 Node 运行时）
Skills
Client
```

员工只需要访问：

```text
https://registry.company.local
```

完全不需要 GitHub。

---

# 46. 推荐技术栈

## Desktop

```text
Tauri 2
React
TypeScript
Rust
```

## Server API

```text
Node.js
TypeScript
Fastify
Zod
PostgreSQL
```

## Admin

```text
React
Vite
TypeScript
```

## Storage

生产：

```text
OSS / COS / S3
+
CDN
```

私有化：

```text
MinIO
```

## Deployment

```text
Docker
Docker Compose
Nginx
```

---

# 47. 推荐项目结构

```text
your-agent-platform/

├── apps/
│   ├── desktop/
│   │   └── Tauri + React
│   │
│   ├── api/
│   │   └── Fastify
│   │
│   └── admin/
│       └── React
│
├── packages/
│   ├── api-client/
│   ├── registry/
│   ├── skill/
│   ├── manifest/
│   └── shared/
│
├── deploy/
│   ├── docker-compose.yml
│   ├── nginx/
│   └── .env.example
│
└── docs/
```

---

# 48. MVP 开发顺序

## P0 — Desktop 基础

```text
Tauri
React
Rust
```

实现：

```text
环境检测
Codex Manager
Download Manager
```

---

## P1 — Registry

```text
Fastify
PostgreSQL
OSS
```

实现：

```text
Manifest
Codex Release
Skill Registry
```

---

## P2 — Skill

实现：

```text
Skill 搜索
Skill 下载
Skill 安装
Skill 更新
Skill 删除
Project Skill
```

---

## P3 — Provider

实现：

```text
Provider Template
API URL
API Key
Model
Test Connection
```

---

## P4 — Admin

实现：

```text
Skill 上传
Skill 版本
Publish
Deprecated
Codex Release
```

---

## P5 — Update

实现：

```text
Desktop Update
Codex Update
Skill Update
```

---

## P6 — Offline

实现：

```text
Offline Bundle
断点续传
离线安装
```

---

## D 轨 — DeepSeek Harness（dsh）对接

dsh 对接不阻塞 P0–P6，作为独立轨道与 P1/P2 并行推进：

```text
D1  Runtime Pack 分发 + Profile 管理（§54、§55）
D2  Provider / 凭据物化（§56）
D3  Web 一次性 token 启动 + gateway 只读集成（§57）
D4  Skill / Agent Preset 落地（§60）
```

依赖：D1 需要 Registry 先支持 runtime-pack 工件类型（P1 扩展）；D2 依赖 P3 的 Provider 模型；D3、D4 相对独立。

---

# 49. 最终产品链路

用户：

```text
下载 YourApp
      ↓
打开
      ↓
检测 Codex
      ↓
自动下载官方 Codex
      ↓
配置 Provider
      ↓
从你的 Registry 下载 Skills
      ↓
选择 Project
      ↓
选择 Skills
      ↓
启动 Codex
```

服务器：

```text
Admin
  ↓
维护 Skill
  ↓
发布版本
  ↓
生成 Artifact
  ↓
OSS
  ↓
CDN
  ↓
Desktop
```

---

# 50. 最终架构结论

最终建议定为：

```text
                ┌─────────────────────┐
                │      Registry       │
                │                     │
                │ Codex / dsh         │
                │ Skills              │
                │ Providers           │
                │ Manifest            │
                └─────────┬───────────┘
                          │
                     CDN / OSS
                          │
                          ▼
                ┌─────────────────────┐
                │      Tauri 2        │
                │                     │
                │ Codex Manager       │
                │ dsh Manager         │
                │ Skill Manager       │
                │ Provider Manager    │
                │ Project Manager     │
                │ Download Manager    │
                └─────────┬───────────┘
                          │
                          ▼
                   Codex / dsh
```

核心原则：

1. **最终用户不需要 Node.js**
2. **不依赖 Microsoft Store**
3. **不依赖 GitHub**
4. **不依赖 npm**
5. **Codex 使用官方 standalone binary**
6. **你的服务器负责分发和版本管理**
7. **Skill 采用 Registry → Local Store → Project 的三级模型**
8. **API Key 只保存在用户本机**
9. **大文件走 OSS/CDN，不经过 API**
10. **Server 使用 Docker Compose 部署**
11. **第一版不需要 Redis/Kafka/Kubernetes**
12. **CC Switch 只作为参考和兼容对象，不作为核心依赖**
13. **后续可以扩展企业私有 Skill 和内网 Registry**
14. **dsh 没有 standalone binary：通过 Runtime Pack（便携 Node + 依赖闭包）分发，最终用户仍不需要 Node.js**
15. **dsh 一切经 Profile 启动（交互 / web / headless / ACP / Python SDK），patch 是整体替换不是合并**
16. **配置只携带凭据引用：API Key 在 OS Keyring，仅在 dsh 凭据面物化，绝不写进 patch / 配置明文**
17. **dsh 编程集成只走 Remote gateway（APIProxy 已在 0.1.2 移除）；Headless stdout 只输出最终结果，进度走 stderr**
18. **dsh 固定 testedVersion，不使用 npm dist-tag 寻址；rc 版本默认不进稳定轨**

---

# 51. 第一版推荐部署

最小生产部署：

```text
                    Internet
                       │
                       ▼
                  Cloud CDN
                       │
                       ▼
                 Object Storage
                       │
                       │
                ┌──────┴──────┐
                │    Nginx    │
                └──────┬──────┘
                       │
                 ┌─────┴─────┐
                 ▼           ▼
              API Server   Admin
                 │
                 ▼
             PostgreSQL
```

Docker：

```text
nginx
api
admin
postgres
```

文件：

```text
deploy/
├── docker-compose.yml
├── .env
└── nginx/
    └── default.conf
```

这套方案已经足够支撑 MVP 和第一批真实用户，后面再根据流量增加 Redis、对象存储、CDN、Worker 等组件。

---

> 以下 §52–§63 为 v2 新增：DeepSeek Harness（dsh）对接设计，对齐官方 [dsh-v0.1.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1)。

# 52. DeepSeek Harness（dsh）对接总览

## 52.1 dsh 是什么

```text
DeepSeek Harness（dsh）
├── CLI / Host：npm 包 @deepseek-ai/dsh（源码随包以 lib/ 分发，带完整 JSDoc）
├── 插件生态：Cordis 插件形态（官方 @deepseek-ai/dsh-* 家族 + 社区 bundle；
│             本仓库 dsh-channels 即一个官方形态的 bundle）
├── 配置：Profile（package.json + cordis.patch.yml）+ settings.yaml + 受管凭据
├── Web：官方 Web 应用（dsh web）
└── 运行时：Node.js ≥ 22，ESM
```

与 Codex 的关键差异：

```text
              Codex                dsh
官方分发       standalone binary    npm 包（无 binary）
运行时依赖     无                   Node.js ≥ 22
启动模型       直接执行              一切经 dsh Profile
扩展机制       skills               skills + bundles（插件）+ Agent Preset
数据归属       ~/.codex             $DSH_HOME（默认 ~/.dsh）
```

## 52.2 对接面清单

| 对接面 | 章节 | 关键约束 |
| --- | --- | --- |
| 分发 | §54 | Runtime Pack：便携 Node + 依赖闭包，客户端零 npm |
| 版本治理 | §53 | 固定 testedVersion，禁 dist-tag 寻址 |
| 启动 | §55 | 一切经 Profile；patch 整体替换 |
| 配置/凭据 | §56 | 配置只携带引用；Keyring ↔ dsh 凭据面 |
| Web | §57 | 网络访问一次性 token；Remote gateway |
| Headless | §58 | stdout 只输出最终结果；进度走 stderr |
| 会话数据 | §59 | SQLite 后端已移除；seq / eventAt() / snapshotEvents() |
| Skill/Preset | §60 | Skill 轨与 bundle 轨分离；Agent Preset |
| 隐私/安全 | §61 | WebFetch 默认开启；官方安全声明必须展示 |

## 52.3 事实来源与标注

- **【rc.1 原文】**：官方发布说明 dsh-v0.1.2-rc.1（2026-09-03，commit `a66e470`，pre-release）的中文原文引用。
- **【rc.2 已核】**：本仓库曾以 0.1.1-rc.2 依赖环境核实的官方包事实（历史证据标签，保留原文语境）。
- **【待实测】**：暂无可靠来源，实现阶段必须先验证，禁止臆断。

本仓库 dsh-channels 已于 2026-09-06 完成基线升级：全部 `@deepseek-ai/dsh-*` 依赖与
`scripts/check-upstream.mjs` 的 `HARNESS_TESTED_VERSION` 均为 **0.1.2-rc.1**，并按 rc.1
发布说明完成破坏性迁移（ApiProxy 移除 → `sessionController` / Remote gateway；
`Session.events` → `snapshotEvents()`；UserQuestionProvider 槽位 → `user-questions/request`
waterfall；`settingsNamespace()` ctor 移除 → 直传字符串；`resolveSessionPreset` →
`agentPresetProjectionDefinition` 折叠）。设计文档后续表述以 rc.1 为准。

---

# 53. dsh-v0.1.2-rc.1 对齐基线

## 53.1 破坏性变更与平台影响

| rc.1 原文 | 平台设计影响 |
| --- | --- |
| 「Remote 网关统一远程调用 API 与异常分发，旧版 APIProxy 已迁移并移除」 | 平台对 dsh 的一切编程集成只走 Remote gateway；不得按 apiProxy 注入名 / `/api/<method>` 旧面设计（§57） |
| 「网络访问 Web 界面时启用链接中的一次性 token 认证鉴权」 | Desktop 启动 dsh web 后从启动输出解析带 token 的 URL 再打开浏览器；token 一次性，不缓存不复用（§57） |
| 「应用统一通过 dsh Profile 启动，包括 Python SDK、ACP 模式等」 | Desktop 生成并维护 Profile，所有入口统一走 Profile（§55） |
| 「Headless 运行期间向 stderr 流式输出进度，stdout 只输出最终结果」 | Desktop 进程集成的输出解析契约（§58） |
| 「移除可选的 SQLite Session 持久化后端；已有内容不会删除，请使用旧版本导出」 | 平台不得依赖或假设 SQLite；会话读取走官方 API（§59） |
| 「Session.events 被按需读取 API seq、eventAt() 和 snapshotEvents() 取代」 | 会话事件读取按新 API 设计（§59） |
| 「SessionSeq 与 SessionLogOffset 使用强类型区分，本改造保持向前兼容」 | 平台侧字段同样区分「逻辑序号」与「日志偏移」两类语义（§59） |
| 「默认启用公网 WebFetch（内置 SSRF 防护，公网请求不再逐次审批）」 | 企业内网出网策略提示与平台文档（§61） |
| 「Python SDK、Headless、ACP 与自定义 Profile 默认提供 web_fetch」 | headless 自动化默认具备联网工具，任务模板要显式声明（§58、§61） |
| 「Web PTC Mode 默认不再向模型提供通用 workflow 工具」 | 平台文案与预设不假设 workflow 工具存在（§61） |
| 「Code Mode 统一更名为 PTC mode，现有会话记录仍可读取」 | 平台 UI / 文档统一使用 PTC mode |

新能力：

| rc.1 发布说明 | 平台机会 |
| --- | --- |
| 「子代理模型选择支持 Agent 在授权范围内自主选择，也支持调用方指定提供方、模型、推理力度和最大输出长度，以及为 Claude Code、Codex 配置模型」 | Provider Profile 可按 agent 粒度下发模型策略（§56.3） |
| DeepSeek 请求包含启用的插件名/版本（可在配置中关闭）；增量 Session 日志上传为 opt-in、默认关闭 | 隐私披露项（§61） |
| 修复 Node.js 24.0–24.11.1 启动失败与 HMR 问题 | Node 版本策略松绑有限，分发仍建议 22 LTS（§54.4） |

## 53.2 版本治理纪律

dsh 的 npm dist-tag 不可作为版本事实来源。已核实的上游实例（2026-09-06）：`@deepseek-ai/dsh` 的 `latest` 已到 `0.1.2-rc.1`，而 `dsh-agent` 等家族包的 `latest` 仍停在 `0.1.0-rc.6`、`0.1.2-rc.1` 位于 `next`【已核：npm dist-tags】。

平台规则（沿用本仓库 check-upstream 的纪律）：

```text
1. manifest 固定 testedVersion，客户端只按精确版本下载与安装
2. 禁止 latest / next dist-tag 寻址；服务器镜像 tarball 时记录 sha256
3. rc（pre-release）版本默认不进稳定轨；用户显式切换「rc 轨道」才可见
4. 升级流程：兼容矩阵（pinned-current / latest-compatible）→ 契约测试 → fixtures → 更新 testedVersion
5. Skill 的 requirements.dsh 写精确基线，不做宽范围承诺
```

---

# 54. dsh 分发：Runtime Pack

## 54.1 官方分发形态【rc.2 已核】

- dsh CLI 是 npm 包 `@deepseek-ai/dsh`；官方家族是 `@deepseek-ai/dsh-*`（本仓库 0.1.2-rc.1 依赖环境安装整个官方家族），源码随包以 `lib/` 分发。
- **没有官方 standalone binary**（与 Codex 的根本差异）。
- 运行时依赖 Node.js ≥ 22，ESM。

## 54.2 Runtime Pack 构建

```text
Runtime Pack = 便携 Node.js 运行时 + dsh 依赖闭包（node_modules）
```

构建在服务器侧完成，客户端永远不执行 npm：

```text
npm/pnpm 按 locked 依赖树安装 @deepseek-ai/dsh@<testedVersion>
        ↓
整理为完整依赖闭包（node_modules + package.json）
        ↓
与便携 Node.js（按平台）一起打包 tar.gz
        ↓
计算 SHA256 → 上传 OSS → 登记 manifest
```

dsh 家族包之间是精确版本锁定关系（本仓库对 dsh-* 依赖即全量 exact pin，禁止 `^`/`~`【rc.2 已核】），依赖闭包必须整体锁定后打包，不能在客户端现场解析依赖。

## 54.3 本地目录与启动入口

```text
YourApp/
└── bin/
    └── dsh/
        └── 0.1.2-rc.1/
            ├── node/                      # 便携 Node.js（按平台）
            │   └── node.exe
            └── runtime/                   # dsh 依赖闭包
                └── node_modules/
                    └── @deepseek-ai/dsh/
```

规则：

- CLI 入口以 `@deepseek-ai/dsh` 包 `package.json` 的 `bin` 字段为准，Desktop 不硬编码文件名【待实测：具体 bin 路径】。
- 启动命令形态：`<pack>/node/node.exe <pack>/runtime/node_modules/@deepseek-ai/dsh/<bin-entry> --profile <name> …`。
- 版本 side-by-side，支持回滚；升级 = 下载新 Runtime Pack + SHA256 校验 + 原子替换。
- Node 运行时是独立 artifact（独立版本线与 SHA256）：dsh 升级通常不换 Node；Node 安全更新独立推进。

## 54.4 Node 版本策略

- 基线：Node 22 LTS【rc.2 已核：dsh 要求 Node ≥ 22】。
- rc.1 修复了 Node.js 24.0–24.11.1 的启动失败与 HMR 问题（rc.1 发布说明），但分发仍建议 LTS，不追新。
- manifest 中 Node 版本独立登记（§16）。

## 54.5 DSH_HOME 隔离【rc.2 已核】

官方 home 解析优先级：显式配置路径 > `$DSH_HOME` > `~/.dsh`（`@deepseek-ai/dsh-home-paths`；空白 `$DSH_HOME` 视为未设置）。

平台默认隔离：

```text
YourApp/data/dsh-home/      ← Desktop 启动时注入 $DSH_HOME
├── profiles/<name>/
├── settings.yaml
├── .credentials.yaml
└── …
```

- 优点：不碰用户已有 `~/.dsh`，可整体卸载，符合 §7 的隔离原则。
- 高级选项：「接管既有 ~/.dsh」模式（存量用户迁移），必须在 UI 显式确认。

---

# 55. dsh 启动模型：一切经 Profile

## 55.1 规范

【rc.1 原文】> 「应用统一通过 dsh Profile 启动，包括 Python SDK、ACP 模式等」

Desktop 不发明自己的启动方式：交互 / web / headless / ACP / Python SDK 全部经 Profile。

## 55.2 Profile 结构【rc.2 已核】

```text
<dsh-home>/profiles/<name>/
├── package.json        # "dsh": { "profile": { "bundles": [...] } }
└── cordis.patch.yml    # 对各插件 config 的覆盖
```

- 插件消费用 `dsh.profile.bundles` 列表，不手写 plugins map。
- bundle 是 npm 包，自带 `dsh.bundle.patch` 指向自己的 `cordis.patch.yml`；patch 行只引用 bundle 自己的 exports。
- 实例：本仓库 `@wsz987/dsh-channels` bundle + `apps/example/minimal-profile` profile。

## 55.3 patch 整体替换【rc.2 已核】

> 「A Harness patch REPLACES the whole target config — it is NOT a deep merge」

Desktop 的 Profile 生成器必须遵守：

```text
1. 覆盖某插件 config 时整段重写，保留该插件全部字段
2. 生成前先 --dump-config 取当前合并结果，再做最小覆盖
3. 凭据只写引用（如 appSecretRef: XXX），不写明文（§56）
4. disabled: true 直接关插件
```

## 55.4 启动、初始化与排障【rc.2 已核】

以下命令形态省略 Runtime Pack 前缀（实际由 Desktop 用便携 Node 执行包 bin 入口）：

```text
首次初始化：dsh plugin --profile <name> add -w <pkg>   # plugin 会自动初始化 profile，无独立 create 步骤
启动交互：  dsh --profile <name>
启动 Web：  dsh web（与 --profile 组合使用，flag 顺序以 dsh web --help 为准）
Headless：  dsh --profile headless（stdout/stderr 契约见 §58）
验证配置：  dsh --profile <name> --dump-config          # 合并后完整配置
            --dump-default-config                       # 仅 bundle 层默认值
```

- launcher flag（`--profile` 等）必须在应用参数之前【rc.2 已核】。
- Desktop 启动时注入 `$DSH_HOME` 与凭据环境变量（§56），并解析进程输出（web 的 launch URL、headless 的最终结果）。

---

# 56. dsh 配置与凭据对接

## 56.1 模型配置【rc.2 已核】

- 官方 settings 分层：schema defaults → bundle composition base → `settings.yaml` 用户文档（热加载）。
- 默认模型是官方 `agent-default-model` 服务：`{provider, model, reasoningEffort?}`，base bundle 给下层，用户 `settings.yaml` 覆盖。

```text
平台 Provider Template（baseUrl / models）
        ↓ Desktop 生成
dsh settings.yaml / profile patch
        ↓
agent-default-model / 子代理模型映射
```

## 56.2 凭据【rc.2 已核】

官方教义（`@deepseek-ai/dsh-credentials`）：

```text
配置只携带对机密的引用，绝不携带机密本身
```

- 两个 key 空间：`CredentialRef`（环境变量名，如 `DEEPSEEK_API_KEY`）与 `CredentialKey`（`<owner-plugin>/<id>`）。
- 凭据来源分层：进程环境 → 受管 `$DSH_HOME/.credentials.yaml` → launcher 的 project/user `.env` 兜底。
- `credentials.set/unset` 写受管文档；被只读源遮蔽时 fail-loud 拒绝。
- `/api` 特权方法（describe/set/unset）限 loopback；Web 永远读不到 Secret 原值。

平台物化路径：

```text
用户在 Desktop 录入 API Key
        ↓
OS Credential Store（Windows Credential Manager / Keychain / Secret Service）← 唯一长期存储
        ↓ 启动 / 应用配置时物化
dsh 凭据面（优先环境变量注入；受管 .credentials.yaml 由 dsh 凭据服务维护，
平台不直改该文件【待实测：是否存在官方 CLI 写入口】）
        ↓
绝不写进 cordis.patch.yml / settings.yaml / project.json 明文
```

## 56.3 子代理模型选择

【rc.1 原文】> 「子代理模型选择支持 Agent 在授权范围内自主选择，也支持调用方指定提供方、模型、推理力度和最大输出长度，以及为 Claude Code、Codex 配置模型」

平台机会：Provider Profile（§19）按 agent 粒度下发模型策略：

```text
Profile：公司开发
├── Provider: Company API
├── 主模型: deepseek-chat
└── 子代理映射:
    ├── claude-code → 指定 provider / model / 推理力度 / 最大输出长度
    └── codex      → 指定 provider / model / 推理力度 / 最大输出长度
```

落点：Desktop 生成 profile patch / settings 覆盖；具体配置字段以 0.1.2-rc.1 官方配置参考为准【待实测：rc.2 本地无此配置面】。

---

# 57. dsh Web 界面与 Remote Gateway

## 57.1 访问控制：一次性 token

【rc.2 已核（背景）】官方 Web 访问姿态是 loopback + `trustedHosts` 信任围栏：`host` 只接受 `127.0.0.1`（默认）与 `0.0.0.0`（刻意暴露）；围栏是可达性策略而非鉴权，rc.2 时代明确「no authentication layer」，`dsh web --host 0.0.0.0` 在无鉴权层时被故意拒绝。

【rc.1 原文】> 「网络访问 Web 界面时启用链接中的一次性 token 认证鉴权」

Desktop 对接：

```text
dsh web --profile <name>
        ↓
从进程输出解析 launch URL（含一次性 token）【待实测：输出格式】
        ↓
系统浏览器打开该 URL
```

- token 一次性：不缓存、不写日志、不进任何遥测摘要。
- 仅 loopback 场景也走同一 URL 流程，避免分支逻辑。
- Desktop 不自建反向代理去暴露 dsh web；企业远程访问的 Nginx/TLS 由企业侧负责，平台文档提示。

## 57.2 Remote Gateway

【rc.1 原文】> 「Remote 网关统一远程调用 API 与异常分发，旧版 APIProxy 已迁移并移除」

- 平台对 dsh 的一切编程集成（会话列表、事件读取、模型选择、审批交互等）只走 Remote gateway 通道。
- 【rc.2 已核（概念延续）】Host 侧业务 Service 以 `@Remote` 标注、经 `ctx.typertGateway.invoke()` 暴露；Client 侧 `ctx.remote`：`$mount()` 挂载、`$on()` 订阅（事件 allowlist）、`$dispatch()` 由 carrier 调用；unary-only，增量 Session 数据走同一 Connection 上的独立 named-stream 协议。0.1.2 的具体 client 面【待实测】。
- APIProxy 时代的方法面（`session.history` / `session.export` / `session.models` / `session.prompt` 等）是 rc.2 事实，rc.1 已迁移；平台实现以 0.1.2-rc.1 官方 gateway 文档为准，不得按旧面写死【待实测】。

## 57.3 嵌入姿态

第一版：Desktop 不嵌入 dsh web UI，直接拉系统浏览器（最小维护面）。
后续可选：Tauri webview + 官方 `__DSH_TRANSPORT__` carrier 替换 seam（HTTP+WS 或 postMessage tunnel）【rc.2 已核】——独立立项评估，不进 MVP。

---

# 58. dsh Headless 进程契约

【rc.1 原文】> 「Headless 运行期间向 stderr 流式输出进度，stdout 只输出最终结果」

Desktop 解析规则：

```text
stderr  → 流式进度展示（逐行原文透传；解析失败只降级显示，不阻塞运行）
stdout  → 等待进程结束后取最终结果（结构化落库 / 展示）
退出码   → 【待实测】
取消     → 【待实测】（以官方 CLI 文档为准）
```

约束【rc.2 已核】：

- headless / ACP 等直接入口是直连 core 的组装，不挂载 ApiProxy（rc.2 事实；0.1.2 后统一到 gateway，行为以 rc.1 为准）。
- 审批 fail-closed：headless 或组装不完整的部署里审批服务解析为 `unavailable` 并 fail closed，服务本身从不提示人 → 需要人工审批的工作流必须引导用户进交互 / Web 模式，Desktop 不得试图在 headless 里代答审批。
- headless 默认提供 web_fetch（rc.1，§61）→ 自动化任务默认具备联网能力，平台任务模板要显式声明。

---

# 59. dsh 会话数据对接

## 59.1 持久化契约

【rc.2 已核】`dsh-session-persistence` 契约：

```text
append-only；seq 连续；append 返回即 durable
崩溃 turn 用合成 closers（tool/result + step/end? + turn/end {interrupted}）平衡，不截断
readFrom(id, fromSeq) 后缀读；listSnapshots() 返回 opaque branded revision
```

【rc.1 原文】> 「移除可选的 SQLite Session 持久化后端；已有内容不会删除，请使用旧版本导出」

→ JSONL 是唯一内建后端；平台不得依赖或假设 SQLite。

## 59.2 事件读取 API

【rc.1 原文】
> 「Session.events 被按需读取 API seq、eventAt() 和 snapshotEvents() 取代」
> 「SessionSeq 与 SessionLogOffset 使用强类型区分，本改造保持向前兼容」

平台读取策略：

```text
优先：Remote gateway / 官方 API（§57）—— seq / eventAt() / snapshotEvents()
禁止：把直接解析会话文件做成产品功能路径
诊断：仅排障时离线解包。会话日志位于 $DSH_HOME 下 sessions/<encoded-cwd>/<id>/，
      具体文件名与压缩格式以实际版本为准【待实测】
```

会话展示只消费官方 `session/event` 词表【rc.2 已核】：

```text
回复：assistant/chunk、assistant/message、turn/end
可选 UX：tool/call、tool/result
生命周期：session/created、session/disposed、session/title、request/header
其他：user/message、compaction/summary、command/run、command/done、agent-preset/selected
```

## 59.3 隐私

增量 Session 日志上传 DeepSeek 为 opt-in、默认关闭（rc.1 发布说明）。平台不代用户开启；企业内网部署文档必须披露该项与「DeepSeek 请求包含插件名/版本」行为（§61）。

---

# 60. dsh Skill / 插件 / Agent Preset 对接

## 60.1 dsh 的三个扩展面【rc.2 已核】

```text
skills           模型可见/可调用的能力包（SKILL.md 形态）
bundles/plugins  Cordis 插件（ctx 服务、渠道、UI），经 dsh.profile.bundles 挂载
Agent Preset     agent 级组合（目录 + agent.cordis.yml）
```

平台分发轨必须分开：

```text
Skill 轨   → 文件安装（复制到项目），本节
Bundle 轨  → npm 包 + profile patch（§55），Admin 独立管理，不与 Skill 混装
```

## 60.2 skills 事实【rc.2 已核】

- `ctx.skills`（SkillRegistry）：`registerProvider` / `snapshot({cwd, scope})` / `list/get` / `register`（runtime 内嵌 skill，rank 250，项目 provider 可覆盖）。
- `skills/change` 失效事件（不带 diff，消费方重取 snapshot）。
- 来源由 provider 决定（官方 `@deepseek-ai/dsh-skill-filesystem`）——本地目录约定以该包文档为准【待实测：rc.2 本地未安装】。

## 60.3 平台落点

Skill 三级模型的最后一跳（项目启用）：

```text
YourApp/skills/<slug>/             ← Local Skill Store（仓库全局）
        ↓ 项目启用（复制）
<project>/.agents/skills/<slug>/SKILL.md + 附带文件
<project>/AGENTS.md                ← 项目级说明由用户维护，平台不覆写
```

- 默认复制（Windows 符号链接需特权/开发者模式），可选 junction 优化【待实测】。
- 项目根 `AGENTS.md` / `CLAUDE.md` 由 dsh 官方机制从项目根到会话 cwd 逐级加载【rc.2 已核（本仓库自身即此形态）】；平台只管理 `.agents/skills/`，不代写 AGENTS.md。
- 安装 / 升级 / 删除 = 原子目录替换，`skills/change` 自然生效。

skill.json 双 target（§11 示例扩展）：

```json
{
  "targets": ["codex", "dsh"],
  "requirements": { "codex": ">=0.150.0", "dsh": "0.1.2-rc.1" }
}
```

per-target installer：codex → `~/.codex/skills`；dsh → 项目 `.agents/skills/`。

## 60.4 Agent Preset【rc.2 已核】

```text
preset = 一个目录 + 一份 agent.cordis.yml
解析：agent → preset → global（就近遮蔽）
trust: system | user（来自 root）
broken preset 显式列出（带原因），不静默跳过
切换空白 session 的 preset 追加 agent-preset/selected 事件（model-visible ⟺ logged）
subagent child 经 composeFrom() 绑定父 preset
```

- rc.1 修复了「Profile 配置的 Agent Preset 目录在启动时丢失」的问题（rc.1 发布说明 bugfix），Desktop 生成 preset 目录挂在 profile 配置下是受支持形态。
- 平台映射：Provider Profile（§19）在 dsh 侧的落点是「Agent Preset + profile patch」的组合；Preset 切换留给 dsh 官方机制，平台不自建并行概念。

---

# 61. dsh 网络默认行为、隐私与安全声明

【rc.1 原文 / 发布说明汇总】

```text
默认启用公网 WebFetch（内置 SSRF 防护，公网请求不再逐次审批）
Python SDK、Headless、ACP 与自定义 Profile 默认提供 web_fetch
Web PTC Mode 默认不再向模型提供通用 workflow 工具
Code Mode 统一更名为 PTC mode，现有会话记录仍可读取
DeepSeek 请求包含启用的插件名/版本（可在配置中关闭）
增量 Session 日志上传 DeepSeek：opt-in，默认关闭
DeepSeek Harness 尚未接受安全审计，沙箱、审批与权限控制不能保证隔离
```

平台动作：

1. dsh 首次启动与设置页展示官方安全声明原文（§41）。
2. 隐私披露页列出上述上报行为与关闭方式；平台不代用户开启日志上传。
3. 企业内网部署（§45）文档提示：dsh 默认可公网 WebFetch（SSRF 防护内置），出网策略由企业侧按需收紧。
4. 平台 UI / 文案统一 PTC mode，不出现 Code Mode 旧称。
5. 平台对 dsh 的处理不新增遥测：不记录 launch URL / token、不明文记录 API Key（§41）。

---

# 62. dsh 对接 MVP 轨道

见 §48 D 轨。交付顺序与验收：

```text
D1 Runtime Pack + Profile 管理
   验收：离线机器从 Registry 安装 dsh → --dump-config 通过 → 交互模式可用
D2 Provider / 凭据物化
   验收：Keyring 录入 Key → dsh 会话真实调用模型 → patch / 配置全文无明文 Key
D3 Web 启动 + gateway 只读
   验收：一次性 token 启动打开 Web；会话列表 / 事件经 gateway 读取展示
D4 Skill / Preset
   验收：市场安装 skill → 项目启用 → dsh 会话内可见并可调用
```

---

# 63. dsh 对接核对清单

```text
[ ] manifest.agents.dsh 固定 testedVersion，无 dist-tag 寻址
[ ] Runtime Pack 服务端构建，客户端零 npm；SHA256 全覆盖
[ ] $DSH_HOME 隔离，默认不碰 ~/.dsh
[ ] 一切经 Profile；patch 整体替换，覆盖前 --dump-config
[ ] 配置只携带凭据引用；Key 只在 Keyring 与 dsh 凭据面
[ ] Web 经一次性 token URL 启动；token 不落日志
[ ] 编程集成只走 Remote gateway；无 APIProxy 残留
[ ] Headless：stdout = 最终结果、stderr = 进度；审批 fail-closed 有引导
[ ] 会话读取走官方 API（seq / eventAt() / snapshotEvents）；无 SQLite 假设
[ ] Skill 落项目 .agents/skills/；bundle 走 dsh.profile.bundles；两轨不混
[ ] 安全声明与隐私披露（WebFetch 默认、插件名/版本上报、上传 opt-in）进 UI
[ ] rc 版本默认不进稳定轨
```
