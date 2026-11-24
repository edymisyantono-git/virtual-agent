# Virtual Company: perusahaan digital yang dijalankan AI agent

Setiap posisi di perusahaan (Intake, BizDev, BA, PM, UX, Architect, Developer, QA, Security,
DevOps, Marketing, Support, Data, Finance) diwakili satu agent Claude. Request customer masuk
lewat chat. Intake menggali kebutuhan, lalu orkestrator menyerahkan pekerjaan dari tim ke tim
sampai sistem "live", lalu hasil analitik kembali ke PM (siklus perbaikan berkelanjutan).

## Menjalankan

```powershell
cd VirtualCompany
& "C:\Program Files\dotnet\dotnet.exe" run --urls http://localhost:5080
```

Buka http://localhost:5080, lalu tekan **Run sample request** untuk melihat satu proyek penuh,
atau **New request** untuk chat sendiri sebagai customer.

| Engine (`VC_MODE`) | Kapan aktif | Keterangan |
|---|---|---|
| `agent-sdk` | Default bila `ANTHROPIC_API_KEY` di-set | Setiap agent dijalankan lewat **Claude Agent SDK** di sidecar Node (`agent-runner/server.mjs`, port 5081) yang otomatis dinyalakan bersama aplikasi. Biaya diambil dari laporan SDK. |
| `api` | `VC_MODE=api` | Panggilan langsung dari .NET lewat SDK `Anthropic` (NuGet), dengan *refusal fallback* untuk Opus/Sonnet/Fable 5.1. |
| `sim` | Tanpa key, atau `VC_MODE=sim` | Output agent dibuat lokal (format sama dengan live). Gratis, untuk demo dan uji alur. |

Persiapan sekali: `cd agent-runner; npm install`. API key disimpan sebagai environment variable
user `ANTHROPIC_API_KEY` (buka ulang terminal setelah di-set).

**Kenapa lewat Node?** Di laptop kantor, Group Policy Windows membatasi cipher TLS (hampir semua
CBC, tanpa TLS 1.3), sehingga .NET/PowerShell gagal handshake ke `api.anthropic.com`. Node memakai
OpenSSL sendiri, jadi tidak terkena batasan itu. Mode `api` baru bisa dipakai di mesin tanpa
batasan tersebut.

## Alur

```
Customer chat → ① Intake (isi 5 slot kebutuhan)
             → ② BizDev: proposal + quotation           ◆ GATE: Anda menyetujui
             → ③ Business Analyst: BRD                   (bisa bertanya balik ke customer)
                                                          ◆ GATE: Anda menyetujui
             → ④ Project Manager: modul + jumlah developer (spawn instance)
             → ⑤ UI/UX ∥ Architect ∥ Finance & Legal
             → ⑥ Frontend ×N ∥ Backend ×N ∥ Database
             → ⑦ QA ──defect──► kembali ke ⑥ (maks 3 ronde)
             → ⑧ Security (status "blocked" = minta keputusan Anda)
             → ⑨ DevOps                                   ◆ GATE: deploy production
             → ⑩ Marketing ∥ Support ∥ Data Analyst ──feedback──► PM
```

Gate bisa **Approve**, **Request changes** (agent mengulang dengan catatan Anda), atau
**Reject** (proyek berhenti). Centang *Auto-approve gates* untuk menjalankan tanpa jeda.

## Mengatur agent dan model

Semua posisi dan alur ada di [agents.json](agents.json). Bisa diedit langsung, atau lewat
halaman **Registry** di aplikasi (perubahan disimpan kembali ke file).

- **Menambah posisi:** tambahkan entri di `agents`, lalu masukkan id-nya ke salah satu
  `pipeline[].agents`, atau buat stage baru. Di Registry: form *Add a position*.
- **Menambah jumlah agent:** set `"spawnable": true` dan `maxInstances`. PM menentukan
  jumlah instance per proyek (`data.instances` di handoff-nya), dibatasi `maxInstances`.
- **Model:** urutan penentuan (yang pertama ada yang menang):
  1. Override proyek untuk agent itu (tab *Models* di floor)
  2. Override proyek untuk semua agent
  3. Override global untuk agent itu (`overrides` di agents.json / kolom *Global override*)
  4. Override global `"*"` (semua agent)
  5. `model` di agent
  6. `model` di departemen
  7. `defaults.model`

### Dari layar Floor

- **Klik kartu agent** di organigram untuk membuka pengaturannya: aktif/nonaktif, model default
  (semua proyek), override khusus proyek ini, dan effort. Label model di kartu langsung berubah;
  ★ berarti hasil override.
- **Mematikan agent sementara:** hilangkan centang *Active* (di kartu atau kolom *Active* di
  Registry). Tersimpan sebagai `"disabled": true` di agents.json. Agent itu dilewati; tahap yang
  semua agentnya mati dilewati bersama gate-nya. Customer Intake tidak bisa dimatikan.
- **Lebar panel kiri dan kanan** bisa diatur dengan menyeret garis pemisah (atau tombol panah
  saat pemisah fokus). Klik dua kali untuk kembali ke lebar default. Tersimpan per browser.

## Kontrak antar agent

Setiap agent menulis dokumen Markdown dan menutupnya dengan blok handoff:

```json
{"status": "done | need_info | blocked", "summary": "...", "open_questions": [], "data": {}}
```

`need_info` + `canAskCustomer` → pertanyaan muncul di chat customer dan agent diulang dengan
jawabannya. `data` dipakai PM (`modules`, `instances`) dan QA (`bugs`, `defects`).
Dokumen tersimpan di `data/projects/<id>/artifacts/`.

## Kontrol biaya

- `budget.maxTokensPerProject`: kalau terlampaui, alur berhenti di gate *budget*.
- Biaya per agent dihitung dari harga di `models` (USD per 1 juta token).

## Struktur

| File | Isi |
|---|---|
| `Core/Orchestrator.cs` | Intake, stage, spawn, loop QA, gate, pertanyaan ke customer, budget |
| `Core/AgentRegistry.cs` | Baca/simpan agents.json, resolusi model, hitung biaya |
| `Core/AnthropicLlm.cs` | Panggilan Claude API (SDK `Anthropic`) |
| `Core/SimulatedLlm.cs` | Output simulasi per peran |
| `Core/ProjectStore.cs` | Penyimpanan proyek + stream event (SSE) |
| `wwwroot/viz.js` | Animasi lantai operasi (swimlane, paket, gate, spawn, loop) |
| `wwwroot/app.js` | UI: chat, HUD, activity, dokumen, model, registry, replay |
| `tools/export-demo.js` | Merekam proyek selesai → `wwwroot/demo-data.js` untuk `demo.html` |
