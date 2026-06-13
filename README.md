# Pegatron GB300 NVL72 Offline Diagnostics Tool

這是一個專為 **Pegatron GB300 NVL72** 機櫃設計的離線診斷與視覺化分析工具。基於 Electron 與 React 輕量化架構，無須後端伺服器即可在本地高效率分析大規模的感測器日誌。

---

## 🌟 功能特點

1. **極速非阻塞解析 (Non-blocking Parsing)**
   * 內建非同步分批解析器（Chunked Parser），即使導入 5.4MB（高達 13 萬行）的巨量日誌，解析也僅需 **< 300ms**，且 UI 介面完全不凍結、不當機，並伴隨流暢的進度條提示。

2. **歷史最 Worst 情況安全評估**
   * 全局歷史資料掃描：自動在整段日誌的歷史時間序列中，找出各 Tray 的 **T Limit 裕度最低值 (最 worst 值)**，並呈現在第一頁與 UI 詳情面板中，確保對任何短暫的超溫或降頻風險進行嚴格警告。

3. **GPU 數據專用名稱定義**
   * 自動將原廠感測器代號對應重命名為直觀的物理名稱：
     * `Temp_GPU*_0` $\rightarrow$ **`GPU* T junction`** (GPU Junction 絕對溫度)
     * `Temp_GPU*_1` $\rightarrow$ **`GPU* T limit`** (GPU T Limit 安全裕度)

4. **一鍵 Excel 診斷報表匯出**
   * **最低溫總表 (Summary)**：第一頁整合顯示所有 Racks 的 Slot 狀態與歷史 worst T Limit 裕度。
   * **IP 分頁折線圖**：自動為每個 IP 節點產生獨立的工作表，並運用 off-screen chart 渲染，一併產生 **GPU Junction 溫度**、**GPU T Limit 裕度** 以及 **CPU 平均溫度** 隨時間變化的折線趨勢圖。

5. **多 POD 與動態拓樸管理**
   * 支援在執行階段即時「+ 新增 POD」並分別管理不同 POD 下的 Racks 與快取。

---

## 📊 數據定義

本工具針對 GB300 日誌進行了精準的欄位提取與評估：

| 原始日誌欄位 | 系統重命名名稱 | 類型 | 門檻設定 | 說明 |
| :--- | :--- | :--- | :--- | :--- |
| `Temp_GPU*_0` | `GPU* T junction` | 絕對溫度 | 溫度上限 (75°C) | GPU 核心溫度 |
| `Temp_GPU*_1` | `GPU* T limit` | Margin 裕度 | T Limit 裕度下限 (14°C) | 距離觸發降頻的安全溫度差值 |
| `TempAvg_CPU_M*` | `TempAvg_CPU_M*` | 絕對溫度 | 溫度上限 (70°C) | CPU 平均核心溫度 |
| `TempLim_CPU_M*` | `TempLim_CPU_M*` | Margin 裕度 | T Limit 裕度下限 (20°C) | CPU 距離降頻的安全溫度差值 |
| `Leak_*` | `Leak_*` | 漏液狀態 | > 0 異常 | 冷板 (Cold Plate) 與歧管 (Manifold) 漏液監控 |

---

## 🛠️ 本地開發與運行

### 1. 安裝依賴
```bash
npm install
```

### 2. 啟動 Electron 本地 App
```bash
npm start
```

### 3. 以網頁伺服器模式展示 (開發調試)
您可以直接透過網頁伺服器開啟 `index.html`：
```bash
npx serve -p 3000
```
然後在瀏覽器中開啟 [http://localhost:3000](http://localhost:3000)。

### 4. 打包成可執行檔 (.exe)
```bash
npm run build
```

---

## 📁 檔案結構

```text
GB300_Diagnostics_App/
├── index.html          # 主應用程式 (React SPA / UI 與評估邏輯)
├── main.js             # Electron 入口點
├── package.json        # 專案依賴與 Electron 打包配置
└── .gitignore          # Git 排除檔
```
