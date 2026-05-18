# Image Upload Endpoint

다른 프로젝트에서 `roam-mcp` Worker 의 R2 업로드 엔드포인트를 호출해 이미지(또는 임의 바이너리)를 호스팅하고 공개 URL 을 받아오기 위한 안내.

## TL;DR

```
PUT https://roam-mcp.happytk.workers.dev/g/<graph>/upload/<key>
Authorization: Bearer roam-graph-token-...
Content-Type: <mime>
<binary body>
```

응답:
```json
{ "duplicate": false, "url": "https://pub-2bdbeeee0e40494fa017db7774cbbac2.r2.dev/<key>" }
```

같은 key 로 다시 PUT 하면 업로드를 스킵하고 `duplicate: true` 와 동일한 URL 을 즉시 반환.

## 엔드포인트

| 경로 | 용도 |
|---|---|
| `PUT /upload/<key>` | graph 힌트가 path 에 없는 형태. raw bearer 토큰 사용 시 `X-Roam-Graph` 헤더 또는 Worker 의 `ROAM_GRAPH_NAME` env 폴백이 필요. OAuth grant 토큰을 쓰면 graph 가 grant 에 묶여 있어 그대로 동작 |
| `PUT /g/<graph>/upload/<key>` | graph 가 path 에 있는 형태. **외부 호출 시 권장** — env 설정에 의존하지 않음 |

호스트는 `https://roam-mcp.happytk.workers.dev` (운영). 로컬 개발은 `http://localhost:8787`.

## 인증

서버는 OAuthProvider 가 모든 `/upload/*` 와 `/g/*/upload/*` 요청을 게이트합니다. 두 종류의 Bearer 가 통과:

1. **OAuth access token** — `/authorize` 흐름을 거쳐 발급된 토큰. Claude.ai 같은 OAuth MCP 클라이언트가 사용
2. **Raw Roam API 토큰** (`roam-graph-token-...`) — 스크립트/서버 통합 용도. `resolveExternalToken` 이 prefix 만 보고 통과시킴. 단 graph 가 어디선가 결정돼야 함 (path → header → env 순)

토큰이 없거나 `roam-graph-token-` prefix 가 아닌 잘못된 값이면 **401**.

```
401 { "error": "invalid_token", "error_description": "Missing or invalid access token" }
401 { "error": "invalid_token", "error_description": "Invalid access token" }
```

> 보안: 토큰은 query string 에 넣지 마세요. 액세스 로그·브라우저 히스토리·Referer 에 그대로 남습니다. 반드시 `Authorization: Bearer ...` 헤더로.

## 요청

| 항목 | 값 |
|---|---|
| Method | `PUT` (다른 메서드는 405) |
| Path | `/upload/<key>` 또는 `/g/<graph>/upload/<key>` |
| `Authorization` | `Bearer <token>` (필수) |
| `Content-Type` | 파일의 MIME 타입. 그대로 R2 메타데이터에 저장돼 공개 URL 응답에서도 동일하게 서빙됨. 생략 시 `application/octet-stream` |
| Body | 파일 바이너리 (스트리밍 가능 — Worker 가 R2 로 그대로 파이프) |

### key 규칙

- 슬래시(`/`) 허용 — 디렉토리형 키 (`users/123/avatar.png`) 가능
- `..`, leading `/`, NUL 문자 차단 → 400
- URL-encoded 키도 동작 (서버가 decode 후 R2 키로 사용)
- 길이/문자 제한은 R2 가 그대로 적용

## 응답

성공 시 항상 **200**:

```json
{ "duplicate": false, "url": "https://pub-2bdbeeee0e40494fa017db7774cbbac2.r2.dev/<key>" }
{ "duplicate": true,  "url": "https://pub-2bdbeeee0e40494fa017db7774cbbac2.r2.dev/<key>" }
```

- `duplicate: false` — 새로 업로드됨
- `duplicate: true` — 같은 key 의 객체가 이미 R2 에 있음. 요청 body 는 무시되고 기존 객체 유지. **덮어쓰기가 필요하면 호출 전에 다른 key 를 쓰거나 R2 콘솔에서 삭제**

### 오류

| HTTP | 원인 |
|---|---|
| 400 `invalid key` | key 가 비었거나 `..` / leading `/` / NUL 포함 |
| 400 `missing request body` | PUT 인데 body 가 없음 |
| 401 `invalid_token` | Authorization 헤더 누락/형식 오류/토큰 prefix 불일치 |
| 405 | `PUT` 외 메서드 |
| 500 `R2_PUBLIC_BASE_URL is not configured` | Worker 환경변수 누락 — 운영자에게 알릴 것 |
| 500 `ROAM_IMAGES R2 binding is not configured` | R2 바인딩 누락 — 운영자에게 알릴 것 |

## Dedupe 의미론

dedupe 는 **key 기준**입니다 (내용 기반 X). 같은 내용을 다른 key 로 올리면 두 객체가 생성됨. 콘텐츠 기준 중복 제거가 필요하면 **콘텐츠 해시를 key 로 사용**:

```bash
KEY="$(sha256sum image.png | cut -d' ' -f1).png"
```

이러면:
- 같은 파일 → 같은 key → dedupe (`duplicate: true`)
- 다른 파일 → 다른 key → 새 업로드
- 클라이언트는 응답 url 만 받으면 되므로 "이미 올라가 있는지" 신경 안 써도 됨

## 공개 URL

응답의 `url` 은 R2 의 public bucket URL 입니다:

```
https://pub-2bdbeeee0e40494fa017db7774cbbac2.r2.dev/<key>
```

- 인증 없이 GET 가능
- Content-Type 은 업로드 시 설정한 값 그대로
- CDN 캐싱은 R2 의 기본 정책에 따름 (즉시 가시)
- 베이스가 바뀌면 (`pub-xxx.r2.dev` → 커스텀 도메인) Worker `wrangler.toml` 의 `R2_PUBLIC_BASE_URL` 만 갱신하면 됨. 외부 호출 코드는 응답의 `url` 만 신뢰하면 안전

## 예제

### curl

```bash
TOKEN="roam-graph-token-..."
GRAPH="happytk"
FILE="screenshot.png"
KEY="$(sha256sum "$FILE" | cut -d' ' -f1).png"

curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @"$FILE" \
  "https://roam-mcp.happytk.workers.dev/g/$GRAPH/upload/$KEY"
```

### TypeScript / Node.js (fetch)

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

interface UploadResult {
  duplicate: boolean;
  url: string;
}

async function uploadImage(
  filePath: string,
  contentType: string,
  opts: { graph: string; token: string; host?: string },
): Promise<UploadResult> {
  const buf = await readFile(filePath);
  const ext = filePath.split(".").pop() ?? "bin";
  const key = `${createHash("sha256").update(buf).digest("hex")}.${ext}`;
  const host = opts.host ?? "https://roam-mcp.happytk.workers.dev";

  const res = await fetch(`${host}/g/${opts.graph}/upload/${key}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": contentType,
    },
    body: buf,
  });
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<UploadResult>;
}

// 사용
const { url, duplicate } = await uploadImage("./shot.png", "image/png", {
  graph: "happytk",
  token: process.env.ROAM_API_TOKEN!,
});
console.log(duplicate ? "재사용" : "새로 업로드", url);
```

### Python (requests)

```python
import hashlib
import os
import requests

def upload_image(path: str, content_type: str, graph: str, token: str,
                 host: str = "https://roam-mcp.happytk.workers.dev") -> dict:
    with open(path, "rb") as f:
        body = f.read()
    ext = path.rsplit(".", 1)[-1] if "." in path else "bin"
    key = f"{hashlib.sha256(body).hexdigest()}.{ext}"
    r = requests.put(
        f"{host}/g/{graph}/upload/{key}",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": content_type,
        },
        data=body,
    )
    r.raise_for_status()
    return r.json()

result = upload_image("./shot.png", "image/png",
                      graph="happytk",
                      token=os.environ["ROAM_API_TOKEN"])
print(result["url"], "(중복)" if result["duplicate"] else "(신규)")
```

### 스트리밍 (큰 파일)

Node 의 fetch 와 Web Streams 를 쓰면 메모리에 다 안 올려도 됩니다:

```ts
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
await fetch(`.../upload/${key}`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
  body,
  // @ts-expect-error Node 의 undici 가 요구
  duplex: "half",
});
```

콘텐츠 해시 키를 쓰려면 사전에 해시를 계산해야 하므로 스트리밍 + 해시 dedupe 는 양립하기 어려움. 임의 key (UUID/timestamp) 로 매번 업로드하는 패턴과 트레이드오프.

## 운영 메모

- Worker 호스트, R2 public base 가 바뀔 수 있으므로 응답의 `url` 을 그대로 저장/표시할 것 (직접 베이스를 조립하지 말 것)
- 토큰을 클라이언트(브라우저) 코드에 박지 말 것 — 백엔드 프록시 경유 또는 별도 단기 토큰 발급 구조가 필요하면 별도 협의
- 대량 업로드 시 R2 무료 티어 한도 (Class A writes 1M/월) 안에서 충분하지만 모니터링은 Cloudflare 대시보드에서

## 참고

- 서버 코드: [src/index.ts](src/index.ts) 의 `handleUpload`
- 바인딩 설정: [wrangler.toml](wrangler.toml)
- 인증 흐름 / 경로 규칙 전반: [README.md](README.md)
