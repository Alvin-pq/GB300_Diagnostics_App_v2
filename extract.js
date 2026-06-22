const fs = require('fs');
const html = fs.readFileSync('index_legacy.html', 'utf8');
const match = html.match(/<script type="text\/babel" data-presets="react-classic">([\s\S]*?)<\/script>/);

if (match) {
  let code = match[1];
  const imports = `import React, { useState, useEffect, useMemo, useRef } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { Chart, registerables } from 'chart.js';
import Background3D from './Background3D';
Chart.register(...registerables);

`;
  code = code.replace(/const { useState, useMemo, useEffect } = React;/g, '');
  code = imports + code;
  code = code.replace(/const root = ReactDOM\.createRoot\([\s\S]*?root\.render\([\s\S]*?App \/>\);/, 'export default App;');
  
  // 3D UI modifications
  code = code.replace(/<div className="cyber-bg-container">[\s\S]*?<\/div>\s*<header/, '<Background3D />\n          <header');
  code = code.replace(/bg-slate-900 border border-slate-850/g, 'glass-panel');
  code = code.replace(/bg-slate-800\/50 border border-slate-700/g, 'glass-panel');
  code = code.replace(/bg-slate-900\/50/g, 'glass-panel');
  code = code.replace(/className="min-h-screen text-slate-200 p-6 font-sans flex flex-col relative z-0"/g, 'className="min-h-screen text-slate-200 p-6 font-sans flex flex-col relative z-10 custom-scrollbar"');
  
  fs.writeFileSync('src/App.jsx', code);
  console.log('Extracted and patched successfully!');
} else {
  console.log('Failed to match script block');
}
