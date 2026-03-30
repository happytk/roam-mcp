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

### 1. 의존성 설치

```bash
npm install
```

### 2. Cloudflare 로그인

```bash
npx wrangler login
```

브라우저가 열리면 Cloudflare 계정으로 로그인합니다.

### 3. API 토큰을 Secret으로 등록

```bash
npx wrangler secret put ROAM_API_TOKEN
```

프롬프트에 Roam API 토큰을 입력합니다. (`.dev.vars`나 `wrangler.toml`에 평문으로 저장하지 않음)

등록 확인:

```bash
npx wrangler secret list
```

### 4. 그래프 이름 설정

`wrangler.toml`의 `ROAM_GRAPH_NAME` 값을 본인 그래프 이름으로 수정합니다.

```toml
[vars]
ROAM_GRAPH_NAME = "your-graph-name"
```

### 5. 배포

```bash
npx wrangler deploy
```

배포 완료 시 URL이 출력됩니다:

```
https://roam-mcp.{your-account}.workers.dev
```

### 6. 동작 확인

```bash
curl https://roam-mcp.{your-account}.workers.dev/
# {"status":"ok","server":"roam-research-mcp","graph":"your-graph-name"}

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

`.dev.vars` 파일 생성 (`.gitignore`에 포함됨):

```
ROAM_API_TOKEN=roam-graph-token-...
ROAM_GRAPH_NAME=your-graph-name
```

로컬 서버 실행:

```bash
npm run dev
# http://localhost:8787 에서 실행
```

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
- Roam API 토큰이 `roam-graph-token-`으로 시작하는지 확인
- `roam-graph-local-token-`으로 시작하는 것은 로컬 전용 토큰으로 API 사용 불가

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
