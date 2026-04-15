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

### 3. 그래프 이름 설정

`wrangler.toml`의 `ROAM_GRAPH_NAME` 값을 본인 그래프 이름으로 수정합니다.

```toml
[vars]
ROAM_GRAPH_NAME = "your-graph-name"
```

> 그래프 이름은 Roam URL `roamresearch.com/#/app/<graph-name>` 의 `<graph-name>` 과 정확히 일치해야 합니다. 대소문자와 하이픈까지 동일해야 합니다.

### 4. 최초 배포 (Worker 생성)

```bash
npx wrangler deploy
```

이 시점에서는 `ROAM_API_TOKEN` 이 없어서 API 호출은 실패하지만, Worker 자체는 생성됩니다. 배포 완료 시 URL이 출력됩니다:

```
https://roam-mcp.{your-account}.workers.dev
```

### 5. API 토큰을 Secret으로 등록

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

### 6. 토큰 검증 (중요)

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
| `token` + "not set" | Secret이 미등록 | 5단계 재실행 |
| `token` + "does not start with" | 토큰 접두사 오류 | `roam-graph-token-`으로 시작하는 토큰으로 재등록 |
| `roam-api` + "Token cannot be verified" | 토큰이 해당 그래프 소유가 아님 | 그래프 이름/토큰 매칭 재확인 |
| `roam-api` + "404" | 그래프 이름 오타 | `wrangler.toml` 수정 후 `npx wrangler deploy` |

### 7. MCP 엔드포인트 동작 확인

```bash
curl https://roam-mcp.{your-account}.workers.dev/
# {"status":"ok","server":"roam-research-mcp","graph":"your-graph-name","tokenConfigured":true}

curl -X POST https://roam-mcp.{your-account}.workers.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## MCP 클라이언트 연결

### Claude.ai (모바일 포함)

1. [claude.ai](https://claude.ai) → **Settings** → **Integrations**
2. **Add Integration** 클릭
3. URL 입력: `https://roam-mcp.{your-account}.workers.dev/mcp`

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
| `ROAM_API_TOKEN` | Roam API 토큰 (`roam-graph-token-...`). 배포 시마다 Worker secret으로 자동 동기화됨 |

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
| `roam_create_page` | 새 페이지 생성 |
| `roam_add_todo` | TODO 항목 추가 (기본값: 오늘 데일리 노트) |
| `roam_create_block` | 지정 페이지에 블록 추가 |
| `roam_datomic_query` | 직접 Datalog 쿼리 실행 |

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
