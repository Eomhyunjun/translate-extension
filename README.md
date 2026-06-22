# Bilingual Immersive Translator

**한국어** | [English](README.en.md)

Chrome/Edge에서 웹 페이지를 제자리에서 번역하는 Manifest V3 확장 프로그램입니다. 원문 문단 아래에 번역문을 붙이거나, 원문을 번역문으로 교체하거나, 같은 탭 안에서 원문/번역 좌우 분할 보기를 열 수 있습니다.

이 프로젝트는 단순한 구조를 유지합니다. Vanilla JavaScript만 사용하며 빌드 단계, 번들러, 런타임 의존성이 없습니다.

## 주요 기능

- 읽기 가능한 페이지 블록의 인라인 번역
- 여러 배치를 동시에 처리하는 병렬 번역으로 긴 페이지·LLM 엔진에서 체감 속도 향상
- 원문과 번역문을 나란히 보여주는 같은 탭 분할 보기
- 분할 보기 스크롤 동기화
- 팝업에서 번역 엔진, 모델, 원문 언어, 번역 언어 선택
- 옵션 페이지에서 전체 설정, API 키, 사용 로그, 붙여넣은 텍스트 번역 관리
- 번역 실패 문단별 재시도
- 감지됐지만 번역되지 않은(뷰포트 밖·건너뜀·실패) 문단에 마우스를 올리면 뜨는 `번역하기` 버튼으로 해당 문단만 즉시 번역
- 모델 응답이 깨지거나 개수가 맞지 않을 때 배치 fallback 처리
- URL, 도메인, 이메일처럼 단독으로 표시된 텍스트는 번역 제외
- sibling inline 태그로 쪼개진 한 문장을 하나의 번역 단위로 묶기
- API 키는 `chrome.storage.local`에만 저장
- 선택적으로 로컬 사용 로그 저장

## 지원 번역 엔진

- Google Translate 웹 엔드포인트, API 키 불필요
- MyMemory, API 키 불필요
- Microsoft Translator
- Zhipu BigModel
- GPT / OpenAI
- Gemini
- Claude
- Upstage Solar
- OpenAI-compatible chat completions 엔드포인트

API 키가 필요한 엔진은 각 서비스의 계정과 키가 필요합니다. API 키는 content script로 전달하지 않고, background service worker에서만 번역 요청에 사용합니다.

## 로컬 설치

1. `chrome://extensions` 또는 `edge://extensions`를 엽니다.
2. 개발자 모드를 켭니다.
3. `Load unpacked`를 클릭합니다.
4. 이 저장소 디렉터리를 선택합니다.
5. 브라우저 툴바에서 확장 프로그램을 고정하거나 엽니다.
6. 팝업 또는 옵션 페이지에서 번역 엔진과 언어를 설정합니다.

수정 후 반영 방법:

- `src/background.js`, `manifest.json`, HTML 파일을 수정하면 확장 프로그램을 reload합니다.
- `src/content.js`, `src/content.css`를 수정하면 대상 웹 페이지도 새로고침합니다.
- popup/options 파일을 수정하면 팝업 또는 옵션 페이지를 다시 엽니다.

## 사용 방법

팝업에서 번역 모드를 선택합니다.

- `인라인 보기`: 현재 화면 또는 전체 페이지의 문단을 제자리에서 번역합니다.
- `좌우 분할 보기`: 현재 탭 안에 원문/번역 2분할 리더를 엽니다.
- `번역 제거`: 삽입된 번역 UI를 제거하고 분할 보기를 닫습니다.

단축키는 `manifest.json`에 정의되어 있습니다.

- 인라인 번역: macOS `Cmd+Shift+1`, 그 외 `Alt+Shift+1`
- 분할 번역: macOS `Cmd+Shift+2`, 그 외 `Alt+Shift+2`

옵션 페이지의 `텍스트 번역` 탭에서는 붙여넣은 텍스트를 현재 번역 엔진과 언어 설정으로 바로 번역할 수 있습니다.

## 엔진 설정

기본 Google 엔진은 API 키가 필요 없어서 로컬 테스트에 적합합니다. 품질과 안정성이 더 중요하면 옵션 페이지에서 API 키 기반 엔진을 설정하세요.

- Microsoft: Azure Translator 키와 region을 설정합니다.
- Zhipu: Zhipu API 키와 모델을 설정합니다.
- GPT / OpenAI: OpenAI API 키와 모델을 설정합니다.
- Gemini: Google AI Studio API 키와 모델을 설정합니다.
- Claude: Anthropic API 키와 모델을 설정합니다.
- Upstage Solar: Upstage API 키와 모델을 설정합니다.
- OpenAI-compatible: provider API 키, 모델, `/chat/completions`로 끝나는 HTTPS 엔드포인트를 설정합니다.

OpenAI-compatible 엔드포인트에는 URL 내장 인증 정보를 넣을 수 없습니다. OpenAI가 아닌 호스트는 저장할 때 optional host permission을 요청합니다.

## 개인정보와 API 키

API 키는 `chrome.storage.local`에만 저장됩니다. `chrome.storage.sync`로 동기화하지 않고, 페이지 content script에도 노출하지 않습니다.

사용 로그는 기본적으로 꺼져 있습니다. 켜면 최대 100개의 요청 배치 로그를 `chrome.storage.local`에 저장합니다. 로그에는 입력/출력 미리보기, 상태, 소요 시간, 실제 또는 추정 토큰 수가 포함될 수 있습니다.

브라우저 확장은 사용자의 기기 안에서 사용자가 제공한 API 키를 절대적으로 숨길 수 없습니다. 이 확장에는 폐기 가능하고 quota가 제한된 키를 사용하는 것이 좋습니다.

## 프로젝트 구조

```text
manifest.json        확장 프로그램 manifest
popup.html           브라우저 action popup
options.html         상세 설정 페이지
src/defaults.js      공통 기본 설정 schema
src/background.js    번역 provider gateway와 service worker
src/content.js       DOM 수집, 렌더링, 분할 보기, 재시도 처리
src/content.css      페이지에 주입되는 스타일
src/popup.js         팝업 컨트롤러
src/options.js       옵션 페이지 컨트롤러
assets/              확장 아이콘과 로고
```

## 개발

빌드 명령은 없습니다. 저장소 루트가 그대로 unpacked extension입니다.

유용한 검사:

```bash
node --check src/background.js
node --check src/content.js
node --check src/options.js
node --check src/popup.js
git diff --check
```

## 상태

이 프로젝트는 Chrome Web Store 배포용 완성 패키지가 아니라 로컬 확장 프로토타입입니다. 배포 전에는 provider quota, content security policy, 개인정보 고지, 에러 처리, 브라우저 스토어 요구사항을 검토해야 합니다.
