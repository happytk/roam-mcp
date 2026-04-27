# roam-mcp

Roam Research MCP 서버 — Cloudflare Workers에 배포하여 Claude.ai 모바일을 포함한 모든 MCP 클라이언트에서 Roam Research 그래프에 접근할 수 있습니다.

## 구성

```
[Claude.ai / Claude Desktop / 모바일] → [Cloudflare Worker] → [Roam Research API]
```

## 사전 준비

- [Node.js](https://nodejs.org) 18+
- [Cloudflare 계정](https://cloudflare.com) (무료)
- Roam Research API 토큰

### Roam API 토큰 발급

1. [roamresearch.com](https://roamresearch.com) 접속 후 그래프 열기
2. 우측 상단 `...` → **Settings** → **API tokens** 탭
3. **+ New API Token** 클릭하여 발급
4. 토큰 형식: `roam-graph-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

## 설치 및 배포

> 순서가 중요합니다. Secret은 Worker가 배포된 후에 등록해야 안정적으로 동작합니다.

### 1. 의존성 설치

```bash
npm install
```

### 2. Cloudflare 로그인

```bash
npx wrangler login
```

브라우저가 열리면 Cloudflare 계정으로 로그인합니다.

### 3. KV namespace 생성 (OAuth 토큰 저장용, 필수)

OAuth provider 가 grant/access token 을 저장할 KV namespace 를 1개 만듭니다:

```bash
npx wrangler kv namespace create OAUTH_KV
```

출력에 찍히는 `id = "..."` 값을 복사해서 `wrangler.toml` 의 placeholder 자리에 붙여넣습니다:

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "여기에-출력된-ID-붙여넣기"
```

> KV namespace ID 는 secret 이 아닙니다 — 외부에서 직접 접근할 수 없는 계정 내부 식별자라 평문 커밋해도 안전합니다. 비용은 무료 티어 안에서 충분 (100k reads/day, 1k writes/day).

### 4. 그래프 이름 설정 (선택 — env 폴백 / `/check` 용)

그래프 이름은 secret으로 등록합니다. (5단계의 토큰과 같은 방식)

```bash
npx wrangler secret put ROAM_GRAPH_NAME
```

> 그래프 이름은 Roam URL `roamresearch.com/#/app/<graph-name>` 의 `<graph-name>` 과 정확히 일치해야 합니다. 대소문자와 하이픈까지 동일해야 합니다.

이 값은 OAuth 흐름과 무관한 폴백입니다 — `/check` 엔드포인트와 환경변수 기반 호출(curl/CI)에서 사용. **Claude.ai 처럼 OAuth 로 연결되는 클라이언트는 이 값을 무시하고 사용자가 `/authorize` 에서 직접 입력한 graph + token 을 grant 단위로 사용합니다.** 한 Worker 에 그래프 N 개를 붙이려면 OAuth 흐름이 정도이고, 이 secret 은 단일 그래프 환경에 편의용입니다.

### 5. 최초 배포 (Worker 생성)

```bash
npx wrangler deploy
```

이 시점에서는 `ROAM_API_TOKEN` 이 없어서 API 호출은 실패하지만, Worker 자체는 생성됩니다. 배포 완료 시 URL이 출력됩니다:

```
https://roam-mcp.{your-account}.workers.dev
```

### 6. API 토큰을 Secret으로 등록 (선택 — env 폴백 / `/check` 용)

```bash
npx wrangler secret put ROAM_API_TOKEN
```

프롬프트에 Roam API 토큰을 **앞뒤 공백 없이** 붙여넣습니다. (`.dev.vars`나 `wrangler.toml`에 평문으로 저장하지 않음)

> 주의: 토큰은 `roam-graph-token-` 으로 시작해야 합니다. `roam-graph-local-token-` 으로 시작하는 로컬 전용 토큰은 API로 사용할 수 없습니다.

등록 확인:

```bash
npx wrangler secret list
```

Secret은 즉시 반영되므로 재배포가 필요하지 않습니다.

### 7. 토큰 검증 (선택)

셋업이 올바른지 한 번에 확인할 수 있는 진단 엔드포인트입니다:

```bash
curl https://roam-mcp.{your-account}.workers.dev/check
```

성공 응답:

```json
{
  "ok": true,
  "graph": "your-graph-name",
  "message": "Token and graph name are valid. Roam API responded successfully.",
  "sampleCount": 1
}
```

실패 응답 예시와 대응:

| `stage` | 원인 | 해결 |
|---|---|---|
| `token` + "not set" | Secret이 미등록 | 6단계 재실행 |
| `token` + "does not start with" | 토큰 접두사 오류 | `roam-graph-token-`으로 시작하는 토큰으로 재등록 |
| `roam-api` + "Token cannot be verified" | 토큰이 해당 그래프 소유가 아님 | 그래프 이름/토큰 매칭 재확인 |
| `roam-api` + "404" | 그래프 이름 오타 | `wrangler.toml` 수정 후 `npx wrangler deploy` |

### 8. MCP 엔드포인트 동작 확인

```bash
curl https://roam-mcp.{your-account}.workers.dev/
# {"status":"ok","server":"roam-research-mcp","graph":"your-graph-name","tokenConfigured":true,"oauth":{...}}

# OAuth metadata (Claude.ai 가 자동으로 fetch)
curl https://roam-mcp.{your-account}.workers.dev/.well-known/oauth-authorization-server

# curl/CI: env 폴백 토큰 또는 직접 Bearer 토큰으로 호출 (resolveExternalToken 경로)
curl -X POST https://roam-mcp.{your-account}.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer roam-graph-token-..." \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## 인증 모델

서버는 두 가지 인증 경로를 지원합니다 (한 Worker 가 둘 다 동시에 처리):

1. **OAuth 2.1 (Claude.ai 등 원격 MCP 커넥터용)** — Claude.ai 가 `/.well-known/oauth-authorization-server` 로 메타데이터 발견 → DCR 로 클라이언트 등록 → 사용자가 `/authorize` 페이지에서 graph + roam-graph-token 입력 → 서버가 토큰을 Roam API 에 검증한 뒤 grant 발급. 이후 모든 요청은 OAuth access token (Bearer) 으로 인증되고, grant 에 묶인 graph + token 이 `ctx.props` 로 핸들러에 주입됨. **그래프 N 개 = grant N 개 = 별도 OAuth 토큰 N 개.**
2. **External token passthrough (curl/CI 호환)** — `Authorization: Bearer roam-graph-token-...` 처럼 토큰 자체가 `roam-graph-token-` 으로 시작하면 OAuth 조회를 건너뛰고 그대로 사용. graph 는 path/header/query/env 중에서 결정. 환경변수만 세팅된 단일 그래프 셋업이나 스크립트 호출에 편리.

## 요청별 설정 (per-request override)

매 요청마다 그래프/토큰/옵션을 OAuth grant, 헤더, path, query 중 어느 것으로든 전달할 수 있습니다. 우선순위: **OAuth props > header > query > path > env**. OAuth grant 가 있으면 이를 신뢰하고 외부 헤더/query 로 graph·token 을 덮어쓸 수 없습니다 (스푸핑 방어). 플래그(`aiTag`/`mutate`/`dryRun`)는 grant 와 무관하게 매 요청마다 토글 가능.

### 1) 헤더 — curl, CI, Claude Desktop 등 커스텀 헤더가 가능한 클라이언트

| 헤더 | 의미 | 기본값 |
|---|---|---|
| `X-Roam-Graph` | 그래프 이름 | path → `ROAM_GRAPH_NAME` 환경변수 (없으면 에러) |
| `X-Roam-Token` | API 토큰 (`Authorization: Bearer ...` 도 허용) | `ROAM_API_TOKEN` 시크릿 (없으면 에러) |
| `X-Roam-Ai-Tag` | 루트 블록·신규 페이지에 `#ai` 자동 태그 부착 여부. `false`/`0`/`off`/`no` 면 끔 | `true` (켜짐) |
| `X-Roam-Mutate` | `true`/`1`/`on`/`yes` 면 update/delete/move 도구를 노출. 끄면 `tools/list`에서도 숨겨지고 호출도 거부됨 | `false` (꺼짐) |
| `X-Roam-Dry-Run` | `true`이면 모든 쓰기 호출이 no-op이 되고 응답에 `dry_run: true` 포함. 권한 검증/사전 시뮬레이션 용도 | `false` (꺼짐) |

```bash
curl -X POST https://roam-mcp.{your-account}.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -H "X-Roam-Graph: my-graph" \
  -H "X-Roam-Token: roam-graph-token-..." \
  -H "X-Roam-Ai-Tag: false" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

### 2) Path + Query — Claude.ai 커넥터처럼 커스텀 헤더를 못 보내는 클라이언트

Claude.ai 의 Custom Connector UI 는 `Authorization: Bearer ...` 외 임의 헤더를 추가할 수 없습니다. 이 경우 **그래프는 path 로, 플래그는 query string 으로** 인코딩하면 헤더 방식과 동일한 결과를 얻을 수 있습니다. 한 Worker 배포에 그래프별 커넥터를 N 개 등록하는 패턴입니다.

| 위치 | 키 | 의미 |
|---|---|---|
| path | `/g/<graph>/mcp` | 그래프 이름. `/mcp`, `/check` 모두 `/g/<graph>/` 프리픽스 아래에서 동작 |
| query | `?graph=<graph>` | path 대신 query 로도 그래프 지정 가능 |
| query | `?aiTag=0` | `#ai` 자동 태그 끔 (`ai_tag` 도 허용) |
| query | `?mutate=1` | mutation 도구 노출 |
| query | `?dryRun=1` | 모든 쓰기 no-op (`dry_run` 도 허용) |

> **토큰은 query 에 넣지 마세요.** URL 은 액세스 로그·브라우저 히스토리·Referer 헤더에 그대로 남습니다. 토큰은 반드시 `Authorization: Bearer ...` 헤더(Claude.ai 커넥터의 표준 토큰 슬롯)로 전달하세요.

Claude.ai 에 등록할 URL 예시 — 그래프마다 별도 커넥터로 등록:

```
https://roam-mcp.{your-account}.workers.dev/g/personal/mcp
https://roam-mcp.{your-account}.workers.dev/g/work/mcp?mutate=1
https://roam-mcp.{your-account}.workers.dev/g/sandbox/mcp?mutate=1&dryRun=1
```

각 커넥터의 인증 토큰 칸에는 해당 그래프의 `roam-graph-token-...` 을 넣으면 됩니다.

## MCP 클라이언트 연결

### Claude.ai (모바일 포함) — OAuth 흐름

1. [claude.ai](https://claude.ai) → **Settings** → **Integrations**
2. **Add Integration** 클릭
3. URL 입력 (그래프별 1 개씩 등록):
   - `https://roam-mcp.{your-account}.workers.dev/g/personal/mcp`
   - `https://roam-mcp.{your-account}.workers.dev/g/work/mcp?mutate=1`
   - `https://roam-mcp.{your-account}.workers.dev/g/sandbox/mcp?mutate=1&dryRun=1`
4. Claude.ai 가 자동으로 OAuth metadata 를 발견하고 인증 페이지로 이동시킵니다.
5. 우리 `/authorize` 페이지가 뜨면:
   - **Graph name**: URL path 에서 자동으로 채워집니다 (`/g/personal/...` → `personal`). 비어 있으면 직접 입력.
   - **Roam API token**: 해당 그래프의 `roam-graph-token-...` 붙여넣기.
   - **Authorize** 클릭 → 서버가 Roam API 로 토큰 검증 → Claude.ai 로 자동 redirect.
6. 인증 완료. 이후 Claude.ai 가 보내는 모든 요청은 OAuth access token 으로 인증되고, 입력하신 graph + token 이 grant 에 묶여 사용됩니다.

> 토큰을 갱신하거나 권한을 회수하려면 Claude.ai 에서 해당 connector 를 disconnect → 다시 등록하면 됩니다 (새 OAuth grant 발급). 서버 KV 의 grant 는 access/refresh token TTL 에 따라 만료됩니다.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` 수정:

```json
{
  "mcpServers": {
    "roam-research": {
      "command": "npx",
      "args": ["-y", "roam-research-mcp"],
      "env": {
        "ROAM_API_TOKEN": "roam-graph-token-...",
        "ROAM_GRAPH_NAME": "your-graph-name"
      }
    }
  }
}
```

Claude Desktop은 [roam-research-mcp](https://github.com/2b3pro/roam-research-mcp) npm 패키지를 로컬에서 직접 실행하는 방식도 사용할 수 있습니다.

## 로컬 개발

`.dev.vars.example` 파일을 복사해 `.dev.vars` 를 만듭니다 (`.gitignore`에 포함됨):

```bash
cp .dev.vars.example .dev.vars
# 이후 .dev.vars 파일을 열어 본인 토큰과 그래프 이름으로 수정
```

> `.dev.vars` 는 **로컬 `npm run dev` 전용**입니다. 배포 환경에는 영향을 주지 않으며, 배포 환경은 `wrangler secret put` 으로 등록한 값을 사용합니다.

로컬 서버 실행:

```bash
npm run dev
# http://localhost:8787 에서 실행

# 로컬에서도 /check 로 검증 가능
curl http://localhost:8787/check
```

## CI/CD (GitHub Actions)

`.github/workflows/ci.yml` 이 포함되어 있습니다:

- **PR**: `tsc --noEmit` 타입 체크만 수행
- **main 푸시**: 타입 체크 → `wrangler deploy` → `/check` 스모크 테스트

배포 결과가 성공으로 찍혀도 토큰이 깨진 상태면 `/check` 가 실패하므로 워크플로 전체가 실패 처리됩니다.

### 필요한 GitHub Secrets

리포지토리 **Settings → Secrets and variables → Actions → Secrets** 에 등록:

| 이름 | 값 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" 템플릿 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 우측 사이드바의 Account ID |
| `ROAM_API_TOKEN` | (선택) `/check` 스모크 테스트용 폴백 토큰 |
| `ROAM_GRAPH_NAME` | (선택) `/check` 스모크 테스트용 폴백 그래프 이름 |

> OAuth 흐름은 KV 에 저장된 grant 만 쓰므로 `ROAM_API_TOKEN`/`ROAM_GRAPH_NAME` 은 더 이상 운영에 필수가 아닙니다. CI 의 `/check` 스모크 테스트가 빨리 끝나도록 둘 다 등록해두는 것을 권장합니다. **`OAUTH_KV` namespace ID 는 secret 이 아니므로 `wrangler.toml` 에 직접 박아두세요.**

### 필요한 GitHub Variables (선택)

**Settings → Secrets and variables → Actions → Variables** 에 등록:

| 이름 | 값 |
|---|---|
| `WORKER_URL` | `https://roam-mcp.<your-account>.workers.dev` — `wrangler-action` 이 deployment URL을 반환하지 못할 때 스모크 테스트에서 사용 |

## 제공 도구

| 도구 | 설명 |
|------|------|
| `roam_find_pages_modified_today` | 오늘 수정된 페이지 목록 조회 |
| `roam_fetch_page_by_title` | 제목으로 페이지 전체 내용 조회 |
| `roam_search_by_text` | 텍스트 전체 검색 |
| `roam_search_for_tag` | 특정 태그/페이지를 참조하는 블록 검색 |
| `roam_search_by_status` | TODO / DONE / LATER 상태별 블록 검색 |
| `roam_create_page` | 새 페이지 생성 (데일리 노트에는 사용 금지) |
| `roam_add_todo` | TODO 항목 추가 (`page` 생략 시 오늘 데일리 노트) |
| `roam_create_block` | 블록 추가 (`page` 생략 시 오늘 데일리 노트) |
| `roam_update_block` ⚑ | 기존 블록 텍스트 교체 (uid 기반) |
| `roam_delete_block` ⚑ | 블록과 그 자식들 영구 삭제 |
| `roam_move_block` ⚑ | 블록을 다른 부모/페이지로 이동 |
| `roam_rename_page` ⚑ | 페이지 제목 변경 |
| `roam_delete_page` ⚑ | 페이지와 모든 블록을 영구 삭제 (블록 삭제보다 파급 큼) |
| `roam_datomic_query` | 직접 Datalog 쿼리 실행 |

⚑ 표시는 mutate 도구 — 기본 OFF. 요청에 `X-Roam-Mutate: true` 헤더를 보내야 노출되고 호출 가능. dry-run 시뮬레이션은 `X-Roam-Dry-Run: true` 헤더로.

## LLM이 지켜야 할 Roam 컨벤션

서버가 MCP `initialize` 응답의 `instructions` 필드로 아래 규칙을 LLM에 전달합니다. 개별 도구 description에도 동일 규칙이 박혀 있어서 도구 호출 직전에도 다시 읽게 됩니다.

1. **데일리 노트 제목은 ordinal suffix 필수**: `April 16th, 2026` ✅ / `April 16, 2026` ❌
   Roam은 접미사 유무에 따라 완전히 다른 페이지로 취급합니다.

2. **"오늘"에 쓸 때는 `page` 인자를 생략**. `roam_add_todo` 와 `roam_create_block` 둘 다 `page` 미지정 시 서버가 올바른 형식으로 오늘 데일리 노트 제목을 계산해서 사용합니다.

3. **`roam_create_page` 로 오늘 데일리 노트를 만들지 않음**. 데일리 노트는 `roam_add_todo` / `roam_create_block` 이 쓰기 시 자동 생성합니다.

4. **방어적 정규화**: LLM이 실수로 `April 16, 2026` 형식을 넘겨도 서버가 `April 16th, 2026` 으로 자동 교정합니다. 하지만 이건 안전망이고, LLM이 처음부터 올바른 형식으로 넘기는 것이 선호됩니다.

## 트러블슈팅

**토큰 오류 (`Token cannot be verified`)**
- 먼저 `/check` 엔드포인트로 원인을 진단: `curl https://roam-mcp.xxx.workers.dev/check`
- Roam API 토큰이 `roam-graph-token-`으로 시작하는지 확인
- `roam-graph-local-token-`으로 시작하는 것은 로컬 전용 토큰으로 API 사용 불가
- 토큰이 등록한 그래프 이름과 일치하는지 확인 (각 그래프마다 별도 토큰 발급)
- Secret 재등록: `npx wrangler secret put ROAM_API_TOKEN`

**Secret이 사라진 경우**
- `npx wrangler secret put ROAM_API_TOKEN`으로 재등록
- Secret은 배포와 무관하게 유지되지만 계정/Worker 이름이 다르면 별도 등록 필요

**Claude.ai 연결 실패**
- URL이 `/mcp`로 끝나는지 확인: `https://roam-mcp.xxx.workers.dev/mcp`
- Worker가 정상 배포됐는지 확인: `npx wrangler deployments list`

**쓰기 성공했는데 Claude가 실패로 표시**
- Roam write API가 빈 응답을 반환할 때 발생하던 문제 (수정 완료)

**오늘 수정 페이지가 0개로 표시**
- Cloudflare Worker는 UTC 기준으로 실행됨
- 한국 시간(KST = UTC+9) 기준 자정은 UTC 15:00이므로 자정~09:00 사이 수정 항목이 누락될 수 있음
