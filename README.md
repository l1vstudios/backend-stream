# MALIX Express backend

Backend Express + Puppeteer untuk frontend `../../svelte/streaming-frontend`. Implementasi endpoint dipindahkan dari konfigurasi Vite lama; Vite kini hanya meneruskan `/api` ke server ini.

## Menjalankan

```sh
cd /Users/brainsoft/kerjaan/webjs/backend-malix
npm install
npm run dev
```

Lalu pada terminal lain:

```sh
cd /Users/brainsoft/kerjaan/svelte/streaming-frontend
npm run dev
```

Backend berjalan di `127.0.0.1:3001` secara default. Cek `http://127.0.0.1:3001/api/health` atau melalui Vite di `http://localhost:5173/api/health`. Anda bisa mengubah port dengan `PORT`, kemudian set `MALIX_BACKEND_URL` pada proses Vite ke alamat backend tersebut.

`puppeteer-core` memakai Google Chrome macOS yang sudah terpasang. Untuk browser lain, set `MALIX_CHROME_PATH` ke path executable Chrome/Chromium. Contoh variabel ada di `.env.example`; export variabel sebelum menjalankan server jika ingin mengubah default.

Endpoint yang tersedia: `/api/movies?page=1&s=...`, `/api/movie-detail?path=/...`, `/api/grab?path=/...` (atau `?url=...`), `/api/hls-proxy?token=...` untuk pemutar, dan `/api/health`.

## Akun pengguna

Backend membaca `malixdb.env` dari folder ini. Isi variabel `BUNNY_DATABASE_URL`, `BUNNY_DATABASE_AUTH_TOKEN`, dan `MALIX_SESSION_SECRET` seperti pada `malixdb.env.example`. File asli diabaikan oleh Git. Tabel `user` memakai kolom `id`, `username`, `password`, `created_at`, `updated_at`, dan `status`. Saat register, backend membuat indeks unik untuk username, menyimpan hash password dengan scrypt, serta mengisi status `active` dan waktu pembuatan.

Endpoint akun: `POST /api/auth/register`, `POST /api/auth/login` (keduanya menerima JSON `{"username":"...","password":"..."}`), `GET /api/auth/me`, dan `POST /api/auth/logout`. Register dan login mengatur cookie sesi HTTP-only selama tujuh hari. Frontend memakai sesi tersebut untuk menampilkan username pada tombol Account. Tabel `cache_stream` tidak diperlukan untuk alur akun ini.

## My Collection

Tabel `collection_film` dibuat otomatis saat API koleksi pertama dipakai. Setiap baris menyimpan `user_id`, path film, judul, metadata, poster, serta `created_at` dan `updated_at`. Kombinasi `user_id` dan path film unik sehingga menekan Favourite berulang tidak membuat duplikat. API `GET /api/collection` menampilkan film milik pengguna yang sedang login; `GET /api/collection/status?path=/...` memeriksa status Favourite; `POST /api/collection` menyimpan film; dan `DELETE /api/collection?path=/...` menghapusnya. Seluruh endpoint memakai cookie sesi dan menolak akses tanpa login.

## Watch Party

Tabel `watch_party_room` menyimpan film, host (`creator_user_id`), kode undangan, mode akses (`public` atau `pin`), hash PIN, dan posisi pemutaran. Tabel `watch_party_member` menyimpan `room_id`, `user_id`, waktu bergabung, dan waktu aktif terakhir. Keduanya dibuat otomatis. PIN enam angka disimpan sebagai hash scrypt; percobaan PIN salah dibatasi lima kali per pengguna, IP, dan room dalam 15 menit.

Endpoint `/api/watch-party/rooms` membuat room. `GET /api/watch-party/rooms/:code` mengembalikan status room untuk anggota, `POST /api/watch-party/rooms/:code/join` bergabung (dengan PIN bila diperlukan), `DELETE /api/watch-party/rooms/:code/members/me` mengeluarkan peserta dari room, `PATCH /api/watch-party/rooms/:code/playback` memperbarui Play/Pause/posisi oleh host, dan `PATCH /api/watch-party/rooms/:code/settings` mengubah akses oleh host. Semua endpoint memerlukan login. Frontend memeriksa status room setiap 2,5 detik untuk menyinkronkan pemutaran. Tautan undangan berbentuk `/watch-party/malix-room-xxxxxxxx`.

Kamera dan mikrofon Watch Party menggunakan WebRTC antar peserta, dengan WebSocket `/api/watch-party/socket?room=...` untuk pertukaran offer, answer, kandidat ICE, dan status media. WebSocket hanya menerima pengguna yang telah bergabung dengan room. Saat host mengakhiri room atau mengubah akses ke PIN, koneksi tamu ditutup. Reverse proxy produksi harus meneruskan upgrade WebSocket. Kamera dan mikrofon memerlukan HTTPS (atau localhost). STUN sudah disediakan; untuk jaringan yang membatasi koneksi langsung, atur relay TURN melalui `MALIX_ICE_SERVERS`, misalnya JSON `[{"urls":"turn:turn.example.com:3478","username":"user","credential":"password"}]`. Kredensial TURN dikirim hanya ke peserta room yang sudah terautentikasi.

## Cache stream

`GET /api/grab?path=/all-wishes-come-true-2026` menyimpan slug `all-wishes-come-true-2026` sebagai `query_film` dan playlist HLS sebagai `stream_url` di tabel `cache_stream`. Permintaan berikutnya memeriksa playlist tersimpan; jika masih valid dan belum melewati TTL enam jam, respons langsung memakai cache tanpa membuka Puppeteer (`cached: true`). Jika playlist rusak atau TTL habis, backend mengambil ulang URL dengan Puppeteer dan memperbarui `stream_url` bila berubah. Waktu pengecekan ulang dicatat di `updated_at`; `created_at` tetap waktu entri pertama. Ubah TTL melalui `MALIX_STREAM_CACHE_TTL_MS` di `malixdb.env` jika diperlukan. Backend membuat indeks unik untuk `query_film` agar tidak ada dua entri untuk slug yang sama.

Respons `/api/grab` berisi `streams: [{ url: "/api/hls-proxy?token=...", type: "hls" }]`, tanpa URL CDN. Playlist HLS juga menukar referensi segmen, key, dan media lain dengan URL proxy bertoken. Token terenkripsi berlaku enam jam. Browser tetap memperlihatkan endpoint MALIX dan tokennya di DevTools; pengguna yang login dapat memakai ulang token tersebut sampai kedaluwarsa. URL CDN asli tetap di backend.

Pemutaran memerlukan login. `/api/grab` memeriksa akun aktif sebelum membuka cache atau Puppeteer, sedangkan `/api/hls-proxy` memverifikasi cookie sesi pada setiap permintaan playlist dan segmen. Token proxy saja tidak cukup untuk mengakses media.

## Melihat proses Puppeteer

Jejak Puppeteer hanya dicetak di terminal backend agar alamat sumber tidak terkirim lewat respons API. Log mencakup navigasi, frame, pilihan player, dan jumlah request/response. Isi body respons jaringan tidak disimpan.

Langkah utama selalu dicetak di terminal backend. Untuk mencetak peristiwa jaringan juga, jalankan `MALIX_TRACE=1 npm run dev`. Puppeteer berjalan tanpa jendela Chrome secara default, baik untuk grab maupun pencarian. Gunakan `MALIX_HEADLESS=0 npm run dev` jika ingin menampilkan Chrome lagi. Tidak perlu restart frontend setelah mengubah parameter `debug` pada request.

Grab film memilih player **P2P** dan menekan area pemutaran pada iframe P2P. Backend tidak lagi memilih CAST atau HYDRAX. Jika player meminta verifikasi manusia, respons `409` menjelaskan bahwa verifikasi belum selesai. Saat Chrome ditampilkan dengan `MALIX_HEADLESS=0`, backend menunggu hingga 60 detik agar Anda bisa menyelesaikannya.

Di production, reverse proxy `/api` ke Express dan sajikan hasil build Vite secara terpisah. Proxy Vite hanya tersedia saat development.
