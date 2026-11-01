# VoxStudio

VoxStudio là web studio giọng đọc tự lưu trữ. Ở cấu hình mặc định, sản phẩm chỉ cung cấp **giọng AI tiếng Việt**: mô hình VieNeu-TTS chạy trong một dịch vụ riêng, đặt ngay trên máy chủ của bạn (mạng nội bộ, có token, chỉ dùng các giọng có sẵn, không nhân bản giọng, không gọi API bên ngoài). Người dùng chọn vùng miền và giới tính, nghe thử bản thật, soạn dự án theo từng đoạn rồi xuất MP3 hoặc WAV.

> **Chính sách giọng đọc (ADR 0007, 0008, 0009).** Hai bộ máy dựa trên quy tắc có trong mã nguồn là `espeak` (tổng hợp formant eSpeak NG 1.52.0) và `vnunit` (thử nghiệm ghép đơn vị tiếng Việt). Cả hai **không được cung cấp cho người dùng trừ khi người vận hành liệt kê chúng trong `ENABLED_ENGINES`**. Chúng vẫn hoàn toàn không dùng AI, được giữ lại cho phát triển, kiểm thử và các ngôn ngữ khác, và không bao giờ là phương án thay thế ngầm cho bộ máy AI. Giọng AI luôn được gắn nhãn "AI" trong giao diện. Khi không có dịch vụ mô hình thì không giọng nào dùng được và `/health/ready` trả về 503.
>
> VoxStudio không khẳng định giọng đọc tự nhiên hay giống người: chưa có ai nghe và đánh giá (mục UP-045 trong bảng theo dõi). Các kiểu giọng chỉ là bộ tham số cố định, không phải diễn xuất cảm xúc.

## Tính năng đang chạy

- **Studio:** dự án gồm các đoạn; tách, gộp, đổi thứ tự; dấu ngắt `[pause 500ms]`; nhập tệp `.txt`; hoàn tác và làm lại; tự lưu có xử lý xung đột; lưu phiên bản; từ điển phát âm; kiểu giọng (preset).
- **Giọng đọc:** thư viện sáu giọng AI, mỗi giọng có bản nghe thử thật, lọc theo vùng miền (Bắc, Trung, Nam) và giới tính. Chế độ Đơn giản chỉ hiện giọng, tốc độ, cao độ, âm lượng và quãng nghỉ; chế độ Nâng cao hiện mọi điều khiển của bộ máy và xử lý âm thanh, mỗi điều khiển được ghi rõ là của Bộ máy hay của DSP.
- **Xuất âm thanh:** hàng đợi việc trên PostgreSQL với worker tách biệt, tiến độ theo thời gian thực qua SSE, thử lại và hủy việc, bộ nhớ đệm theo nội dung (sửa một đoạn chỉ tổng hợp lại đúng đoạn đó). Xuất ra MP3, OGG hoặc WAV; mỗi tệp được kiểm tra và giải mã đầy đủ trước khi cung cấp cho người dùng.
- **Trang chủ:** khối "Nghe thử trước": dán văn bản, chọn vùng miền và giới tính, nghe bản thử thật, sau đó lưu thành dự án.
- **Giao diện:** tiếng Việt và tiếng Anh; chủ đề sáng và tối (Tự động theo hệ thống); thanh điều hướng bên trái trên máy tính, thanh dưới cùng trên điện thoại; hỗ trợ bàn phím và trình đọc màn hình (có kiểm tra axe-core ở cả hai chủ đề).
- **Tài khoản và vai trò:** `user` và `admin`. Mọi dự án, tệp âm thanh và việc đều thuộc về chủ sở hữu (tài nguyên của người khác trả về 404). Khu vực tài khoản gồm các trang riêng: Hồ sơ, Gói và mức dùng, Mật khẩu, Thiết bị đăng nhập, Dữ liệu của tôi.
- **Trang quản trị (`/admin`, chỉ dành cho quản trị viên):** tổng quan (người dùng, hàng đợi, dịch vụ AI, dung lượng ổ đĩa, workspace dùng nhiều nhất, số liệu bảo mật), người dùng (vai trò, trạng thái, gói), bộ máy và giọng đọc, các việc, nhật ký kiểm toán. Người dùng thường nhận 403 ở mọi đường dẫn quản trị.
- **Thanh toán (tùy chọn, tắt mặc định):** nếu đặt giá, người dùng tạo đơn nâng cấp, chuyển khoản kèm mã đơn, và gói có thời hạn được kích hoạt khi quản trị viên xác nhận hoặc khi một nhà cung cấp gọi webhook. Chưa có adapter cho nhà cung cấp thật và chưa thử với tiền thật. Xem [docs/upgrade/11-BILLING.md](docs/upgrade/11-BILLING.md).
- **Gói dịch vụ:** free, pro, business. Gói quy định độ ưu tiên hàng đợi, số việc chờ tối đa, số ký tự AI mỗi tháng, dung lượng âm thanh được lưu và quyền xuất WAV dung lượng lớn. Quản trị viên gán gói; chưa có thanh toán.
- **Bảo mật:** mật khẩu băm bằng scrypt kèm chính sách mật khẩu, khóa theo tài khoản và theo địa chỉ, giới hạn phiên và hết hạn khi không hoạt động, token CSRF kèm kiểm tra Origin, cookie nghiêm ngặt, các header bảo mật, nhật ký kiểm toán. Xem [docs/upgrade/10-SECURITY-AND-ACCESS.md](docs/upgrade/10-SECURITY-AND-ACCESS.md).
- **Bảo vệ ổ đĩa:** worker đo ổ chứa dữ liệu mỗi phút. Khi dung lượng trống thấp, hệ thống rút ngắn thời gian lưu và cảnh báo quản trị viên; khi cực thấp, hệ thống từ chối việc tạo âm thanh mới (`DISK_FULL`) nhưng âm thanh đã lưu vẫn nghe được. Bản nháp cũ, âm thanh không còn được tham chiếu, việc đã xong và nhật ký kiểm toán cũ được dọn tự động.
- **Công cụ tìm kiếm:** `robots.txt`, `sitemap.xml`, thẻ canonical và thẻ xem trước khi chia sẻ được tạo từ `PUBLIC_BASE_URL`; chỉ trang đăng nhập và đăng ký được phép lập chỉ mục; ứng dụng sau đăng nhập và API yêu cầu không lập chỉ mục.

## Chạy nhanh (máy cục bộ: Windows, macOS hoặc Linux)

Yêu cầu: Node.js 22 trở lên, pnpm, bộ chương trình PostgreSQL 16 trở lên và một bản **FFmpeg đạt chuẩn** (không có `flite` hay `whisper`, xem [ADR 0004](docs/decisions/0004-ffmpeg-dsp-toolchain.md)). Chỉ cần eSpeak NG 1.52.0 nếu bạn bật bộ máy `espeak`. Dịch vụ giọng AI cần Python 3.12 và tệp trọng số của mô hình (xem [services/vieneu/README.md](services/vieneu/README.md)); trọng số không bao giờ được đưa vào repo.

```bash
pnpm install
```

```bash
pnpm db:start
```

`db:start` khởi động một PostgreSQL riêng của dự án tại 127.0.0.1:5433 và ghi tệp `.env`. Mở `.env` và khai báo dịch vụ AI (token là một chuỗi ngẫu nhiên dài ít nhất 16 ký tự, phải giống nhau ở cả hai phía):

```bash
ENABLED_ENGINES=vieneu
VIENEU_SERVICE_URLS=http://127.0.0.1:8765
VIENEU_SERVICE_TOKEN=<token ngẫu nhiên>
VIENEU_APPROVED=true
```

Chạy dịch vụ mô hình ở một cửa sổ terminal (script đọc token từ `.env`; đặt `VIENEU_PYTHON` nếu không tự tìm thấy Python). Đợi khoảng một phút để mô hình tải xong:

```bash
node scripts/start-ai-service.mjs
```

Sau đó, ở một cửa sổ terminal khác (mỗi lần build lại phải tắt ứng dụng trước, vì Prisma không thay được tệp engine khi ứng dụng đang chạy):

```bash
pnpm build
```

```bash
pnpm start
```

`pnpm start` chạy migration, rồi chạy API (đồng thời phục vụ ứng dụng web) và worker. Mở http://localhost:4000 và đăng ký. Tài khoản đầu tiên đăng ký bằng email nằm trong `ADMIN_EMAILS` sẽ trở thành quản trị viên, và chỉ khi chưa có quản trị viên nào. Sau đó, thăng quyền cho người khác trong trang quản trị hoặc bằng lệnh của người vận hành:

```bash
node scripts/user-admin.mjs list
```

`node scripts/user-admin.mjs promote <email>` (còn có `demote`, `suspend`, `activate`, `revoke`) thao tác trực tiếp trên cơ sở dữ liệu.

Khi phát triển giao diện cần tải lại nóng, chạy `pnpm dev:web` (cổng 5173, chuyển `/api` sang cổng 4000) song song với `pnpm start`.

## Cấu hình

Đặt trong `.env` (chạy cục bộ) hoặc `.env.docker` (Compose). Danh sách đầy đủ nằm trong `.env.example`.

| Biến                                                                    | Mặc định                | Ý nghĩa                                                                               |
| ----------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `ENABLED_ENGINES`                                                       | `vieneu`                | Các bộ máy cung cấp cho người dùng: `vieneu`, `espeak`, `vnunit`                      |
| `VIENEU_SERVICE_URLS`, `VIENEU_SERVICE_TOKEN`, `VIENEU_APPROVED`        | trống                   | Địa chỉ dịch vụ mô hình AI, token dùng chung, cờ quản trị viên phê duyệt              |
| `PUBLIC_BASE_URL`                                                       | `http://localhost:4000` | Địa chỉ công khai; dùng cho thẻ canonical, sitemap và nguồn gốc (origin) được phép    |
| `ADMIN_EMAILS`                                                          | trống                   | Chỉ dùng để tạo quản trị viên **đầu tiên**                                            |
| `ALLOW_REGISTRATION`                                                    | `true`                  | `false` để đóng đăng ký tự do                                                         |
| `SESSION_IDLE_HOURS`                                                    | `24`                    | Số giờ không hoạt động thì phiên hết hạn                                              |
| `TRUST_PROXY`                                                           | `loopback`              | Proxy nào được đặt `X-Forwarded-For` (cần đặt đúng khi chạy sau Caddy hoặc CDN)       |
| `PLAN_LIMITS_JSON`                                                      | trống                   | Ghi đè hạn mức của gói, ví dụ `{"pro":{"aiMonthlyChars":1000000}}`                    |
| `PLAN_PRICES_VND_JSON`, `PAYMENT_BANK_*`, `PAYMENT_WEBHOOK_SECRET`      | trống                   | Giá gói theo tháng (VND), tài khoản nhận tiền, bí mật webhook. Trống = tắt thanh toán |
| `QUEUE_AGING_SECONDS`                                                   | `30`                    | Số giây chờ để việc trong hàng đợi được cộng thêm một điểm ưu tiên                    |
| `DISK_WARN_FREE_PERCENT`, `DISK_BLOCK_FREE_PERCENT`, `DISK_MIN_FREE_MB` | `20`, `8`, `1024`       | Ngưỡng dung lượng trống để cảnh báo và để chặn                                        |
| `JOB_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`                            | `30`, `180`             | Số ngày sau đó việc đã xong và nhật ký kiểm toán bị xóa                               |
| `STORAGE_LOCAL_ROOT`                                                    | `./storage`             | Nơi lưu tệp âm thanh (nên đặt trên ổ bạn có theo dõi)                                 |

Hãy đặt `PUBLIC_BASE_URL` thành địa chỉ thật trước khi đưa ra công khai; công cụ tìm kiếm và bản xem trước liên kết dùng địa chỉ này.

## Docker Compose (nền tảng cho môi trường chạy thật)

```bash
cp .env.docker.example .env.docker
```

Sửa `.env.docker` và thay mọi giá trị `CHANGE_ME`, sau đó chạy:

```bash
docker compose up -d --build
```

Các dịch vụ: `caddy` (reverse proxy có TLS), `api`, `worker` (chỉ ở mạng nội bộ), `vieneu` (dịch vụ giọng AI, chỉ ở mạng nội bộ), `postgres` và `migrate` (chạy một lần). Nhật ký container được xoay vòng. FFmpeg được biên dịch từ mã nguồn cố định phiên bản và có kiểm tra checksum. Xem [docs/10-DEPLOYMENT.md](docs/10-DEPLOYMENT.md) và [docs/upgrade/06-PRODUCTION-READINESS.md](docs/upgrade/06-PRODUCTION-READINESS.md). **Chưa kiểm chứng:** máy phát triển không có Docker nên chưa từng build image nào.

## Các lệnh

| Lệnh                                                 | Mục đích                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build`                                         | Sinh Prisma client, build mọi gói và ứng dụng web (tắt ứng dụng trước)                                                                           |
| `pnpm test`                                          | Kiểm thử đơn vị và tích hợp API (Vitest, dùng PostgreSQL và FFmpeg thật; tắt dịch vụ mô hình trước nếu bộ nhớ hạn chế)                           |
| `pnpm test:e2e`                                      | Kiểm thử hành trình bằng Playwright, gồm cả khả năng truy cập. `E2E_PORT=4010 pnpm test:e2e` chạy cạnh ứng dụng của bạn, dùng cơ sở dữ liệu test |
| `E2E_AI=1 pnpm test:e2e`                             | Thêm bài kiểm tra giọng AI thật (cần dịch vụ mô hình và các biến `VIENEU_*`)                                                                     |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | Kiểm tra tĩnh                                                                                                                                    |
| `pnpm audit:compliance`                              | Kiểm toán tuân thủ: phụ thuộc, endpoint, tệp mô hình, bộ lọc FFmpeg, phiên bản bộ máy, cách ly dịch vụ AI                                        |
| `node scripts/qa-security.mjs`                       | Dò bảo mật kiểu hộp đen trên máy chủ đang chạy (không phải kiểm thử xâm nhập)                                                                    |
| `node scripts/user-admin.mjs`                        | Lệnh của người vận hành: list, promote, demote, suspend, activate, revoke                                                                        |
| `pnpm user:reset-password <email>`                   | Cấp mã đặt lại mật khẩu dùng một lần (không giả định có dịch vụ email)                                                                           |
| `node scripts/backup.mjs backup\|verify\|restore`    | Sao lưu cơ sở dữ liệu và âm thanh, có kiểm tra khôi phục                                                                                         |
| `node scripts/make-og-image.mjs`                     | Tạo lại ảnh xem trước khi chia sẻ                                                                                                                |

## Kiến trúc

```text
apps/web          React 19 + Vite + Tailwind + TanStack Query + Zustand + WaveSurfer
apps/api          NestJS 11: xác thực, vai trò, dự án, danh mục, lập kế hoạch xuất, SSE, tệp, quản trị, tệp SEO
apps/worker       Nhận việc (SKIP LOCKED), tổng hợp, xử lý DSP, mã hóa, kiểm tra; bảo vệ ổ đĩa và dọn dẹp
packages/core     Bộ chuyển đổi bộ máy (vieneu, espeak, vnunit), khả năng, văn bản, DSP, gói, quy tắc ổ đĩa, lưu trữ
packages/db       Schema Prisma và migration (PostgreSQL)
packages/contracts  Schema zod, DTO và mã lỗi dùng chung
services/vieneu   Dịch vụ mô hình giọng AI (tiến trình riêng, mạng nội bộ, có token)
config/           Danh sách giọng được phép, bộ văn bản QA, báo cáo QA
docs/             Đặc tả sản phẩm và kỹ thuật, ADR, ghi chú nâng cấp, bản mẫu giao diện
```

## Tài liệu

- Bắt đầu từ [AGENTS.md](AGENTS.md), sau đó đọc `docs/00` đến `docs/12` (đặc tả gốc, viết trước quyết định dùng AI làm mặc định, nên cần đọc cùng các ADR).
- Quyết định kiến trúc: [docs/decisions](docs/decisions) (0007 dữ liệu do AI tạo ở giai đoạn phát triển, 0008 bộ máy AI tự lưu trữ, 0009 giọng AI làm mặc định cùng vai trò và bảo mật tài khoản).
- Hiện trạng: [docs/upgrade](docs/upgrade): `07-MIGRATION-GUIDE.md` (nâng cấp bản đã cài), `07-STUDIO-UI.md`, `09-AI-ENGINE-CAPACITY.md`, `10-SECURITY-AND-ACCESS.md` và [bảng theo dõi triển khai](docs/upgrade/IMPLEMENTATION-TRACKER.md) kèm bằng chứng và các việc còn mở.
- Bản mẫu giao diện đã được duyệt cho đợt thiết kế lại: [docs/design/ui-prototype.html](docs/design/ui-prototype.html).
- Giấy phép của các thành phần bên thứ ba: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Hạn chế đã biết

- Bản mặc định chỉ đọc tiếng Việt; các ngôn ngữ khác cần bật bộ máy `espeak` (tùy chọn).
- Nếu dịch vụ mô hình AI ngừng chạy thì không giọng nào đọc được (chủ ý: không có phương án thay thế ngầm).
- Chưa có đánh giá bằng tai nghe cho giọng AI; chưa đo trên VPS thật; chưa thử thanh toán với tiền thật hay nhà cung cấp thật; chưa có xác thực hai lớp, xác minh email hay kiểm thử xâm nhập; chưa có chức năng xóa tài khoản; chưa từng build image Docker.
- Mã nguồn VoxStudio theo giấy phép MIT ([LICENSE](LICENSE)). Giấy phép này không bao trùm các thành phần bên thứ ba: eSpeak NG (GPL-3.0, chạy như một chương trình riêng, không liên kết vào mã), mô hình VieNeu cùng các giọng, FFmpeg và các thư viện npm vẫn giữ giấy phép riêng (xem [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Hãy kiểm tra giấy phép của mô hình và giọng trước khi phân phối lại trọng số hoặc âm thanh.
