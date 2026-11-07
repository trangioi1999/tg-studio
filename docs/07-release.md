# 07 · Build & phát hành

Tài liệu Tauri về phân phối: <https://v2.tauri.app/distribute/> — kiểm tra lại tên biến môi trường/cấu hình trước mỗi lần thiết lập, vì có thể đổi theo phiên bản.

## 1. Phiên bản

- SemVer `MAJOR.MINOR.PATCH`; beta: `0.x.y-beta.n`.
- Một nguồn sự thật: `version` trong `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` phải khớp (`npm run version:sync`, CI kiểm tra bằng `version:check`).
- Ghi `CHANGELOG.md` mỗi bản phát hành.

## 2. Build cục bộ

```bash
npm run build:app
# macOS:   src-tauri/target/release/bundle/macos/TG Studio.app, bundle/dmg/*.dmg
# Windows: src-tauri/target/release/bundle/nsis/*.exe, bundle/msi/*.msi
```

Bản chưa ký chỉ nên dùng nội bộ: macOS sẽ bị Gatekeeper chặn (chuột phải → Open để mở), Windows hiện cảnh báo SmartScreen.

## 3. Ký số macOS + notarize

Cần: tài khoản **Apple Developer Program** (trả phí theo năm), chứng chỉ **Developer ID Application**.

Biến môi trường Tauri dùng khi build (đặt trong CI secrets):

| Biến | Ý nghĩa |
|---|---|
| `APPLE_CERTIFICATE` | Chứng chỉ .p12 mã hóa base64 |
| `APPLE_CERTIFICATE_PASSWORD` | Mật khẩu .p12 |
| `APPLE_SIGNING_IDENTITY` | Ví dụ `Developer ID Application: Tran Gioi (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Notarize bằng Apple ID + app-specific password |
| hoặc `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` | Notarize bằng App Store Connect API key (khuyên dùng cho CI) |

Kiểm tra sau build: `spctl -a -vv "TG Studio.app"` và `xcrun stapler validate *.dmg`.

## 4. Ký số Windows

Hai cách:
1. **Chứng chỉ code signing** (OV/EV) → cấu hình `bundle.windows.certificateThumbprint`, `digestAlgorithm`, `timestampUrl` trong `tauri.conf.json`.
2. **Dịch vụ ký trên cloud** (ví dụ Azure Trusted Signing) → dùng `bundle.windows.signCommand` gọi công cụ ký.

Installer: dùng **NSIS** (`.exe`) làm mặc định cho người dùng cuối; `.msi` cho doanh nghiệp. WebView2 có sẵn trên Windows 11; với Windows 10 cấu hình installer tự tải WebView2.

## 5. Tự cập nhật

1. Thêm `tauri-plugin-updater` (Rust + JS) và quyền tương ứng trong `capabilities/`.
2. Tạo cặp khóa ký bản cập nhật: `npx tauri signer generate -w ~/.tauri/tg-studio.key`. **Giữ khóa riêng an toàn** — mất khóa là không phát hành bản cập nhật được cho người dùng cũ.
3. CI đặt `TAURI_SIGNING_PRIVATE_KEY` và `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; bật `bundle.createUpdaterArtifacts`.
4. `tauri.conf.json` → `plugins.updater`: `pubkey` (khóa công khai) và `endpoints` (ví dụ file `latest.json` trên GitHub Releases).
5. App kiểm tra khi khởi động + mỗi 6 giờ; tải nền; hỏi người dùng khởi động lại.
6. Hai kênh: `beta` và `stable` (hai endpoint).

## 6. CI/CD (GitHub Actions) — đã có

- **Không workflow nào tự chạy** (Actions có hạn phút; chủ repo quyết khi nào tốn). Ba lệnh kiểm tra luôn chạy trên máy Mac phát triển trước khi merge (AGENTS.md).
- `.github/workflows/ci.yml`: chạy tay (Actions → CI → Run workflow, hoặc `gh workflow run CI`): `version:check`, build, `npm test`, `cargo test` trên Windows; tick *Chạy cả macOS* (`-f macos=true`) để thêm macOS.
- **Download site** và **Release** build bộ cài trên cả macOS và Windows nên tốn nhiều phút nhất.
- `.github/workflows/release.yml`:
  - **Chạy tay trên một tag** `vX.Y.Z` (Actions → Release → Run workflow, ô *Use workflow from* chọn tag; hoặc `gh workflow run Release --ref vX.Y.Z`): test rồi `tauri-action` build macOS (universal) + Windows và tạo **bản nháp** release kèm installer. Tag có dấu `-` (ví dụ `v0.2.0-beta.1`) thành prerelease. Đẩy tag không tự chạy gì.
  - **Chạy tay trên một nhánh**: build và để installer ở mục *Artifacts* của lần chạy, không tạo release.
- Phát hành một bản: sửa `version` trong `package.json` → `npm run version:sync` → cập nhật `CHANGELOG.md` → commit → `git tag v0.2.0 && git push --tags` → `gh workflow run Release --ref v0.2.0` → kiểm tra bản nháp rồi Publish.

### Việc của chủ repo (agent không làm thay được)

1. **Ký số macOS:** thêm secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH` (mục 3), rồi thêm chúng vào `env:` của bước *Build and attach to a draft release*.
2. **Ký số Windows:** chọn chứng chỉ OV/EV hoặc Azure Trusted Signing (mục 4), cấu hình `bundle.windows` trong `tauri.conf.json`.
3. **Tự cập nhật (mục 5):** tự tạo cặp khóa trên máy mình `npx tauri signer generate -w ~/.tauri/tg-studio.key` (không đưa khóa riêng cho ai, kể cả agent), thêm secrets `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, rồi giao task thêm `tauri-plugin-updater` với **khóa công khai** và endpoint `latest.json` của GitHub Releases.

## 7. Checklist phát hành

- [ ] Version khớp ở 3 file; CHANGELOG cập nhật
- [ ] Test xanh trên macOS + Windows
- [ ] Smoke test với phiên bản CLI đã ghim: dò agent, chạy 1 task mỗi agent, usage hiện đúng
- [ ] Bản macOS: ký + notarize + staple; mở được trên máy sạch
- [ ] Bản Windows: ký; cài trên máy sạch, không cảnh báo đỏ
- [ ] Cập nhật từ bản trước lên bản mới thành công
- [ ] Release notes; chuyển draft → published

## 8. Trang tải cho anh em (Cloudflare Worker)

Repo riêng tư nên không dùng GitHub Pages hay link Release được: người tải phải có quyền vào repo. Cách làm:

- Workflow **Download site** (`.github/workflows/site.yml`) build bộ cài Windows và macOS (universal: chạy trên cả Intel và Apple Silicon) trên GitHub Actions, ghép trang tải (`site/`), ảnh giao diện (`docs/ui-review/`), logo agent và bộ cài (nén `.zip`), rồi đẩy sang nhánh **`site-dist`**, trong thư mục `site/`. Nhánh này chỉ có trang đã build, được thay mới mỗi lần chạy (không tích bộ cài cũ trong lịch sử).
- **Cloudflare Worker** (cách đang dùng; Pages vẫn được) nối với repo trong dashboard và deploy nhánh `site-dist`. Máy build của Cloudflare không build bộ cài (nó chạy Linux), nên ở đó không có lệnh build nào.

**Làm một lần trong Cloudflare.** Nhánh `site-dist` có `site/` và `wrangler.jsonc` (Worker chỉ phục vụ `site/` như tệp tĩnh), nên dùng được cả hai kiểu project:

*Kiểu Worker* (màn hình mặc định của Workers & Pages → Create → Import a repository):
1. Chọn repo `tg-studio` (cấp quyền cho app Cloudflare trên GitHub, chỉ repo này).
2. Project name: **`tg-studio`**. Tên phải trùng `name` trong `wrangler.jsonc`; muốn tên khác thì đặt biến `CF_WORKER_NAME` ở GitHub → Settings → Secrets and variables → Actions → Variables.
3. Build command: **để trống**. Deploy command: **`npx wrangler deploy`**. Root directory: **`/`**. API token: để mặc định.
4. Sau khi tạo: Settings → Build → Branch control → Production branch: **`site-dist`**; tắt build cho các nhánh khác (non-production branch builds).

*Kiểu Pages* (link "Looking to deploy Pages? Get started" cuối trang Create): Connect to Git → `tg-studio`, production branch **`site-dist`**, preset **None**, build command **để trống**, output directory **`site`**; Settings → Builds & deployments → Preview deployments: **None**.

Cả hai kiểu chỉ publish `site/`: source không có trên `site-dist`, và nếu lỡ build nhánh `main` thì `wrangler deploy` dừng vì `main` không có `wrangler.jsonc`. Chạy workflow (bước dưới) trước để nhánh `site-dist` có sẵn khi Cloudflare build lần đầu.

**Mỗi lần có bản mới:** GitHub → Actions → **Download site** → Run workflow (hoặc `gh workflow run "Download site"`). Workflow cập nhật `site-dist`, Cloudflare tự deploy. Trang ở `https://<tên-project>.<subdomain>.workers.dev` (kiểu Worker; subdomain xem ở Workers & Pages → Settings) hoặc `https://<tên-project>.pages.dev` (kiểu Pages). Muốn tên miền riêng: Worker → Settings → Domains & Routes → Add → Custom domain.

Trang tự nhận ra máy Windows hay Mac và đưa bản tương ứng lên trước. Bộ cài được nén thành `.zip` (trình duyệt và bộ lọc mail hay chặn bộ cài chưa ký số); link cố định `downloads/TG-Studio-latest-windows-x64-setup.zip` và `downloads/TG-Studio-latest-macos-universal.zip` luôn trỏ bản mới nhất, trang đọc phiên bản và dung lượng từ `version.json`.

Bản macOS chưa ký số và chưa notarize: lần đầu mở, chuột phải → Open, hoặc System Settings → Privacy & Security → Open Anyway. Tải qua trình duyệt thì macOS hay báo "app bị hỏng": chạy `xattr -cr "/Applications/TG Studio.app"` một lần. Nếu job macOS lỗi (GitHub hay hết máy macOS: "The job was not acquired by Runner"), workflow vẫn đăng bản Windows mới và giữ bản macOS đã đăng lần trước; chỉ khi chưa từng có bản macOS thì trang mới ghi "macOS: chưa có bản". Chạy lại workflow để có bản macOS mới.

**Chỉ cho người trong nhóm tải:** Cloudflare Zero Trust → Access → Applications → Add → Self-hosted, domain của trang (`<tên-project>.<subdomain>.workers.dev` hoặc `.pages.dev`), policy **Allow** theo danh sách email (gói Free tới 50 người). Người tải nhập email, nhận mã đăng nhập một lần.

Giới hạn (Worker static assets và Pages như nhau): mỗi tệp tối đa 25 MiB; zip Windows khoảng 7 MiB, zip macOS (universal) khoảng 10–15 MiB.
