import React, { useState, useEffect, useMemo, useRef } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { Chart, registerables } from 'chart.js';
import ExcelJS from 'exceljs';
import Background3D from './Background3D';
Chart.register(...registerables);


    

    // Helper: render a Chart.js chart off-screen and return base64 PNG
    function renderChartToBase64({ type = 'bar', data, options = {}, width = 800, height = 400 }) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.style.cssText = 'position:absolute;left:-9999px';
      document.body.appendChild(canvas);
      const chart = new Chart(canvas, {
        type,
        data,
        options: { animation: false, responsive: false, maintainAspectRatio: false, ...options }
      });
      const b64 = canvas.toDataURL('image/png').split(',')[1];
      chart.destroy();
      document.body.removeChild(canvas);
      return b64;
    }

    // --- mapping.ts logic ---
    function generateTopology() {
      const slots = [];
      let computeCount = 1;
      let switchCount = 1;
      for (let i = 1; i <= 27; i++) {
        if (i >= 11 && i <= 19) {
          slots.push({
            slotId: i, type: 'Switch', label: `Switch ${String(switchCount).padStart(2, '0')}`,
            expectedIp: `192.168.10.${switchCount + 100}`
          });
          switchCount++;
        } else {
          slots.push({
            slotId: i, type: 'Compute', label: `Compute ${String(computeCount).padStart(2, '0')}`,
            expectedIp: `192.168.15.${computeCount + 200}`
          });
          computeCount++;
        }
      }
      return slots;
    }

    const NVL72_TOPOLOGY = generateTopology();
    const IP_TO_SLOT_MAP = {};
    NVL72_TOPOLOGY.forEach(slot => {
      if (slot.expectedIp) IP_TO_SLOT_MAP[slot.expectedIp] = slot.slotId;
    });

    const RACK_COUNT = 16;
    function initRacks() {
      const obj = {};
      for (let i = 1; i <= RACK_COUNT; i++) obj[i] = {};
      return obj;
    }
    function initRackArrays() {
      const obj = {};
      for (let i = 1; i <= RACK_COUNT; i++) obj[i] = [];
      return obj;
    }

    const DATA_STREAMS = Array.from({length: 40}).map(() => ({
      left: Math.random() * 100,
      delay: Math.random() * 5,
      duration: 1.5 + Math.random() * 3,
      opacity: 0.3 + Math.random() * 0.7
    }));

    // --- Dynamic Evaluator strictly following user rules ---
    function evaluateMetrics(rows, config) {
      const results = [];
      rows.forEach(row => {
        const ip = (row['IP'] || row['Ip'] || row['ip'] || row['IP Address'] || 'unknown').trim();
        if (ip === 'unknown' && Object.keys(row).length <= 1) return;

        const reasons = [];
        let hasFail = false;

        const gpuTemps = [];
        const gpuMargins = [];
        const cpuTemps = [];
        const cpuMargins = [];
        const cx8Temps = [];

        Object.entries(row).forEach(([col, val]) => {
          const num = parseFloat(val);
          if (isNaN(num)) return;

          const isMargin = col.endsWith('_1') || /TempLim/i.test(col) || /Margin/i.test(col);
          const isAbsTemp = (/Temp/i.test(col) || col.endsWith('_0')) && !isMargin && !/Leak/i.test(col);

          if (isAbsTemp && num < 20) {
            hasFail = true;
            reasons.push(`[感測器防呆] ${col} 溫度低於物理下限異常 (${num}°C < 20°C)`);
          }

          if (/GPU/i.test(col)) {
            if (isAbsTemp) gpuTemps.push(num);
            else if (isMargin) gpuMargins.push(num);
          } else if (/CPU/i.test(col)) {
            if (isAbsTemp) cpuTemps.push(num);
            else if (isMargin) cpuMargins.push(num);
          } else if (/CX/i.test(col) || /IOB/i.test(col)) {
            if (isAbsTemp) cx8Temps.push(num);
          }
        });


        if (gpuTemps.length > 0) {
          const max = Math.max(...gpuTemps);
          const min = Math.min(...gpuTemps);
          const delta = max - min;
          if (delta > config.gpuTempDiffLimit) {
            hasFail = true;
            reasons.push(`[GPU 判定] GPU 群組溫差過大 (${delta.toFixed(1)}°C > ${config.gpuTempDiffLimit}°C)`);
          }
          gpuTemps.forEach(t => {
            if (t > config.gpuTempMax) {
              hasFail = true;
              reasons.push(`[GPU 判定] GPU 溫度超標 (${t}°C > ${config.gpuTempMax}°C)`);
            }
          });
        }
        if (gpuMargins.length > 0) {
          gpuMargins.forEach(m => {
            if (m <= config.gpuLimMin) {
              hasFail = true;
              reasons.push(`[GPU 判定] GPU 觸發降頻保護邊緣 (裕度 ${m} <= ${config.gpuLimMin})`);
            }
          });
        }

        if (cpuTemps.length > 0) {
          const max = Math.max(...cpuTemps);
          const min = Math.min(...cpuTemps);
          const delta = max - min;
          if (delta > config.cpuTempDiffLimit) {
            hasFail = true;
            reasons.push(`[CPU 判定] CPU 群組溫差過大 (${delta.toFixed(1)}°C > ${config.cpuTempDiffLimit}°C)`);
          }
          cpuTemps.forEach(t => {
            if (t > config.cpuTempMax) {
              hasFail = true;
              reasons.push(`[CPU 判定] CPU 溫度超標 (${t}°C > ${config.cpuTempMax}°C)`);
            }
          });
        }
        if (cpuMargins.length > 0) {
          cpuMargins.forEach(m => {
            if (m <= config.cpuLimMin) {
              hasFail = true;
              reasons.push(`[CPU 判定] CPU 觸發降頻保護邊緣 (裕度 ${m} <= ${config.cpuLimMin})`);
            }
          });
        }

        if (cx8Temps.length > 0) {
          const max = Math.max(...cx8Temps);
          const min = Math.min(...cx8Temps);
          const delta = max - min;
          if (delta > config.cxTempDiffLimit) {
            hasFail = true;
            reasons.push(`[CX8 判定] CX8 群組溫差過大 (${delta.toFixed(1)}°C > ${config.cxTempDiffLimit}°C)`);
          }
          cx8Temps.forEach(t => {
            if (t > config.cxTempMax) {
              hasFail = true;
              reasons.push(`[CX8 判定] CX8 溫度超標 (${t}°C > ${config.cxTempMax}°C)`);
            }
          });
        }

        const allMargins = [...gpuMargins, ...cpuMargins];
        const minMargin = allMargins.length > 0 ? Math.min(...allMargins) : null;

        const status = hasFail ? 'FAIL' : 'PASS';
        results.push({ ip, status, reasons, minMargin, raw: row });
      });
      return results;
    }

    // Helper to get stats from raw row for Excel
    function getStatsFromRaw(row) {
      const gpuTemps = [];
      const cpuTemps = [];
      const cx8Temps = [];
      const allMargins = [];
      let isLeaking = false;

      Object.entries(row).forEach(([col, val]) => {
        const num = parseFloat(val);
        if (isNaN(num)) return;
        if (/Leak_/i.test(col) && num > 0) isLeaking = true;
        
        const isMargin = col.endsWith('_1') || /TempLim/i.test(col) || /Margin/i.test(col);
        const isAbsTemp = (/Temp/i.test(col) || col.endsWith('_0')) && !isMargin && !/Leak/i.test(col);

        if (isMargin) {
          allMargins.push(num);
        }

        if (isAbsTemp) {
          if (/GPU/i.test(col)) gpuTemps.push(num);
          else if (/CPU/i.test(col)) cpuTemps.push(num);
          else if (/CX/i.test(col) || /IOB/i.test(col)) cx8Temps.push(num);
        }
      });

      const getStats = (arr) => {
        if (arr.length === 0) return { max: 'N/A', delta: 'N/A' };
        const max = Math.max(...arr);
        const min = Math.min(...arr);
        return { max: max.toFixed(1), delta: (max - min).toFixed(1) };
      };

      const gpu = getStats(gpuTemps);
      const cpu = getStats(cpuTemps);
      const cx8 = getStats(cx8Temps);
      
      const minMargin = allMargins.length > 0 ? Math.min(...allMargins).toFixed(1) : 'N/A';

      return {
        gpuMax: gpu.max,
        gpuDelta: gpu.delta,
        cpuMax: cpu.max,
        cpuDelta: cpu.delta,
        cx8Max: cx8.max,
        cx8Delta: cx8.delta,
        minMargin: minMargin,
        leakStatus: isLeaking ? 'Leak (異常)' : 'Normal (正常)'
      };
    }

    // --- RackTray Component ---
    function RackTray({ slot, data, isSelected, onClick }) {
      const isCompute = slot.type === 'Compute';
      let bgColor = 'bg-slate-800';
      let borderColor = 'border-slate-700';
      let textColor = 'text-slate-400';
      let pulseAnim = '';

      if (data) {
        if (data.status === 'PASS') {
          bgColor = 'bg-emerald-900/40'; borderColor = 'border-emerald-500'; textColor = 'text-emerald-400';
        } else if (data.status === 'FAIL') {
          bgColor = 'bg-rose-900/60'; borderColor = 'border-rose-500'; textColor = 'text-rose-400';
          pulseAnim = 'animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.3)]';
        }
      }

      const selectedClass = isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-slate-900 z-10 scale-[1.02]' : 'hover:border-slate-500';

      return (
        <div
          onClick={() => onClick(slot, data)}
          className={`relative w-full cursor-pointer transition-all duration-200 border-2 rounded-md flex items-center justify-between px-4 ${isCompute ? 'h-10' : 'h-8'} ${bgColor} ${borderColor} ${selectedClass} ${pulseAnim}`}
        >
          <div className="flex items-center gap-3">
            <span className={`font-mono text-xs font-semibold ${textColor}`}>{slot.slotId.toString().padStart(2, '0')}</span>
            <span className="text-sm font-medium text-slate-200">{slot.label}</span>
          </div>
          <div className="flex items-center gap-2">
            {data ? (
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${data.status === 'PASS' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                {data.status}
              </span>
            ) : (
              <span className="text-xs text-slate-500">NO DATA</span>
            )}
          </div>
        </div>
      );
    }

    // --- Main App Component ---
    function App() {
      const [pods, setPods] = useState([{ id: 1, name: 'POD 1' }]);
      const [selectedPodId, setSelectedPodId] = useState(1);
      const [allLatestRawRows, setAllLatestRawRows] = useState({ 1: {} });
      const [allRacksData, setAllRacksData] = useState({ 1: initRacks() });
      const [selectedRack, setSelectedRack] = useState(1);
      const [selectedSlot, setSelectedSlot] = useState(null);
      const [parseProgress, setParseProgress] = useState(null);

      // 初始化全域非響應式大數據快取
      if (!window.diagnosticHistory) {
        window.diagnosticHistory = { 1: {} };
      }

      // Threshold Configuration
      const [config, setConfig] = useState({
        gpuTempDiffLimit: 10,
        gpuTempMax: 75,
        gpuLimMin: 14,
        cpuTempDiffLimit: 10,
        cpuTempMax: 70,
        cpuLimMin: 20,
        cxTempDiffLimit: 10,
        cxTempMax: 75,
      });

      const handleConfigChange = (key, value) => {
        setConfig(prev => ({ ...prev, [key]: value === '' ? '' : Number(value) }));
      };

      const parsedConfig = useMemo(() => ({
        gpuTempDiffLimit: config.gpuTempDiffLimit === '' ? Infinity : Number(config.gpuTempDiffLimit),
        gpuTempMax: config.gpuTempMax === '' ? Infinity : Number(config.gpuTempMax),
        gpuLimMin: config.gpuLimMin === '' ? -Infinity : Number(config.gpuLimMin),
        cpuTempDiffLimit: config.cpuTempDiffLimit === '' ? Infinity : Number(config.cpuTempDiffLimit),
        cpuTempMax: config.cpuTempMax === '' ? Infinity : Number(config.cpuTempMax),
        cpuLimMin: config.cpuLimMin === '' ? -Infinity : Number(config.cpuLimMin),
        cxTempDiffLimit: config.cxTempDiffLimit === '' ? Infinity : Number(config.cxTempDiffLimit),
        cxTempMax: config.cxTempMax === '' ? Infinity : Number(config.cxTempMax),
      }), [config]);

      // Re-evaluate data when config or latest raw rows change
      useEffect(() => {
        const newAllRacksData = {};
        Object.keys(allLatestRawRows).forEach(podId => {
          const podLatest = allLatestRawRows[podId] || {};
          const newRacksData = initRacks();
          
          Object.keys(podLatest).forEach(rackIdStr => {
            const rId = parseInt(rackIdStr, 10);
            const latestRowsByIpMap = podLatest[rId] || {};
            
            const currentRackData = {};
            let nextAvailableSlot = 1;

            Object.keys(latestRowsByIpMap).forEach(ip => {
              const latestRow = latestRowsByIpMap[ip];
              
              // 取得該 IP 在該 Rack 下的所有歷史 rows 數據
              const historyRows = (window.diagnosticHistory[podId] && window.diagnosticHistory[podId][rId] && window.diagnosticHistory[podId][rId][ip]) || [latestRow];
              
              // 評估該 IP 的所有歷史數據
              const evaluatedHistory = evaluateMetrics(historyRows, parsedConfig);

              // 尋找整個歷史過程中，最 worst 的狀態與 T Limit 最低裕度
              let hasFail = false;
              const allReasons = new Set();
              let absoluteMinMargin = Infinity;

              evaluatedHistory.forEach(res => {
                if (res.status === 'FAIL') {
                  hasFail = true;
                  res.reasons.forEach(reason => allReasons.add(reason));
                }
                if (res.minMargin !== null && res.minMargin !== undefined) {
                  const val = parseFloat(res.minMargin);
                  if (!isNaN(val) && val < absoluteMinMargin) {
                    absoluteMinMargin = val;
                  }
                }
              });

              const finalMinMargin = absoluteMinMargin === Infinity ? null : absoluteMinMargin;
              const finalStatus = hasFail ? 'FAIL' : 'PASS';
              const finalReasons = Array.from(allReasons);

              const res = {
                ip: ip,
                status: finalStatus,
                reasons: finalReasons,
                minMargin: finalMinMargin, // 歷史最低點 (最 worst 值)
                raw: latestRow // 畫面細節依舊呈現最新的一列數據
              };

              let slotId = IP_TO_SLOT_MAP[res.ip];
              if (slotId === undefined) {
                while (nextAvailableSlot <= 27) {
                  const slot = NVL72_TOPOLOGY.find(s => s.slotId === nextAvailableSlot);
                  if (slot?.type === 'Compute' && currentRackData[nextAvailableSlot] === undefined) break;
                  nextAvailableSlot++;
                }
                if (nextAvailableSlot <= 27) {
                  slotId = nextAvailableSlot;
                }
              }
              if (slotId !== undefined) {
                currentRackData[slotId] = res;
              }
            });
            newRacksData[rId] = currentRackData;
          });
          newAllRacksData[podId] = newRacksData;
        });
        setAllRacksData(prev => ({ ...prev, ...newAllRacksData }));
      }, [parsedConfig, allLatestRawRows]);

      const racksData = allRacksData[selectedPodId] || initRacks();
      const latestRawRows = allLatestRawRows[selectedPodId] || {};

      const handleFiles = async (files) => {
        if (!files || files.length === 0) return;
        
        const latestRowsByRack = initRacks();
        const historyRowsByRack = initRackArrays();

        // 1. 收集這批上傳檔案涉及的所有 Rack ID，並預先在迴圈外清空快取，支援多檔案累加
        const affectedRacks = new Set();
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const name = file.name.toLowerCase();
          let fileRackId = selectedRack;
          const match = name.match(/rack[-_\s]?([1-9]|1[0-6])/i) || name.match(/cabinet[-_\s]?([1-9]|1[0-6])/i) || name.match(/r([1-9]|1[0-6])/i);
          if (match) fileRackId = parseInt(match[1], 10);
          affectedRacks.add(fileRackId);
        }

        if (!window.diagnosticHistory[selectedPodId]) {
          window.diagnosticHistory[selectedPodId] = {};
        }
        affectedRacks.forEach(rId => {
          window.diagnosticHistory[selectedPodId][rId] = {};
          latestRowsByRack[rId] = {};
        });

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const name = file.name.toLowerCase();
          
          let fileRackId = selectedRack;
          const match = name.match(/rack[-_\s]?([1-9]|1[0-6])/i) || name.match(/cabinet[-_\s]?([1-9]|1[0-6])/i) || name.match(/r([1-9]|1[0-6])/i);
          if (match) fileRackId = parseInt(match[1], 10);

          let fileRows = [];

          if (name.endsWith('.csv') || name.endsWith('.txt')) {
            if (name.endsWith('.txt')) {
              let text = await file.text();
              if (/tray SDR list at /i.test(text)) {
                const parsedData = {};
                let currentIp = null;
                let currentRecord = null;
                const reIp = /(?:Compute|Switch)?\s*tray SDR list at ([\d\.]+):/i;
                const reNumber = /^-?\d+(\.\d+)?/;
                
                const lines = text.split('\n');
                const totalLines = lines.length;
                
                for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
                  let line = lines[lineIdx].trim();
                  if (!line) continue;
                  
                  const matchIp = line.match(reIp);
                  if (matchIp) {
                    if (currentIp && currentRecord) {
                      if (!parsedData[currentIp]) parsedData[currentIp] = [];
                      parsedData[currentIp].push(currentRecord);
                    }
                    currentIp = matchIp[1];
                    currentRecord = { IP: currentIp };
                  } else if (line.includes('|') && currentIp) {
                    const parts = line.split('|');
                    if (parts.length >= 2) {
                      const key = parts[0].trim();
                      const rawValue = parts[1].trim();
                      const lowerVal = rawValue.toLowerCase();
                      if (!['disabled', 'no reading', 'ns', 'unspecified'].includes(lowerVal)) {
                        const matchNum = rawValue.match(reNumber);
                        if (matchNum) {
                          currentRecord[key] = matchNum[0];
                        } else {
                          currentRecord[key] = rawValue;
                        }
                      }
                    }
                  }
                  
                  if (lineIdx > 0 && lineIdx % 5000 === 0) {
                    setParseProgress({
                      fileName: file.name,
                      percent: Math.round((lineIdx / totalLines) * 100)
                    });
                    await new Promise(resolve => setTimeout(resolve, 0));
                  }
                }
                
                if (currentIp && currentRecord) {
                  if (!parsedData[currentIp]) parsedData[currentIp] = [];
                  parsedData[currentIp].push(currentRecord);
                }
                
                Object.values(parsedData).forEach(records => {
                  for (let r = 0; r < records.length; r++) {
                    fileRows.push(records[r]);
                  }
                });
              } else {
                if (!text.includes(',')) {
                  if (text.includes('\t')) {
                    text = text.split('\n').map(line => line.trim().replace(/\t+/g, ',')).join('\n');
                  } else {
                    text = text.split('\n').map(line => line.trim().replace(/\s{2,}/g, ',')).join('\n');
                    if (!text.includes(',')) {
                      text = text.split('\n').map(line => line.trim().replace(/\s+/g, ',')).join('\n');
                    }
                  }
                }
                await new Promise((resolve) => {
                  Papa.parse(text, {
                    header: true, skipEmptyLines: true,
                    complete: (result) => { fileRows = result.data; resolve(); }
                  });
                });
              }
            } else {
              let text = await file.text();
              await new Promise((resolve) => {
                Papa.parse(text, {
                  header: true, skipEmptyLines: true,
                  complete: (result) => { fileRows = result.data; resolve(); }
                });
              });
            }
          } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
            const buffer = await file.arrayBuffer();
            const workbook = XLSX.read(buffer, { type: 'array' });
            
            const sheetsToProcess = workbook.SheetNames.filter(s => !s.toLowerCase().includes('summary') && !s.includes('總表'));
            
            if (sheetsToProcess.length > 0) {
              sheetsToProcess.forEach(sheetName => {
                const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });
                const mappedData = data.map(row => {
                  const newRow = {};
                  for (const key in row) newRow[key] = String(row[key]);
                  if (!newRow['IP'] && /^\d+\.\d+\.\d+\.\d+$/.test(sheetName)) newRow['IP'] = sheetName;
                  return newRow;
                });
                for (let r = 0; r < mappedData.length; r++) {
                  fileRows.push(mappedData[r]);
                }
              });
            } else {
              const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
              fileRows = data.map(row => {
                const newRow = {};
                for (const key in row) newRow[key] = String(row[key]);
                return newRow;
              });
            }
          }

          const totalRows = fileRows.length;
          for (let rowIdx = 0; rowIdx < totalRows; rowIdx++) {
            const row = fileRows[rowIdx];
            
            // 欄位名稱對應重命名: Temp_GPU*_0 -> GPU* T junction, Temp_GPU*_1 -> GPU* T limit
            const mappedRow = {};
            Object.entries(row).forEach(([col, val]) => {
              let newCol = col;
              const matchJunction = col.match(/^Temp_GPU(\d+)_0$/i);
              if (matchJunction) {
                newCol = `GPU${matchJunction[1]} T junction`;
              }
              const matchLimit = col.match(/^Temp_GPU(\d+)_1$/i);
              if (matchLimit) {
                newCol = `GPU${matchLimit[1]} T limit`;
              }
              mappedRow[newCol] = val;
            });

            let rowRackId = fileRackId;
            const rackVal = mappedRow['Rack'] || mappedRow['Rack_ID'] || mappedRow['Cabinet'];
            if (rackVal) {
              const m = String(rackVal).match(/([1-9]|1[0-6])/);
              if (m) rowRackId = parseInt(m[1], 10);
            }
            if (rowRackId >= 1 && rowRackId <= 16) {
              historyRowsByRack[rowRackId].push(mappedRow);
              const ip = (mappedRow['IP'] || mappedRow['Ip'] || mappedRow['ip'] || mappedRow['IP Address'] || 'unknown').trim();
              if (ip !== 'unknown') {
                latestRowsByRack[rowRackId][ip] = mappedRow;
              }
            }
            
            if (rowIdx > 0 && rowIdx % 10000 === 0) {
              setParseProgress({
                fileName: file.name,
                percent: Math.min(99, Math.round(50 + (rowIdx / totalRows) * 50))
              });
              await new Promise(resolve => setTimeout(resolve, 0));
            }
          }
        }

        Object.keys(historyRowsByRack).forEach(rId => {
          const rackRows = historyRowsByRack[rId];
          if (rackRows.length > 0) {
            if (!window.diagnosticHistory[selectedPodId][rId]) {
              window.diagnosticHistory[selectedPodId][rId] = {};
            }
            rackRows.forEach(row => {
              const ip = (row['IP'] || row['Ip'] || row['ip'] || row['IP Address'] || 'unknown').trim();
              if (ip !== 'unknown') {
                if (!window.diagnosticHistory[selectedPodId][rId][ip]) {
                  window.diagnosticHistory[selectedPodId][rId][ip] = [];
                }
                window.diagnosticHistory[selectedPodId][rId][ip].push(row);
              }
            });
          }
        });

        setAllLatestRawRows(prev => {
          const updated = { ...prev };
          if (!updated[selectedPodId]) updated[selectedPodId] = {};
          
          affectedRacks.forEach(rId => {
            updated[selectedPodId][rId] = {};
          });

          Object.keys(latestRowsByRack).forEach(rId => {
            const rackLatestMap = latestRowsByRack[rId];
            if (Object.keys(rackLatestMap).length > 0) {
              updated[selectedPodId][rId] = {
                ...(updated[selectedPodId][rId] || {}),
                ...rackLatestMap
              };
            }
          });
          return updated;
        });

        setParseProgress(null);
      };

      const loadDemoPODData = () => {
        const demoLatestRows = initRacks();
        const demoHistory = initRacks();
        
        for (let rackId = 1; rackId <= 16; rackId++) {
          if (rackId === 8) continue;
          NVL72_TOPOLOGY.forEach(slot => {
            if (slot.type !== 'Compute') return;
            
            let row = {
              'IP Address': slot.expectedIp,
              'Leak_ColdPlate': '0',
              'Leak_Manifold': '0',
              'GPU0 T junction': '32',
              'GPU1 T junction': '35',
              'GPU0 T limit': '18',
              'Temp_CPU0_0': '36',
              'Temp_CPU1_0': '38',
              'TempLim_CPU': '25',
              'Temp_CX8_0': '41',
            };

            // Rack 5 has a Leaking Tray at Slot 3
            if (rackId === 5 && slot.slotId === 3) row['Leak_ColdPlate'] = '2';
            // Rack 6 has an Overheated Tray at Slot 24
            if (rackId === 6 && slot.slotId === 24) row['GPU0 T junction'] = '89.5';
            
            const ip = slot.expectedIp;
            demoLatestRows[rackId][ip] = row;
            
            demoHistory[rackId][ip] = [];
            for (let t = 0; t < 5; t++) {
              const histRow = { ...row };
              histRow['GPU0 T junction'] = String(parseFloat(row['GPU0 T junction']) + Math.sin(t) * 2);
              histRow['Temp_CPU0_0'] = String(parseFloat(row['Temp_CPU0_0']) + Math.cos(t) * 2);
              demoHistory[rackId][ip].push(histRow);
            }
          });
        }
        
        window.diagnosticHistory[selectedPodId] = demoHistory;
        setAllLatestRawRows(prev => ({ ...prev, [selectedPodId]: demoLatestRows }));
        setSelectedSlot(null);
      };

      const handleExportExcel = async () => {
        const summaryData = [];

        for (let rId = 1; rId <= 16; rId++) {
          const rack = racksData[rId];
          if (!rack || Object.keys(rack).length === 0) continue;
          NVL72_TOPOLOGY.forEach(slot => {
            const data = rack[slot.slotId];
            if (!data) return;
            summaryData.push({
              Rack: `Rack ${rId}`, Slot: slot.slotId, Type: slot.type,
              IP: data.ip, Status: data.status,
              minMargin: data.minMargin,
              '錯誤原因摘要': data.reasons.join('; ') || '無'
            });
          });
        }

        if (summaryData.length === 0) {
          alert('目前沒有解析完成的數據可供匯出，請先載入或模擬數據。');
          return;
        }

        const dataByIp = {};
        const podHistory = window.diagnosticHistory[selectedPodId] || {};
        
        Object.keys(podHistory).forEach(rackId => {
          const ipsHistory = podHistory[rackId] || {};
          Object.keys(ipsHistory).forEach(ip => {
            if (ip) {
              dataByIp[ip] = ipsHistory[ip];
            }
          });
        });

        // --- Build ExcelJS workbook ---
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Pegatron GB300 Diagnostics Tool';
        workbook.created = new Date();
        const headerFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
        const headerFont = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };

        // Helper to extract GPU/CPU absolute temps from a row
        const extractTemps = (row) => {
          const gpu = { labels: [], values: [] };
          const cpu = { labels: [], values: [] };
          Object.entries(row).forEach(([col, val]) => {
            const num = parseFloat(val);
            if (isNaN(num)) return;
            const isMargin = col.endsWith('_1') || /TempLim/i.test(col) || /Margin/i.test(col);
            const isAbs = (/Temp/i.test(col) || col.endsWith('_0')) && !isMargin && !/Leak/i.test(col);
            if (!isAbs) return;
            if (/GPU/i.test(col)) { gpu.labels.push(col); gpu.values.push(num); }
            else if (/CPU/i.test(col)) { cpu.labels.push(col); cpu.values.push(num); }
          });
          return { gpu, cpu };
        };

        // --- Summary Sheet ---
        const wsSummary = workbook.addWorksheet('最低溫總表_Summary');
        const sumCols = ['Rack', 'Slot', 'Type', 'IP', 'Status', 'T Limit 裕度 (離限額差值)', '錯誤原因摘要'];
        wsSummary.addRow(sumCols);
        wsSummary.getRow(1).eachCell(c => { c.fill = headerFill; c.font = headerFont; });
        summaryData.forEach(item => {
          const r = wsSummary.addRow([
            item.Rack,
            item.Slot,
            item.Type,
            item.IP,
            item.Status,
            item.minMargin !== null && item.minMargin !== undefined ? `${Number(item.minMargin).toFixed(1)}°C` : 'N/A',
            item['錯誤原因摘要']
          ]);
          const sc = r.getCell(5);
          if (item.Status === 'FAIL') sc.font = { bold: true, color: { argb: 'FFEF4444' } };
          else if (item.Status === 'PASS') sc.font = { bold: true, color: { argb: 'FF10B981' } };
        });
        wsSummary.columns.forEach(c => { c.width = 22; });

        // Summary overview chart
        const oIps = [], oGpu = [], oCpu = [];
        Object.keys(dataByIp).forEach(ip => {
          const { gpu, cpu } = extractTemps(dataByIp[ip][dataByIp[ip].length - 1]);
          oIps.push(ip.replace(/^192\.168\.\d+\./, '.'));
          oGpu.push(gpu.values.length ? Math.max(...gpu.values) : null);
          oCpu.push(cpu.values.length ? Math.max(...cpu.values) : null);
        });
        if (oIps.length > 0) {
          const img = renderChartToBase64({
            width: 1000, height: 420,
            data: {
              labels: oIps,
              datasets: [
                { label: 'GPU Max (°C)', data: oGpu, backgroundColor: 'rgba(99,102,241,0.7)', borderColor: 'rgba(99,102,241,1)', borderWidth: 1 },
                { label: 'CPU Max (°C)', data: oCpu, backgroundColor: 'rgba(16,185,129,0.7)', borderColor: 'rgba(16,185,129,1)', borderWidth: 1 }
              ]
            },
            options: {
              plugins: { title: { display: true, text: 'POD Overview — Max GPU & CPU Temperature per Node', font: { size: 15, weight: 'bold' } }, legend: { position: 'top' } },
              scales: { y: { beginAtZero: false, suggestedMin: 20, title: { display: true, text: '°C' } }, x: { ticks: { font: { size: 9 }, maxRotation: 60, minRotation: 30 } } }
            }
          });
          const imgId = workbook.addImage({ base64: img, extension: 'png' });
          wsSummary.addImage(imgId, { tl: { col: 0, row: summaryData.length + 4 }, ext: { width: 1000, height: 420 } });
        }

        // --- Per-IP Sheets with data + time-series charts ---
        const palette = [
          '#6366f1','#f59e0b','#10b981','#ef4444','#3b82f6','#ec4899',
          '#8b5cf6','#14b8a6','#f97316','#06b6d4','#84cc16','#e11d48',
          '#a855f7','#22d3ee','#eab308','#64748b'
        ];

        // Chart group definitions
        const chartGroups = [
          { pattern: /T junction/i,   title: 'GPU Junction Temperature (T junction)' },
          { pattern: /T limit/i,      title: 'GPU T Limit Margin' },
          { pattern: /^TempAVG_CPU/i, title: 'CPU Avg Temperature Over Time (TempAVG_CPU*)' },
          { pattern: /^Temp_CX7/i,    title: 'CX7 Temperature Over Time (Temp_CX7*)' },
        ];

        for (const ip of Object.keys(dataByIp)) {
          const rows = dataByIp[ip];
          const safeIp = ip.substring(0, 31);
          const ws = workbook.addWorksheet(safeIp);

          // Data table
          const allCols = rows.length > 0 ? Object.keys(rows[0]) : [];
          if (rows.length > 0) {
            ws.addRow(allCols);
            ws.getRow(1).eachCell(c => { c.fill = headerFill; c.font = headerFont; });
            rows.forEach(r => ws.addRow(allCols.map(c => r[c])));
            ws.columns.forEach(c => { c.width = 16; });
          }

          // X-axis labels: reading index (1, 2, 3, ...)
          const xLabels = rows.map((_, i) => `#${i + 1}`);
          let nextRow = rows.length + 4;

          // Render a line chart for each group
          chartGroups.forEach(({ pattern, title }) => {
            const matchingCols = allCols.filter(col => pattern.test(col));
            if (matchingCols.length === 0) return;

            const datasets = matchingCols.map((col, ci) => {
              const color = palette[ci % palette.length];
              return {
                label: col,
                data: rows.map(row => { const v = parseFloat(row[col]); return isNaN(v) ? null : v; }),
                borderColor: color,
                backgroundColor: color + '33',
                borderWidth: 2,
                pointRadius: rows.length > 50 ? 0 : 3,
                pointHoverRadius: 5,
                tension: 0.25,
                fill: false,
                spanGaps: true,
              };
            });

            const img = renderChartToBase64({
              type: 'line',
              width: 950, height: 420,
              data: { labels: xLabels, datasets },
              options: {
                plugins: {
                  title: { display: true, text: `${ip} — ${title}`, font: { size: 14, weight: 'bold' } },
                  legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } }
                },
                scales: {
                  y: { beginAtZero: false, suggestedMin: 20, title: { display: true, text: '°C' } },
                  x: { title: { display: true, text: 'Reading #' }, ticks: { font: { size: 9 }, maxRotation: 0 } }
                }
              }
            });
            const imgId = workbook.addImage({ base64: img, extension: 'png' });
            ws.addImage(imgId, { tl: { col: 0, row: nextRow }, ext: { width: 950, height: 420 } });
            nextRow += 24;
          });
        }

        // Download
        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Pegatron_GB300_Diagnostics_Report_${new Date().toISOString().slice(0,10)}.xlsx`;
        a.click();
        URL.revokeObjectURL(url);
      };

      const getRackStatus = (rackId) => {
        const rack = racksData[rackId];
        if (!rack || Object.keys(rack).length === 0) return 'NO_DATA';
        const hasFail = Object.values(rack).some(v => v.status === 'FAIL');
        return hasFail ? 'FAIL' : 'PASS';
      };

      const selectedRackData = racksData[selectedRack] || {};
      const selectedData = selectedSlot ? selectedRackData[selectedSlot] : undefined;
      const selectedSlotInfo = selectedSlot ? NVL72_TOPOLOGY.find(s => s.slotId === selectedSlot) : undefined;

      const podStats = useMemo(() => {
        let total = 0, pass = 0, fail = 0;
        Object.values(racksData).forEach(rack => {
          const values = Object.values(rack);
          total += values.length;
          pass += values.filter(v => v.status === 'PASS').length;
          fail += values.filter(v => v.status === 'FAIL').length;
        });
        return { total, pass, fail };
      }, [racksData]);

      const isDataImported = podStats.total > 0;

      const renderRackCard = (rId) => {
        const status = getRackStatus(rId);
        const isSelected = selectedRack === rId;
        const rackValues = Object.values(racksData[rId] || {});
        const rackTotalCount = rackValues.length;
        const rackFailCount = rackValues.filter(v => v.status === 'FAIL').length;

        let statusColor = 'border-slate-800 bg-slate-950/40 text-slate-400';
        let statusBadge = 'bg-slate-900 text-slate-500';
        let pulseColor = '';

        if (status === 'FAIL') {
          statusColor = 'border-rose-500/70 bg-rose-950/10 shadow-[inset_0_0_10px_rgba(244,63,94,0.08)] text-rose-300';
          statusBadge = 'bg-rose-500/20 text-rose-400 border border-rose-500/30';
          pulseColor = 'bg-rose-500';
        } else if (status === 'PASS') {
          statusColor = 'border-emerald-500/70 bg-emerald-950/5 shadow-[inset_0_0_10px_rgba(16,185,129,0.05)] text-emerald-300';
          statusBadge = 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
          pulseColor = 'bg-emerald-500';
        }

        const activeClass = isSelected ? 'ring-2 ring-indigo-500 border-indigo-400 scale-[1.02] z-10' : 'hover:border-slate-700 hover:scale-[1.01]';

        return (
          <div key={rId} onClick={() => { setSelectedRack(rId); setSelectedSlot(null); }} className={`cursor-pointer transition-all duration-200 border rounded-lg p-2.5 flex items-center justify-between gap-3 ${statusColor} ${activeClass}`}>
            <div className="w-10 h-16 glass-panel rounded flex flex-col justify-between p-1 relative flex-shrink-0">
              <div className="flex justify-around gap-0.5">
                <div className="w-1.5 h-0.5 bg-slate-700 rounded-sm"></div>
                <div className="w-1.5 h-0.5 bg-slate-700 rounded-sm"></div>
              </div>
              <div className="flex flex-col gap-0.5 flex-1 my-1 justify-center">
                <div className={`h-0.5 w-full rounded-sm ${status === 'FAIL' ? 'bg-rose-500/70 animate-pulse' : status === 'PASS' ? 'bg-emerald-500/70' : 'bg-slate-800'}`}></div>
                <div className={`h-0.5 w-full rounded-sm ${status === 'FAIL' ? 'bg-rose-500/70' : status === 'PASS' ? 'bg-emerald-500/70' : 'bg-slate-800'}`}></div>
                <div className={`h-0.5 w-full rounded-sm ${status === 'FAIL' ? 'bg-rose-500/70' : status === 'PASS' ? 'bg-emerald-500/70' : 'bg-slate-800'}`}></div>
              </div>
              <span className="text-[6px] text-slate-600 text-center font-mono">NVL72</span>
            </div>
            <div className="flex-1 min-w-0 flex flex-col justify-center">
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold text-xs font-mono tracking-wider text-slate-200">Rack 0{rId}</span>
                {pulseColor && (
                  <span className="relative flex h-1.5 w-1.5">
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${pulseColor}`}></span>
                    <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${pulseColor}`}></span>
                  </span>
                )}
              </div>
              <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded uppercase self-start ${statusBadge}`}>
                {status === 'NO_DATA' ? 'NO DATA' : status}
              </span>
              {status !== 'NO_DATA' && (
                <span className="text-[9px] text-slate-500 mt-1 font-mono">{rackTotalCount - rackFailCount}/{rackTotalCount} PASS</span>
              )}
            </div>
          </div>
        );
      };

      return (
        <div className="min-h-screen text-slate-200 p-6 font-sans flex flex-col relative z-10 custom-scrollbar">
          <Background3D />
          <header className="mb-6 flex items-center justify-between border-b border-slate-800 pb-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-white tracking-wide">GB300 NVL72 離線診斷工具</h1>
                <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-gradient-to-r from-slate-900 to-indigo-950 border border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.2)]">
                  <span className="text-xs font-bold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400 tracking-widest uppercase">Pegatron</span>
                  <span className="w-1 h-1 rounded-full bg-slate-600"></span>
                  <span className="text-xs font-mono text-slate-300">作者: Alvin Wang</span>
                </div>
              </div>
              <p className="text-slate-400 text-sm mt-1">100% 離線可用 (免伺服器) | 與線上版同步介面</p>
            </div>
            <div className="flex gap-4 text-sm font-mono items-center">
              <div className="bg-slate-900 px-4 py-2 rounded border border-slate-800">
                POD Nodes: <span className="text-white font-bold">{podStats.total}</span>
              </div>
              <div className="bg-emerald-900/30 px-4 py-2 rounded border border-emerald-900/50">
                POD PASS: <span className="text-emerald-400 font-bold">{podStats.pass}</span>
              </div>
              <div className="bg-rose-900/30 px-4 py-2 rounded border border-rose-900/50">
                POD FAIL: <span className="text-rose-400 font-bold">{podStats.fail}</span>
              </div>
            </div>
          </header>

          <div className="flex gap-2 mb-4 border-b border-slate-800 pb-2 overflow-x-auto custom-scrollbar">
            {pods.map(pod => (
              <button
                key={pod.id}
                onClick={() => { setSelectedPodId(pod.id); setSelectedRack(1); setSelectedSlot(null); }}
                className={`px-4 py-2 rounded-t-lg font-bold text-sm transition-colors ${selectedPodId === pod.id ? 'bg-indigo-600/20 text-indigo-400 border-b-2 border-indigo-500' : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/50'}`}
              >
                {pod.name}
              </button>
            ))}
            <button
              onClick={() => {
                const newId = pods.length > 0 ? Math.max(...pods.map(p => p.id)) + 1 : 1;
                const newPod = { id: newId, name: `POD ${newId}` };
                setPods([...pods, newPod]);
                
                window.diagnosticHistory[newId] = {};
                
                setAllLatestRawRows(prev => ({ ...prev, [newId]: {} }));
                setAllRacksData(prev => ({ ...prev, [newId]: initRacks() }));
                setSelectedPodId(newId);
                setSelectedRack(1);
                setSelectedSlot(null);
              }}
              className="px-3 py-2 text-slate-400 hover:text-white transition-colors flex-shrink-0"
            >
              + 新增 POD
            </button>
          </div>

          <div className="flex flex-1 gap-6 max-w-7xl mx-auto w-full flex-col lg:flex-row items-stretch">
            {/* Column 1: POD Overview */}
            <div className="w-full lg:w-96 flex-shrink-0 flex flex-col">
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-800">
                    <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                      <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                      </svg>
                      One POD Layout
                    </h2>
                    <div className="flex gap-1.5">
                      <button onClick={loadDemoPODData} className="bg-indigo-600/20 hover:bg-indigo-600/40 border border-indigo-500/40 text-indigo-300 px-2 py-1 text-xs rounded transition-colors">
                        模擬整個POD
                      </button>
                      <button 
                        onClick={async () => {
                          setParseProgress({ fileName: '701.40C_94lpm_liquid.txt', percent: 0 });
                          try {
                            const response = await fetch('/701.40C_94lpm_liquid.txt');
                            if (!response.ok) throw new Error('無法讀取測試檔案，請確認檔案已放置在專案目錄下並有啟動伺服器');
                            const text = await response.text();
                            const file = new File([text], '701.40C_94lpm_liquid.txt', { type: 'text/plain' });
                            await handleFiles([file]);
                          } catch (err) {
                            alert('載入測試檔案失敗：' + err.message);
                            setParseProgress(null);
                          }
                        }}
                        className="bg-cyan-600/20 hover:bg-cyan-600/40 border border-cyan-500/40 text-cyan-300 px-2 py-1 text-xs rounded transition-colors"
                      >
                        測試載入 5.4MB 大檔案
                      </button>
                      <button onClick={() => { 
                        if (window.diagnosticHistory[selectedPodId]) {
                          window.diagnosticHistory[selectedPodId] = {};
                        }
                        setAllLatestRawRows(prev => ({ ...prev, [selectedPodId]: {} })); 
                        setAllRacksData(prev => ({ ...prev, [selectedPodId]: initRacks() })); 
                        setSelectedSlot(null); 
                      }} className="bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 px-2 py-1 text-xs rounded transition-colors">
                        清空
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-stretch bg-slate-950 p-2.5 rounded-lg border border-slate-850">
                    <div className="flex flex-col gap-2">
                      <div className="text-[9px] text-slate-500 text-center font-mono font-bold pb-1 border-b border-slate-900">A-ROW (L)</div>
                      {[1, 2, 3, 4, 5, 6, 7, 8].map(rId => renderRackCard(rId))}
                    </div>
                    
                    <div className="w-8 mx-1 bg-gradient-to-b from-blue-950/50 via-cyan-950/20 to-blue-950/50 border-l border-r border-blue-900/30 flex items-center justify-center relative overflow-hidden rounded">
                      <div className="absolute inset-0 opacity-10 pointer-events-none bg-[linear-gradient(to_bottom,transparent_0%,rgba(56,189,248,0.3)_50%,transparent_100%)] animate-pulse"></div>
                      <span style={{ writingMode: 'vertical-rl' }} className="text-[9px] text-blue-400/80 font-mono tracking-[0.3em] font-extrabold uppercase select-none transform rotate-180 origin-center whitespace-nowrap">
                        Cold Aisle
                      </span>
                    </div>

                    <div className="flex flex-col gap-2">
                      <div className="text-[9px] text-slate-500 text-center font-mono font-bold pb-1 border-b border-slate-900">B-ROW (R)</div>
                      {[9, 10, 11, 12, 13, 14, 15, 16].map(rId => renderRackCard(rId))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Column 2: Selected Rack Internal View */}
            <div className="w-full lg:w-80 flex-shrink-0 flex flex-col">
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex-1 overflow-y-auto max-h-[700px] custom-scrollbar">
                <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-850">
                  <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">
                    Rack 0{selectedRack} Internal
                  </h2>
                  <span className="text-xs bg-indigo-900/40 text-indigo-300 px-2.5 py-0.5 rounded-full border border-indigo-800/50 font-mono">
                    {Object.keys(selectedRackData).length} / 18 Active
                  </span>
                </div>
                
                <div className="flex flex-col gap-1.5 bg-slate-950 p-2 rounded border border-slate-850">
                  {NVL72_TOPOLOGY.map((slot) => (
                    <RackTray key={slot.slotId} slot={slot} data={selectedRackData[slot.slotId]} isSelected={selectedSlot === slot.slotId} onClick={(s) => setSelectedSlot(s.slotId)} />
                  ))}
                </div>
              </div>
            </div>

            {/* Column 3: Data Import, Settings, Details */}
            <div className="flex-1 flex flex-col gap-4">
              
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex-1">
                  <h2 className="text-lg font-semibold text-white">Import Sensor Data</h2>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    檔名包含 <code className="text-slate-300 font-mono font-bold bg-slate-950 px-1 py-0.5 rounded">rack1</code>~<code className="text-slate-300 font-mono font-bold bg-slate-950 px-1 py-0.5 rounded">rack8</code> 會自動歸類，否則載入至 <span className="text-indigo-400 font-bold">Rack 0{selectedRack}</span>。
                  </p>
                  {parseProgress && (
                    <div className="mt-3 w-full bg-slate-950 rounded-full h-2.5 overflow-hidden border border-slate-850 relative">
                      <div className="bg-indigo-500 h-full rounded-full transition-all duration-150" style={{ width: `${parseProgress.percent}%` }}></div>
                      <span className="absolute left-0 top-3 text-[10px] text-indigo-400 font-mono font-bold">
                        正在解析 {parseProgress.fileName} ({parseProgress.percent}%)
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex flex-col sm:flex-row gap-3 items-center">
                  <label className="cursor-pointer bg-slate-950 hover:bg-slate-900 border border-slate-700 hover:border-slate-500 rounded-lg px-4 py-2.5 transition-colors flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    <span className="text-slate-300 text-xs font-semibold">匯入 CSV / XLSX / TXT</span>
                    <input type="file" accept=".csv, .xlsx, .xls, .txt" multiple className="hidden" onChange={(e) => { handleFiles(e.target.files); e.target.value = null; }} />
                  </label>
                  <button
                    onClick={handleExportExcel}
                    disabled={!isDataImported}
                    className={`px-4 py-2.5 rounded-lg border text-xs font-bold transition-all flex items-center justify-center gap-2 ${isDataImported ? 'bg-indigo-600 border-indigo-500 text-white shadow-[0_0_15px_rgba(99,102,241,0.4)] hover:bg-indigo-500 hover:scale-[1.02]' : 'bg-slate-800/40 border-slate-800 text-slate-600 cursor-not-allowed'}`}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    匯出 Excel 診斷報表
                  </button>
                </div>
              </div>

              <div className="flex gap-4 flex-1 min-h-[350px] flex-col md:flex-row">
                {/* Settings Panel */}
                <div className="w-full md:w-1/2 bg-slate-900 border border-slate-800 rounded-lg p-5 overflow-y-auto custom-scrollbar">
                  <h2 className="text-sm font-semibold text-white mb-4 border-b border-slate-850 pb-2">參數設定區</h2>
                  
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-xs font-bold text-indigo-400 mb-2 border-l-2 border-indigo-500 pl-2">GPU 門檻設定</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500">溫差上限 (°C)</label>
                          <input type="number" className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white" value={config.gpuTempDiffLimit} onChange={e => handleConfigChange('gpuTempDiffLimit', e.target.value)} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500">溫度上限 (°C)</label>
                          <input type="number" className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white" value={config.gpuTempMax} onChange={e => handleConfigChange('gpuTempMax', e.target.value)} />
                        </div>
                        <div className="flex flex-col gap-1 col-span-2">
                          <label className="text-[10px] text-slate-500">GPU T Limit 裕度下限 (°C)</label>
                          <input type="number" className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white" value={config.gpuLimMin} onChange={e => handleConfigChange('gpuLimMin', e.target.value)} />
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-xs font-bold text-indigo-400 mb-2 border-l-2 border-indigo-500 pl-2">CPU 門檻設定</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500">溫差上限 (°C)</label>
                          <input type="number" className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white" value={config.cpuTempDiffLimit} onChange={e => handleConfigChange('cpuTempDiffLimit', e.target.value)} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500">溫度上限 (°C)</label>
                          <input type="number" className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white" value={config.cpuTempMax} onChange={e => handleConfigChange('cpuTempMax', e.target.value)} />
                        </div>
                        <div className="flex flex-col gap-1 col-span-2">
                          <label className="text-[10px] text-slate-500">CPU T Limit 裕度下限 (°C)</label>
                          <input type="number" className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white" value={config.cpuLimMin} onChange={e => handleConfigChange('cpuLimMin', e.target.value)} />
                        </div>
                      </div>
                    </div>

                    <div>
                      <h3 className="text-xs font-bold text-indigo-400 mb-2 border-l-2 border-indigo-500 pl-2">CX8 網卡門檻設定</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500">溫差上限 (°C)</label>
                          <input type="number" className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white" value={config.cxTempDiffLimit} onChange={e => handleConfigChange('cxTempDiffLimit', e.target.value)} />
                        </div>
                        <div className="flex flex-col gap-1">
                          <label className="text-[10px] text-slate-500">溫度上限 (°C)</label>
                          <input type="number" className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs text-white" value={config.cxTempMax} onChange={e => handleConfigChange('cxTempMax', e.target.value)} />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Details Panel */}
                <div className="w-full md:w-1/2 bg-slate-900 border border-slate-800 rounded-lg p-5 overflow-y-auto custom-scrollbar">
                  <h2 className="text-sm font-semibold text-white mb-4 border-b border-slate-850 pb-2">Tray Details</h2>
                  
                  {!selectedSlotInfo ? (
                    <div className="h-full flex items-center justify-center text-slate-500 italic text-sm">
                      請點擊左側機櫃內部的 Tray
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex justify-between items-start flex-wrap gap-2">
                        <div>
                          <h3 className="text-lg font-bold text-white flex items-center gap-2">
                            {selectedSlotInfo.label}
                            <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono font-normal">
                              Rack 0{selectedRack}
                            </span>
                          </h3>
                          <p className="text-slate-400 font-mono text-[10px] mt-1">
                            Slot: {selectedSlotInfo.slotId.toString().padStart(2, '0')} | IP: {selectedData?.ip || selectedSlotInfo.expectedIp || 'N/A'}
                          </p>
                        </div>
                        {selectedData && (
                          <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wider ${selectedData.status === 'PASS' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'}`}>
                            {selectedData.status}
                          </span>
                        )}
                      </div>

                      {selectedData?.status === 'FAIL' && (
                        <div className="bg-rose-950/20 border border-rose-900/50 rounded-lg p-3">
                          <h4 className="text-rose-400 font-semibold mb-2 text-xs">故障原因</h4>
                          <ul className="list-disc list-inside space-y-1 text-rose-300 text-xs ml-1">
                            {selectedData.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
                          </ul>
                        </div>
                      )}

                      {selectedData?.status === 'PASS' && (
                        <div className="bg-emerald-950/20 border border-emerald-900/50 rounded-lg p-3 text-emerald-400 text-xs">
                          所有感測器數值皆在正常範圍內。
                        </div>
                      )}

                      {selectedData && (
                        <div className="bg-slate-950 rounded p-3 border border-slate-850 flex justify-between items-center text-xs">
                          <span className="text-slate-400 font-medium">T Limit 裕度 (離限額差值)</span>
                          <span className={`font-mono font-bold text-sm ${selectedData.minMargin !== null && selectedData.minMargin <= (selectedSlotInfo.type === 'Compute' ? parsedConfig.cpuLimMin : parsedConfig.gpuLimMin) ? 'text-rose-400' : 'text-emerald-400'}`}>
                            {selectedData.minMargin !== null && selectedData.minMargin !== undefined ? `${Number(selectedData.minMargin).toFixed(1)}°C` : 'N/A'}
                          </span>
                        </div>
                      )}

                      {selectedData && (
                        <div>
                          <h4 className="text-slate-400 font-semibold mb-1 text-[10px] uppercase tracking-wider">原始感測器數據</h4>
                          <div className="bg-slate-950 rounded p-2 overflow-x-auto border border-slate-850">
                            <pre className="text-[10px] text-slate-400 font-mono">
                              {JSON.stringify(Object.fromEntries(Object.entries(selectedData.raw).filter(([k]) => /GPU/i.test(k))), null, 2)}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>
        </div>
      );
    }

    export default App;
  