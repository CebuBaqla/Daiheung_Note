# 대흥기업 현장관리 · 기능별 코드 구조

## 2026-10-16 결재·작업 시작·모바일 채팅 개선

기존 DB에 `features/permits/permit_request_ready_guard.sql`과
`features/share/share_replies.sql`을 적용한 뒤 관리자·모바일 파일을 함께 배포합니다.
SQL은 파일을 복사하는 것만으로 실행되지 않습니다.

- 자재 준비 완료를 저장하지 않은 계획서는 결재 요청이 차단됩니다. 초안 저장은 가능합니다.
- 반장의 작업 시작 버튼은 큰 사진 안내문을 먼저 보여 줍니다. 확인 후 기존 전경·작업물 촬영 화면으로 이동합니다.
- 모바일 채팅 입력칸에서 글만 전송할 수 있습니다. 현장공유 글·사진의 답장은 같은 작업허가서 안에서 연결됩니다. 날짜별 채팅 기록 화면은 이번 변경에 포함되지 않습니다.
- 기존 04:00 작업일 기준으로 오늘 진행 중인 작업허가서에만 글과 답장을 게시합니다. 사진·도면 첨부는 기존 `현장공유 ＋`에서 계속 사용합니다.

관리자 PC와 모바일 현장노트를 **기능 폴더 단위**로 나눈 버전입니다.
기능 파일은 따로 저장되어 있지만, 두 화면의 `index.html`이 필요한 기능을 불러와 자동으로 연결합니다.

## 폴더 구조

```
dh-fieldnote/
├─ shared/core.js            공통: Supabase 로그인·RPC·업로드, 기능 등록, 버튼 연결, 날짜/알림 유틸
├─ admin/                    관리자 PC
│  ├─ index.html             ← 이 파일을 열면 됩니다
│  ├─ app.js                 셸: 로그인 · 상단 탭 · 대시보드 틀 · 모달
│  └─ admin.css
├─ mobile/                   모바일 현장노트
│  ├─ index.html             ← 이 파일을 열면 됩니다
│  ├─ app.js                 셸: 로그인 · 타임라인 · 하단 메뉴 · 패널 · 임시저장
│  ├─ media.js               공용 도구: 사진 촬영/축소, 그리기·자르기 편집기, 업로드, 파일 보기
│  └─ mobile.css
└─ features/
   ├─ sites/       현장 및 영업 관리   admin.js · sites_sales.sql
   ├─ contracts/   계약내역            admin.js
   ├─ permits/     작업계획 및 결재    admin.js · mobile.js · permit_material_ready.sql
   ├─ drawings/    도면                admin.js · mobile.js
   ├─ attendance/  출근 및 휴가        mobile.js
   ├─ share/       현장공유            admin.js · mobile.js · share_permit.sql
   ├─ situation/   상황발생            admin.js · mobile.js · situation.sql
   ├─ reports/     작업종료 및 일보    admin.js · mobile.js
   └─ master/      기본 정보           admin.js
```

폴더 구조는 그대로 유지해야 합니다(`index.html`이 `../shared`, `../features`를 상대 경로로 불러옵니다).
서버 없이 파일을 바로 열어도 동작하도록 일반 `<script>` 방식으로 만들었습니다.

## 기능끼리 연결되는 방식

이전 코드는 원본 함수를 덮어쓰는 방식(`const base = siteForm; siteForm = function…`)이라
기능이 늘수록 순서에 따라 깨지기 쉬웠습니다. 지금은 각 기능이 **훅(연결 지점)** 에 자기 화면 조각을 등록합니다.

```js
DH.register({
  name: '상황발생',
  order: 70,
  dashboardPanels: () => ({ slot: 'left', order: 30, html: panel() }),   // 관리자 대시보드에 패널 추가
  shareFormFields: (ctx, draft) => '<label>…🚩 상황발생으로 기록</label>', // 모바일 현장공유 폼에 체크 추가
});
DH.action('situation-detail', (el) => detail(el.dataset.id));          // <button data-action="situation-detail">
```

| 화면 | 훅 | 쓰는 기능 |
|---|---|---|
| 관리자 | `adminLoad` 데이터 불러오기 | 현장(진행률·영업), 현장공유, 상황발생 |
| 관리자 | `adminTabs` 상단 탭 | 현장 현황, 작업 일보, 기본 정보 |
| 관리자 | `dashboardPanels` 대시보드 칸 | 진행 중 현장, 오늘의 작업·달력·주간, 상황발생, 최근 현장공유 |
| 관리자 | `siteDetailSections` / `siteDetailButtons` 현장 상세 | 담당자·기본정보 / 계약내역 / 도면 / 작업계획서 작성 버튼 |
| 모바일 | `mobileLoad` | 상황발생(공유↔허가서 연결 포함) |
| 모바일 | `mobileGate` 타임라인 앞 화면 | 출근 및 휴가 |
| 모바일 | `DH.kind()` 메시지 종류 | 작업허가서 · 현장공유 · 작업종료 |
| 모바일 | `timelineItems` · `itemLabel` · `mobileDetail` · `timelineBanners` | 허가서 연결, 🚩 표시, 상황 상세, 상단 버튼 |
| 모바일 | `mobileNav` 하단 메뉴 | 오늘 목표 · 현장공유 ＋ · 작업종료 |
| 모바일 | `shareFormFields` · `shareFormMount` · `shareValidate` · `sharePayload` · `shareDoneMessage` | 상황발생 |

한 기능의 데이터 불러오기가 실패해도 나머지 화면은 그대로 열리고, 실패한 기능 이름만 알림으로 표시됩니다.
기능을 잠시 빼려면 `index.html`에서 그 `<script>` 줄만 지우면 됩니다.

## 기능별 DB 함수(RPC)

| 기능 | 관리자 | 모바일 |
|---|---|---|
| 현장 및 영업 관리 | `dh_site_progress`, `dh_sales_snapshot`, `dh_save_sales_site` | — |
| 계약내역 | `dh_import_contract`, `dh_admin_edit_contract_item`, `dh_admin_delete_contract_item`, `dh_admin_clear_contract_items` | — |
| 작업계획 및 결재 | `dh_save_permit`, `dh_request_permit_approval`, `dh_reassign_permit_approver`, `dh_decide_permit` | (`dh_worker_snapshot`) |
| 도면 | `dh_register_file`, `dh_replace_drawing` | (`dh_worker_snapshot`) |
| 출근 및 휴가 | — | `dh_attend` |
| 현장공유 | `dh_admin_field_messages`, `dh_admin_day_chat` | `dh_save_share`, `dh_post_share`, `dh_register_file` |
| 상황발생 | `dh_situation_snapshot`, `dh_add_situation_update` | 같음 |
| 작업종료 및 일보 | `dh_admin_work_log` | `dh_save_report`, `dh_submit_report` |
| 기본 정보 | `dh_admin_save_master` | — |
| 공통(셸) | `dh_my_profile`, `dh_admin_snapshot` | `dh_my_profile`, `dh_worker_snapshot` |

## 새벽 4시 작업일 전환

기존 V6, `features/share/share_permit.sql`, `features/reports/report_approval.sql`,
`features/reports/work_photo_pairs.sql` 적용 후
`features/reports/workday_archive.sql`을 실행합니다. SQL과 모바일·관리자 파일을
같이 배포해야 합니다. 04:00 한국시간에 작업일이 바뀌며, 전날의 승인된 허가서는
작업일보의 ‘지난 작업일 기록’에서 현장공유 및 미종료 상태와 함께 조회됩니다.
승인 전 계획서는 작업일보에 포함되지 않습니다. 종료 보고가 나중에 제출·승인되어도
허가서의 원래 작업일에 반영됩니다. 기존 달력 날짜 기준 출근 기록은 보존되며,
새 기능의 출근 선택부터 작업일 기준 별도 기록으로 저장됩니다.

## 관리자 달력의 날짜별 채팅

`features/share/share_replies.sql` 적용 후 `features/share/day_chat.sql`을 Supabase SQL Editor에서 실행합니다.
관리자 달력에서 날짜를 누르면 그 작업일(한국시간 04:00~다음 날 04:00)에 게시된
현장공유 글·첨부 파일·답장을 허가서와 관계없이 시간순으로 볼 수 있습니다.
현재 작업일을 열어 두면 15초마다 채팅을 새로 확인하며, 수동 새로고침도 가능합니다.
작업일보 엑셀 다운로드에는 채팅을 넣지 않습니다.

## 작업 시작 및 전·후 사진 쌍 (추가 설치)


기본 V6, 작업종료 승인 SQL(`features/reports/report_approval.sql`), 단가계약 SQL을 적용한 DB에는
`features/reports/work_photo_pairs.sql`을 **마지막에** 실행합니다. 기존 보고는 전 사진 없이
완료사진으로 계속 표시됩니다. 새 보고부터는 예정 작업자 명단에 있는 작업반장이 전경 1장과
작업물 1장 이상의 전 사진을 업로드해 작업을 시작하고, 종료 시 각 전 사진에 대응하는 후 사진을
제출해야 합니다. 새 SQL을 적용하기 전에는 새 모바일 작업종료·관리자 일보 화면을 배포하지 마세요.

관리자 작업 일보의 위치 설명은 계획서의 `permit.location_description`을 사용합니다.
종료 보고는 기존과 같이 승인 대기를 거쳐 승인 후 작업 일보와 엑셀에 나타납니다.

## 작업종료 보고 승인 (추가 설치)

`features/reports/report_approval.sql`을 기존 V6, 관리자 연결, 계약 진행률 및 단가계약 SQL을 적용한 DB에 마지막으로 실행합니다. HTML/JS 파일을 복사하는 것만으로는 승인 함수가 설치되지 않습니다.

- 결재 요청자(`permit_approval.requested_by`)가 종료 보고를 승인하거나 보완 요청합니다. 종료 보고 제출자가 같은 사람이더라도 승인할 수 있습니다.
- 새 보고는 제출 시 `종료 승인대기`, 승인 후 `작업일보`가 됩니다. 보완 요청 시 원 제출자가 내용을 고쳐 재제출할 수 있습니다.
- 설치 이전에 제출된 보고는 승인된 작업일보로 이관됩니다. 작업일보 조회, 엑셀, 현장 진행률, 계약 실적에는 승인된 보고만 반영됩니다.

### SQL 설치 순서 (새 DB에 설치할 때만)

이미 설치된 영업·상황발생·공유 SQL은 다시 실행할 필요가 없습니다. 관리자와 모바일은 같은 기존 Supabase 프로젝트에 연결합니다. 화면을 기능별 파일로 나누었다는 이유로 DB를 새로 만들거나 기존 테이블을 지울 필요는 없습니다.

1. 기존 V6 기본 설치 + 모바일 연결 SQL (이번에 받은 파일에는 없어 분리하지 않았습니다)
2. `features/sites/sites_sales.sql`
3. `features/situation/situation.sql`
4. `features/share/share_permit.sql` — `dh_save_share`가 상황발생 테이블을 쓰기 때문에 마지막
5. `features/contracts/contracts_edit.sql` — 계약내역 수정·삭제·전체 삭제 함수. 이전 `08_계약내역_수정_삭제.sql`과 같은 내용이며, 이미 설치했다면 추가 실행이 필요하지 않습니다.
6. `features/permits/permit_material_ready.sql` — 작업계획서 단위의 ‘자재 준비 완료’ 상태. 이 버전의 작업계획서 저장과 준비 상태 조회에는 이 SQL이 필요합니다. 기존 예정 자재 및 보고 기록은 삭제하지 않습니다.

이미 설치한 DB에서 저장 함수의 `permit_id is ambiguous` 오류만 수정할 때는 새 SQL Editor 쿼리에서 `features/permits/permit_material_ready_repair.sql` 내용만 실행합니다.

작업계획서의 ‘자재 준비 완료’ 버튼은 준비 상태를 선택하며, ‘초안 저장’을 누를 때 작업계획서와 함께 저장됩니다. 다시 누르면 선택이 해제됩니다. 작업종료의 실제 물량은 목표 작업별로 입력하며, 별도의 자재 사용량은 입력하지 않습니다.

영업·상황발생·공유의 공개 DB 함수 6개는 기존 SQL과 동일합니다. 이 묶음에 기본 V6 설치본 전체가 들어 있는 것은 아닙니다. 함수가 빠져 있는 DB에서는 필요한 설치 이력을 먼저 확인하세요.
기본 V6 SQL도 주시면 같은 방식으로 기능 폴더에 나눠 넣을 수 있습니다.

## 원본과 달라진 점

- **함수 덮어쓰기 제거**: 영업·계약 미리보기·도면 다중등록·허가서 연결 공유가 처음부터 각 기능의 정식 코드가 되었습니다. 덮어써져 쓰이지 않던 옛 코드(단일 도면 등록, 미리보기 없는 계약 등록, 긴급현장 공유, 사진 1장짜리 엑셀)는 지웠습니다.
- **관리자 대시보드에 상황발생 패널 추가**: 진행 중 상황을 확인하고, 허가서를 작성한 담당자는 PC에서도 후속 기록을 남길 수 있습니다(같은 RPC 사용).
- **작업계획서 수정 중 현장을 바꾸면** 새 초안으로 저장되던 문제와 입력한 위치·지시가 지워지던 문제를 고쳤습니다.
- **PDF 도구(pdf.js)는 도면 표시할 때만** 불러와서 모바일 첫 화면이 가벼워졌습니다.
- 상황 후속 기록에 고유 ID를 붙여, 네트워크 재시도로 같은 기록이 두 번 저장되지 않습니다.
- 화면 문구·디자인·동작 순서는 원본과 같게 유지했습니다.

## 2026-10-08 안정성 수정

- 담당자 조회에 실패하면 현장 등록·수정 및 저장을 차단합니다. 조회되지 않은 담당자 목록을 빈 목록으로 저장하여 기존 연결을 종료시키지 않습니다. 진행률 조회 실패와 담당자 조회 실패도 구분합니다.
- 저장된 로그인을 복구하지 못하면 로그인 화면으로 돌아갑니다. 일시적인 연결 실패에는 다시 연결 버튼을 표시하고 로그인 정보는 보존합니다.
- DB 함수 호출뿐 아니라 사진·도면 업로드·다운로드도 만료 전에 토큰을 갱신합니다. 동시 요청은 갱신을 공유하며, 인증 오류는 한 번만 재시도합니다. 권한 부족이나 일반 저장 오류를 무조건 재시도하지 않습니다.
- 상황 후속 기록은 계정·프로젝트·상황별로 전송 중 ID와 내용을 저장합니다. 응답 유실 후 재시도나 상세 재열기에도 같은 ID를 사용하며, 성공 뒤에는 새 기록을 작성할 수 있습니다.
- 로그아웃할 때 관리자 조회 캐시와 첨부 파일 URL을 정리합니다. 모바일 임시저장은 기존 저장 방식과 키를 유지합니다.
- 로그인 화면의 '서버 연결 확인'은 주소와 공개 키를 확인합니다. 현장 데이터 조회와 계정 권한은 로그인 후 확인됩니다.

기본 연결 주소는 `https://awanldljuzwutkbnimcc.supabase.co`입니다. 기존 브라우저에 저장한 연결 설정이 있으면 그 설정을 우선 사용합니다. 공개 키는 클라이언트용 키이며, 비밀 키나 service_role 키를 HTML/JS에 넣지 마세요.

## 기능 의존성과 검증 범위

기능을 제거할 때는 script 한 줄뿐 아니라 의존 기능도 확인해야 합니다. 계약·도면의 관리자 화면은 현장 기능을 사용하고, 모바일 작업종료는 작업허가서 기능을 사용합니다. 현장공유의 도면 선택은 도면 기능이 필요하며 공유↔허가서 연결 조회는 상황발생 스냅샷을 사용합니다.

이 버전의 계약내역 가져오기는 CSV·XLSX·JSON 및 당초/변경·자재 분류 방식입니다. PDF 가져오기나 시트·열 직접 지정 방식은 포함하지 않습니다.

수정본은 가상 데이터로 담당자 조회 실패, 로그인 만료/통신 실패, 파일 토큰 갱신/재시도, 상황 기록 중복 방지와 기본 화면 연결을 검사했습니다. 실제 서버의 인증 서비스와 공개 키 응답은 별도로 확인했습니다. 로그인한 사용자의 실제 쓰기 권한 및 DB 전체 설치 상태는 사용자 계정으로 확인해야 합니다. 동봉된 SQL은 자동 실행되지 않습니다.

## 단가계약 확장

`features/contracts/unit_contract.sql`은 기존 V6, 계약내역 검토 SQL, 작업계획서 자재 준비 SQL을 설치한 DB에 **별도로 적용**합니다. 화면 파일만 배포하면 새 저장·조회 함수가 없어 단가계약 기능은 동작하지 않습니다. SQL 파일은 자동 실행되지 않습니다.

운영 적용 기록: 2026-10-15, Supabase 프로젝트 `awanldljuzwutkbnimcc`의 `main` DB에 적용했습니다. 새 열 2개와 함수 8개, 계약 수량 0 허용 제약 및 함수 접근 권한을 확인했고, 기존 현장·계획·제출 보고 건수는 유지됐습니다. 아직 단가계약 현장과 215개 자재는 등록되지 않았습니다.

- 현장 등록·수정에서 계약 유형을 `단가계약`으로 선택하고 기존 `준공일`을 입력합니다. 별도 계약 기간은 만들지 않습니다.
- 계약 내역은 기존 XLSX/CSV/JSON/PDF 가져오기 화면에서 자재 행을 선택해 등록합니다. 단가계약의 계약 수량은 품목마다 0으로 저장되고, 일반 공사의 수량 검증은 유지됩니다. 다시 가져오면 선택하지 않은 기존 품목은 비활성화됩니다.
- 단가계약 작업계획서는 등록한 자재를 각 항목에 연결하고 양수의 예정 사용량과 항목별 발주 메모를 저장합니다. 작업종료는 계획 항목별 실제 사용량을 기존 방식으로 보고합니다.
- 관리자 대시보드에는 초안·결재 대기·반려를 작업일 범위 밖까지 표시합니다. 열린 대시보드는 15초마다 자동 갱신합니다. 주간 예정 자재는 결재 상태와 메모를 포함해 조회·엑셀 다운로드할 수 있습니다.
- 현장 목록의 단가계약에는 진행률 대신 `작업 내역`이 표시됩니다. 지정한 작업일 기간의 제출 완료 보고만 자재별 합계와 상세 내역에 포함합니다.

## 새 기능을 추가하는 법

1. `features/새기능/admin.js`(또는 `mobile.js`)를 만들고 `DH.register({...})`로 필요한 훅만 등록
2. 버튼은 `data-action="이름"` + `DH.action('이름', fn)` 으로 연결
3. 해당 `index.html`에 `<script src="../features/새기능/admin.js"></script>` 한 줄 추가
