# OTP Sender for Cloudflare Workers

Backend API untuk mengirim dan memverifikasi OTP melalui Twilio SMS ke nomor Indonesia. Status OTP, cooldown, batas pengiriman, dan jumlah percobaan disimpan di Durable Object.

## Shared design system

Halaman OTP dan dashboard memuat stylesheet serta theme helper Basis langsung dari `https://design-system-bc6.pages.dev/v1/`. Gaya lokal di `public/style.css` hanya menangani layout khusus aplikasi, termasuk login split-screen dan navigasi sidebar dashboard; warna, tipografi, input verifikasi, tombol, tabel, badge, dan mode terang/gelap mengikuti design system bersama. Karena library `/v1/` memiliki cache singkat, pembaruan design system akan diterapkan tanpa menyalin CSS ke project ini.

## Status demo

Konfigurasi `wrangler.jsonc` saat ini mengaktifkan `DEMO_MODE`. Aplikasi tidak mengirim SMS; kode uji ditampilkan di halaman dan respons API. Jangan gunakan nomor atau informasi sensitif. Sebelum mengaktifkan pengiriman SMS sungguhan, nonaktifkan mode demo dan siapkan semua Worker secrets serta Turnstile seperti dijelaskan di bawah.

## Fitur

- Kode OTP 6 digit acak, berlaku 5 menit secara default.
- Maksimal 5 kali percobaan verifikasi dan 5 SMS per jam per nomor.
- Cooldown pengiriman 60 detik per nomor.
- Maksimal 100 permintaan pengiriman SMS per bulan secara global, berdasarkan bulan UTC.
- Turnstile wajib sebelum pengiriman SMS untuk mengurangi penyalahgunaan.
- Hash OTP menggunakan HMAC; kode plaintext tidak disimpan.
- Dashboard admin menampilkan nomor tersamarkan, waktu, dan status tanpa menyimpan atau menampilkan kode OTP.
- Riwayat dashboard dibatasi hingga 500 pengiriman terbaru.
- Hanya menerima nomor Indonesia dalam format internasional, misalnya `+6281234567890`.
- Twilio adalah satu-satunya provider SMS.

Batas bulanan menghitung setiap permintaan yang sudah dicoba ke Twilio, termasuk permintaan yang gagal, untuk menghindari pengiriman melebihi batas akibat hasil request yang tidak pasti. Batas ini adalah jumlah permintaan SMS, bukan jumlah segmen SMS.

## Menyiapkan dan deploy

1. Pasang Node.js, lalu jalankan `npm install`.
2. Jalankan `npx wrangler login`.
3. Buat widget Cloudflare Turnstile dan catat **secret key** untuk server serta **site key** untuk frontend.
4. Atur secret Worker (gunakan nilai rahasia milik akun Anda):

   ```sh
   npx wrangler secret put TWILIO_ACCOUNT_SID
   npx wrangler secret put TWILIO_AUTH_TOKEN
   npx wrangler secret put TWILIO_FROM_NUMBER
   npx wrangler secret put TURNSTILE_SECRET_KEY
   npx wrangler secret put OTP_HMAC_SECRET
   npx wrangler secret put DASHBOARD_USERNAME
   npx wrangler secret put DASHBOARD_PASSWORD
   ```

   `OTP_HMAC_SECRET` dan `DASHBOARD_PASSWORD` harus berupa nilai acak yang kuat; gunakan password dashboard minimal 32 karakter.
5. Untuk frontend di origin berbeda, isi `ALLOWED_ORIGIN` pada `wrangler.jsonc` dengan satu origin persis, misalnya `https://app.example.com`. Biarkan kosong jika frontend memakai origin yang sama.
6. Jalankan `npm run dev` untuk lokal dan `npm run deploy` untuk deploy. Wrangler akan membuat Durable Object sesuai migrasi di konfigurasi.
7. Buka `/dashboard` pada domain Worker dan masuk dengan username/password dashboard. Gunakan HTTPS dan batasi akses dashboard lebih lanjut dengan Cloudflare Access bila tersedia.

Untuk login dashboard saat pengembangan lokal, buat file `.dev.vars` (file ini diabaikan Git) dengan isi:

```dotenv
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=ganti-dengan-password-lokal-yang-kuat
```

## Halaman demo tanpa mengirim SMS

Jalankan `npm run demo`, lalu buka URL lokal Wrangler untuk memakai halaman demo. Masukkan nomor Indonesia, tekan **Kirim OTP**, lalu kode demo akan muncul di halaman untuk dimasukkan ke langkah verifikasi. Tidak diperlukan akun Twilio, Turnstile, atau biaya SMS.

Mode demo menonaktifkan pemeriksaan Turnstile dan menampilkan OTP di respons API/halaman. Gunakan hanya untuk demo lokal; jangan aktifkan `DEMO_MODE` pada deployment publik atau produksi. Deployment normal menggunakan Twilio dan memerlukan secrets di atas. Untuk mengaktifkan halaman pada mode normal, isi `TURNSTILE_SITE_KEY` di `wrangler.jsonc` dengan site key widget Turnstile.

## Dashboard admin

Dashboard di `/dashboard` meminta kredensial yang disimpan sebagai secrets Worker. Endpoint riwayat menolak akses tanpa kredensial yang benar. Dashboard hanya menampilkan nomor yang disamarkan, waktu, dan status: `Diterima provider` berarti Twilio menerima permintaan, bukan konfirmasi pengantaran SMS. Riwayat tidak menyimpan kode OTP dan hanya menyimpan hingga 500 entri terbaru. Jangan mengaktifkan mode demo pada deployment publik karena mode tersebut mengembalikan kode OTP pada API.

## API

### `POST /api/otp/send`

```json
{
  "phoneNumber": "+6281234567890",
  "turnstileToken": "token-dari-widget-turnstile"
}
```

Balasan sukses `202`:

```json
{
  "message": "If the number is eligible, a verification code was sent."
}
```

### `POST /api/otp/verify`

```json
{
  "phoneNumber": "+6281234567890",
  "code": "123456"
}
```

Balasan sukses `200` adalah `{"verified":true}`. Kode salah, kedaluwarsa, atau sudah digunakan menghasilkan `400`.

## Catatan produksi

Endpoint verifikasi menyatakan bahwa nomor tersebut berhasil diverifikasi. Aplikasi Anda tetap harus mengaitkan hasil itu dengan sesi atau proses pendaftaran yang benar; jangan mempercayai nilai `phoneNumber` atau hasil verifikasi yang dikirim ulang oleh klien tanpa validasi server.

Batasi negara tujuan dan atur batas biaya di Twilio sebelum membuka endpoint ke publik. Gunakan HTTPS dan jangan mencatat OTP, token Turnstile, atau kredensial. Cloudflare Turnstile mengurangi spam tetapi tidak menggantikan kebijakan anti-penipuan dan pemantauan biaya SMS.
