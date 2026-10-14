# Codex 額度 app-server 實作交件（2026-10-14）

Codex 額度改以 app-server stdio JSON-RPC 為主。Windows 0.162.1 真機的 fresh=true／false 都回 `status:ok`、`source:app-server`，與獨立直接 RPC 的 weekly 0% used／100% left 一致；注入 RPC 失敗後，TUI 回顯握手也成功。程式與建置都在 `../ai-cli-mcp-source-usage-rpc`，主目錄沒有改碼或建置。沒有 bump、publish、push 或合併 master。

## 分支與 commit

分支：`codex/usage-app-server-20261014`；起點：`master` 的 `3a859a6`。

| Commit | 項目 | 驗證 |
| --- | --- | --- |
| `b70c0385399d2b78cfeb76e208ca0c8fd2ee30f7` | RPC client、Windows npm shim argv、結果對應、fallback、TUI 握手、版本預警、回歸／schema／真機工具、README | 初版新測試由 10 FAIL 轉為全 PASS；真機 RPC 與 fallback 成功 |
| `bc43a35b65181db1af5d84a868465cbe409cbe85` | 7 筆新突變、6 筆既有片段更新、fixture 重新擷取及遮罩保留 ANSI token | manifest 357 筆全部片段存在且唯一；指定斷言實跑見下方 |
| 本文件所屬 commit | 完整交接與驗證結果 | `git log -1 -- docs/交件_2026-10-14_usage_app_server.md` 可取得 |

備份、完整驗收 JSON 與測試 log 均放 worktree 外；未放入 dist 或提交個人資料。最終 HEAD 另寫入主目錄的 `.codexdone_usage_rpc`。

## 行為與範圍

- 每次未命中 UsageService 快取的查詢，不論 fresh 與否，先開短命 app-server；只送 initialize → initialized → account/rateLimits/read，不建立 thread 或呼叫模型。通知略過，JSON 支援分段；單 frame 上限 1 MiB，RPC 上限 20 秒。
- Windows 解析已知 npm Codex shim 的 JS 入口，執行 Node + JS argv，支援空白／`&` 路徑，不使用 `shell:true`。未知 batch 不當成 shell 字串執行。POSIX 直接 spawn。
- primary／secondary 依 `windowDurationMins` 分類：10080 → weekly，300 → fiveHour。`percentUsed` 是已用，`percentRemaining` 是剩餘，`basis:'used'`。重置時間同時有可讀 `resetAt` 與 ISO `resetAtIso`；附 plan、source、asOf、cliVersion、resetCreditsAvailable、rateLimitReachedType 與可讀 raw 摘要。
- RPC 失敗後，只有非 fresh 可使用 10 分鐘內且尚未重置的 session 快照；最後才開 TUI。失敗逐層累積 `fallbackReasons`。TUI 只出 context percentage、互動畫面或空輸出都不能當成額度成功。
- TUI 在渲染後的獨立 `› /status` 輸入列回顯時才 Enter。就緒提示只決定打字時機；一直無回顯時最多清空再重打一次，避免 `/status/status`。更新選單仍停止所有自動按鍵。
- TUI 已實測版本常數為 0.162.1。未實測或未知版本落到 TUI 時附 warnings；不替新版本宣稱已驗證。
- UsageService 原有 120 秒成功快取與 30 秒 error 快取保留；`refresh=true` 跳過快取。RPC 的對外 transport 是 stdio，TUI 是 pty。
- Claude／agy 額度 parser 未修改。

## 紅 → 綠與突變

新測試先在舊 dist 上跑，11 項有 10 FAIL（缺少 RPC、fallback 原因、版本預警、提早 Enter 等）。RPC／握手實作後 11 項全 PASS，再補實際 provider 的延遲回顯與僅清理一次 PTY，最終 12 項全 PASS。

既有 usage-parse 初次有 2 FAIL：固定延遲送 Enter 的舊預期，以及 TUI source 尚未標示的舊預期。更新到此次核准的協定後，57 項全 PASS。usage-update 的 fresh 遇更新提示退 session 舊預期，改成 fresh 跳過 session 並回 error 後，5 項全 PASS。

schema 測試先碰到 Windows `where.exe` 第一筆是無副檔名的 POSIX shim，不能由 Windows spawn；改選 exe／cmd／bat 後，實際產生 ClientRequest 並確認仍含 `account/rateLimits/read`。只有本機沒有 Codex 才 SKIP；已安裝但 schema generator 失敗會 FAIL。兩支新 verify 已列進 runner。

0.162.1 fixture 來自本機實際 PTY，包含回顯前、選單回顯後、額度面板三段。200×50，保留 CRLF 與控制碼；email 與 OSC 標題遮罩，未人工重寫為純文字。`.gitattributes` 釘住 byte-preserving binary diff。遮罩先 tokenize ANSI，避免 email regex 吃掉相鄰 `ESC[22m`。

突變結果：新增 7／7、既有 usage-parse 36／36、usage-update 2／2，合計 **45／45 KILLED**，其他斷言代殺 0、SURVIVED 0、ERROR 0。新增 7 筆必須由指定斷言 KILLED，另外執行 usage-parse 36 筆與 usage-update 2 筆；沒有用 build failure 或其他斷言充當 KILLED。每組先確認基準，還原後重建並驗工作樹／相依套件完整。

## Windows 真機驗收摘錄

最終驗收時間：2026-10-14 11:18 UTC，約 22.6 秒，Node 24.15.0／Codex 0.162.1。兩次 service 查詢使用不同 UsageService，非 fresh 結果不是前一次的快取。

```json
{
  "direct": {"usedPercent":0,"windowDurationMins":10080,"resetsAt":1792578971,"secondary":null},
  "fresh_true": {"status":"ok","transport":"stdio","source":"app-server","cliVersion":"0.162.1"},
  "fresh_false": {"status":"ok","transport":"stdio","source":"app-server","cliVersion":"0.162.1"},
  "weekly": {"percentUsed":0,"percentRemaining":100,"basis":"used","resetAt":"2026-10-21 18:36 +08:00","resetAtIso":"2026-10-21T10:36:11.000Z"},
  "plan":"prolite","resetCreditsAvailable":0,"rateLimitReachedType":null,
  "forced_rpc_failure": {"status":"ok","source":"tui","cliVersion":"0.162.1","weeklyUsed":0,"weeklyLeft":100,"fallbackReasons":["app-server: acceptance injected app-server failure"]}
}
```

真實 TUI 版本已在常數內，因此這次沒有 warnings；未知／未測版本的 warnings 由注入測試驗證。新回歸同時涵蓋有五小時視窗的 secondary 變體、視窗順序互換、通知插入、非 JSON、method not found、未登入、EOF、stdin error、frame 過大及逾時；五小時變體不是本帳號的真機觀察。

重現命令：

```powershell
npm run build
node tests/verify-codex-app-server.mjs
node tests/verify-codex-usage-schema.mjs
node tools/acceptance/codex-usage-rpc.mjs codex
```

唯一一次全套 `npm test`：**31 支 PASS、0 FAIL、exit 0，總耗時 621.8 秒**。執行前 PercentCommittedBytesInUse 為 68%（門檻 85%），且與突變完全序列執行。新 RPC 12 項、usage-parse 57 項、usage-update 5 項及 schema 都通過；本機 restart-recovery／PTY jobs 亦通過，但不代表既有跨平台 CI 已回綠。

## 新發現、證據與限制

已觀察：RPC 的 planType 是 `prolite`，本機 TUI 是 `Pro 100`，不能把兩個來源的方案名稱假設成同一字串。Evidence：直接 RPC JSON 與強制 fallback 結果。Confidence：高，僅此帳號／版本。

已觀察：node-pty 原生 console-list helper 在真機清理時可印 `AttachConsole failed`；去掉第二次 kill 後仍能出現，因此根因不能直接歸為「只有重入」。最終驗收程序仍正常 exit 0，額度比對通過。試過 ConPTY DLL 模式，避開 helper 卻留下 conout worker 使驗收 Node 不退出，已放棄；沒有把此分支擴成 node-pty／durable jobs 的系統修復。Evidence：本機驗收 stderr、依賴套件 kill／worker dispose 分支與已停止的 DLL 驗收行程。Confidence：觀察高、完整根因中；其他平台／版本的真機行為待確認。

已確認：fixture email regex 若直接掃原始字串，可能連相鄰色碼的 `22m` 一起視為帳號；遮罩須先保護 ANSI token。Evidence：初份 panel 的 `ESC[xx...` 損壞片段、重新擷取後的控制碼與新增斷言。Confidence：高。

尚待確認：Linux／macOS 與 Node 20.19／22 的真機 quota；本機 fixture／協定 stub 回歸不取代跨平台 CI。此次 Windows 僅確認既知 npm Codex shim，未知 launcher 仍走 fallback。

協定初始化來源：[OpenAI app-server 文件](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)；rateLimits 方法與欄位以本機 0.162.1 generate-json-schema、直接 RPC 為證。知識庫已記錄查證結果：namespace `ai-cli-mcp`，`f1ba968c-7b32-4539-92b7-fedc7c5920ab`（資料層 observation）。

## Claude 接手事項

1. 審查分支 diff，尤其 spawn／kill 的所有權、fallback 與百分比語意；核對此文件最後的 npm test 與突變結果。
2. 審查後合併至 master，處理原有 CI 阻塞；本 worker 不合併或 push。
3. 在主目錄重建 dist，再 `/mcp` 重連，確認載入新分支內容，重新查 query_usage。
4. 發版與版本號由主導者另行決定；此次沒有更動版本。
