# 인증과 보안

LOGICA가 AI provider에 연결하는 방식, 외부로 보내는 데이터, credential을 다루는 방식입니다. 앱 사용법은 [README](../README.md)를 보세요.

## AI provider와 인증

LOGICA는 특정 provider에 묶이지 않도록 공통 `AIProvider` 인터페이스 뒤에 OpenAI와 Claude adapter를 둡니다.

| Provider | 인증 방식 | API |
| --- | --- | --- |
| OpenAI | **Sign in with ChatGPT** (기본, ChatGPT 요금제 사용) 또는 API key (OpenAI Platform) | Responses API (`POST /v1/responses`, streaming), 모델 목록 `GET /v1/models` |
| Claude / Anthropic | API key (Claude Console) | Messages API (`POST /v1/messages`, streaming), 모델 목록 `GET /v1/models` |

**인증 방식을 고른 이유**

- **OpenAI**: 기본은 OpenAI의 공식 "Sign in with ChatGPT"(오픈소스 로컬 앱용)입니다. API 사용 요금 대신 사용자의 ChatGPT 요금제(대상 요금제)를 씁니다. Settings에서 OpenAI Platform API key 방식으로 바꿀 수도 있습니다. 두 방식 모두 같은 Responses API를 쓰고, 붙이는 credential만 다릅니다.
- **Claude**: Anthropic은 Claude.ai(Free/Pro/Max) 로그인 OAuth를 서드파티 앱에 제공하지 않으며 서드파티 제품은 API key를 쓰도록 안내합니다. 따라서 Anthropic API key만 지원합니다.
- ChatGPT나 Claude.ai의 브라우저 세션, 쿠키를 읽거나 비공식 API를 쓰는 기능은 없습니다.

### Sign in with ChatGPT 작동 방식

구현: `src-tauri/src/chatgpt.rs` (OAuth 2.0 Authorization Code + PKCE S256, loopback redirect)

1. `https://auth.openai.com/.well-known/openid-configuration`에서 endpoint를 받고, 모두 `auth.openai.com`에 속하는지 확인합니다.
2. `state`, `nonce`, PKCE `code_verifier`를 무작위로 만들고 `127.0.0.1`의 빈 포트에 callback(`/auth/callback`)을 엽니다.
3. 기본 브라우저로 로그인 페이지를 엽니다. 첫 로그인은 `client_id=dynamic_agent_client`와 `agent_name_hint=LOGICA`로 요청하고, scope는 `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, resource는 `https://api.openai.com/v1`입니다.
4. 사용자가 chatgpt.com에서 로그인하고 LOGICA를 승인하면 callback으로 인증 코드와 **이 설치본에 발급된 실제 `client_id`**가 돌아옵니다. 별도의 사전 앱 등록은 없으며, 발급된 ID는 저장해 다음 로그인에 다시 씁니다.
5. 코드를 `code_verifier`와 함께 token endpoint에서 access token, refresh token, ID token으로 교환하고, ID token의 발급자, 대상, 만료, `nonce`를 검사합니다.
6. AI 요청은 access token을 `Authorization: Bearer`로 붙여 보냅니다. 만료 1분 전이면 refresh token으로 갱신하며(회전된 token은 바로 저장), 갱신이 거부되면 다시 로그인하도록 안내합니다.
7. Sign out은 OpenAI revocation endpoint로 세션을 폐기하고 OS store의 token을 삭제합니다.

사용량 한도는 ChatGPT 설정(<https://chatgpt.com/settings/usage>)에서 앱별로 관리합니다.

## 외부로 전송되는 데이터

LOGICA는 자체 서버가 없고, AI 기능을 쓸 때만 아래 내용을 연결한 provider로 보냅니다.

| 기능 | 보내는 내용 | 받는 곳 |
| --- | --- | --- |
| AI 채팅: 답변, 수정안 | 요청, 대화 기록(세션 요약과 최근 대화), 논문 요약, 고른 섹션의 원문 | 설정의 기본 provider. 실패하면 다른 provider가 연결된 경우 그 provider |
| AI 채팅: 요청 정리, 섹션 선택, 웹 리서치, 세션 요약 | 요청, 대화 기록(세션 요약과 최근 대화), 논문 요약, 고른 섹션의 원문 | OpenAI. 실패하면 Anthropic API key가 연결된 경우 Anthropic |
| AI 채팅: Auto 모드의 의도 판단 | 요청, 대화 기록, 논문 요약 | Anthropic. 실패하면 OpenAI가 연결된 경우 OpenAI |
| 논문 요약 만들기 | 요약할 섹션의 원문 | OpenAI. 실패하면 Anthropic API key가 연결된 경우 Anthropic |

- 웹 검색을 켜면 provider의 내장 웹 검색 도구를 씁니다. 검색어는 모델이 만들고 검색은 provider 쪽에서 실행되며, LOGICA가 다른 검색 서비스에 직접 요청하지는 않습니다.
- Chat 답변과 Edit 수정안은 Settings에서 고른 모델을 쓰고, 나머지 호출의 모델은 `src/ai/models/modelConfig.ts`의 `CHAT_MODELS`에서 정합니다. 자세한 내용은 [작동 구조의 모델과 fallback](architecture.md#모델과-fallback)에 있습니다.

## 보안 설계

1. **API key와 ChatGPT token은 OS credential store에만 저장**합니다: macOS Keychain, Windows Credential Manager, Linux Secret Service (`keyring` crate). secure store를 쓸 수 없으면 저장하지 않고 오류를 보여주며, plaintext 파일로 대체 저장하지 않습니다. Windows Credential Manager의 항목당 크기 제한(2.5KB) 때문에 OAuth token 묶음은 여러 항목으로 나눠 저장합니다.
2. **key는 webview로 돌아오지 않습니다.** 프런트엔드는 key를 한 번 backend로 넘겨 저장할 뿐이고, 이후에는 "저장됨"과 끝 4자리 힌트만 받습니다. AI 요청은 Rust backend가 OS store에서 key를 읽어 헤더에 붙여 보냅니다.
3. **요청 대상 allowlist**: backend는 `api.openai.com`과 `api.anthropic.com`의 정해진 endpoint(`/v1/responses`, `/v1/messages`, `/v1/models`)로만 요청을 보냅니다.
4. **오류 메시지 redaction**: provider 오류 본문과 네트워크 오류에서 key와 `sk-...` 형태 토큰을 지운 뒤 화면에 표시합니다. key를 로그로 출력하지 않습니다.
5. **Disconnect / Sign out은 OS store의 항목을 실제로 삭제**하고, ChatGPT 연결은 OpenAI에서도 폐기합니다.
6. 설정과 작업 상태(`state.json`, 앱 설정 폴더)에는 secret이 들어가지 않으며, 저장 직전에도 `apiKey` `token` 같은 이름의 필드를 한 번 더 걸러냅니다.
7. 파일 접근은 연 프로젝트 폴더 안으로 제한됩니다(절대 경로, `..`, 심볼릭 링크 탈출 차단).
8. 저장소에는 `.env`나 credential이 없고 `.gitignore`가 이를 막습니다.
