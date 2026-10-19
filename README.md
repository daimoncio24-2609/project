# Performance & Workload Tracker

Aplikasi pengukuran **kinerja & beban kerja tim teknis (Business Analyst, Developer, QA)** sesuai *Dokumen Kerangka Kerja*.

## Fitur
| Kebutuhan dokumen | Implementasi |
|---|---|
| RBAC (Admin / Team Lead / Staff) | Admin: semua data & pengaturan; Team Lead: satu tim + nilai kualitatif; Staff: data sendiri |
| Input & pelacakan beban kerja | Tugas per sprint: story points, ukuran S/M/L (otomatis 2/5/8 poin), jam, kategori, status |
| Dashboard metrik | Beban % per anggota (hijau 50–79, kuning 80–90, merah >90), velocity, defect density, code quality, escape defect rate, tren 6 sprint, peringatan burnout |
| Metrik per peran | BA (rework, ready on time, kejelasan, kepuasan, UAT…), Dev (velocity, PR, coverage, quality, defect density…), QA (test case, escape defect rate, otomasi, sign-off…) |
| Integrasi | Webhook Jira (story points, status, bug) & GitHub (PR merged, review; HMAC-SHA256) |
| Laporan | Unduh Excel / PDF / CSV per sprint atau bulanan |

Batas aman beban 75–80% ditandai di grafik; metrik turunan (escape defect rate, velocity, defect density, konsistensi pengiriman) dihitung otomatis.

## Menjalankan
```bash
npm install
npm run seed     # data demo (opsional)
npm start        # http://localhost:3000
npm test
```
Akun demo (kata sandi `password123`): `admin@example.com`, `lead@example.com`, `sarah@example.com` (BA), `budi@example.com` & `andi@example.com` (Dev), `siska@example.com` (QA). **Ganti kata sandi sebelum dipakai sungguhan.**

Env: `PORT`, `DATA_DIR` / `DB_FILE` (lokasi SQLite), `SEED_PASSWORD`.

## Integrasi
Menu **Integrasi** (admin) menampilkan URL webhook & secret. Data masuk ke sprint berstatus *Aktif*. Jira dicocokkan via email assignee, GitHub via username GitHub pengguna.

## Stack
Node.js + Express, SQLite (better-sqlite3), JWT cookie httpOnly, frontend vanilla JS (tanpa build), exceljs & pdfkit untuk laporan.
