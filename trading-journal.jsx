const { useState, useEffect, useRef } = React;

const STRATEGIES = ["Trend Follow", "Breakout", "Pullback", "Mean Reversion", "Scalp", "VWAP Fade", "Opening Range", "News Play", "Overnight Gap", "ICT/SMC", "Order Flow", "Momentum", "Other"];
const EMOTIONS = ["Calm", "Disciplined", "Confident", "In the Zone", "FOMO", "Anxious", "Greedy", "Fearful", "Revenge", "Bored", "Overconfident", "Distracted"];
const INSTRUMENTS = ["ES", "NQ", "MES", "MNQ", "YM", "RTY", "CL", "GC", "SI", "ZB", "ZN", "6E", "Other"];
const SESSIONS = ["Pre-Market", "RTH Open", "RTH Mid", "RTH Close", "Overnight"];
const POINT_VALUES = { ES: 50, NQ: 20, MES: 5, MNQ: 2, YM: 5, RTY: 50, CL: 1000, GC: 100, SI: 5000, ZB: 1000, ZN: 1000, "6E": 125000, Other: 50 };
const KNOWN_INSTRUMENTS = new Set(Object.keys(POINT_VALUES));

const emotionColors = {
  "Calm": "#7fffb2", "Disciplined": "#00ddff", "Confident": "#aaff44", "In the Zone": "#ffdd00",
  "FOMO": "#ff9900", "Anxious": "#ff7744", "Greedy": "#ff5566", "Fearful": "#ff3355",
  "Revenge": "#ff0033", "Bored": "#666688", "Overconfident": "#ffbb00", "Distracted": "#bb66ff"
};

function calcPnl(trade) {
  const diff = trade.direction === "Long" ? trade.exit - trade.entry : trade.entry - trade.exit;
  return parseFloat((diff * trade.size * (POINT_VALUES[trade.market] || 50)).toFixed(2));
}

function formatDateToYMD(dateString) {
  if (!dateString) return "";

  // If already in YYYY-MM-DD format, return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return dateString;
  }

  // Handle MM/DD/YYYY format
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateString)) {
    const [month, day, year] = dateString.split('/');
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  // Try to parse other formats
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString; // Return original if invalid

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch {
    return dateString;
  }
}

function formatDateDisplay(dateString) {
  // Convert YYYY-MM-DD to MM/DD/YYYY for display
  if (!dateString) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const [year, month, day] = dateString.split('-');
    return `${month}/${day}/${year}`;
  }
  return dateString;
}

function getTodayLocalDate() {
  // Get today's date in local timezone as YYYY-MM-DD
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function detectSession(timestamp) {
  const date = new Date(timestamp);
  const etString = date.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etString);
  const time = etDate.getHours() * 60 + etDate.getMinutes();
  if (time >= 570 && time < 630) return "RTH Open";
  if (time >= 630 && time < 900) return "RTH Mid";
  if (time >= 900 && time < 960) return "RTH Close";
  if (time >= 960 && time < 1080) return "Overnight";
  return "Pre-Market";
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map(line => {
    const values = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQuotes = !inQuotes; }
      else if (line[i] === ',' && !inQuotes) { values.push(current.trim()); current = ""; }
      else { current += line[i]; }
    }
    values.push(current.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ""; });
    return row;
  });
}

function parseTradovateCsv(text) {
  const rows = parseCSV(text);
  if (rows.length === 0) return { trades: [], error: "No data rows found in CSV." };

  // Only keep filled orders
  const filled = rows.filter(r => (r["Status"] || "").toLowerCase() === "filled");
  if (filled.length === 0) return { trades: [], error: "No filled orders found. Make sure you exported from the Orders tab." };

  // Group by Product (instrument) and pair buys/sells into round trips
  const byProduct = {};
  for (const row of filled) {
    const product = (row["Product"] || "").trim();
    if (!byProduct[product]) byProduct[product] = [];
    byProduct[product].push(row);
  }

  const trades = [];

  for (const [product, orders] of Object.entries(byProduct)) {
    // Sort by fill time
    orders.sort((a, b) => new Date(a["Fill Time"] || a["Timestamp"] || a["Date"]) - new Date(b["Fill Time"] || b["Timestamp"] || b["Date"]));

    let position = 0;
    let openOrders = [];

    for (const order of orders) {
      const bs = (order["B/S"] || "").trim();
      const qty = parseInt(order["Filled Qty"] || order["filledQty"] || order["Quantity"] || "0");
      const price = parseFloat(order["Avg Fill Price"] || order["avgPrice"] || "0");
      if (!qty || !price || !bs) continue;

      const signed = bs.toLowerCase().startsWith("b") ? qty : -qty;
      const prevPosition = position;
      position += signed;

      if (prevPosition === 0) {
        openOrders = [{ bs, qty, price, time: order["Fill Time"] || order["Timestamp"] || order["Date"] }];
      } else if (position === 0 || (prevPosition !== 0 && Math.sign(position) !== Math.sign(prevPosition))) {
        // Round trip complete
        const entryQty = Math.abs(prevPosition);
        const entryPrice = openOrders.reduce((s, o) => s + o.price * o.qty, 0) / openOrders.reduce((s, o) => s + o.qty, 0);
        const exitPrice = price;
        const direction = prevPosition > 0 ? "Long" : "Short";
        const entryTime = openOrders[0].time;

        // Resolve instrument
        const rootSymbol = product.replace(/[FGHJKMNQUVXZ]\d{1,2}$/, "");
        const market = KNOWN_INSTRUMENTS.has(rootSymbol) ? rootSymbol : (KNOWN_INSTRUMENTS.has(product) ? product : "Other");

        const trade = {
          id: `csv-${Date.now()}-${trades.length}`,
          date: formatDateToYMD(entryTime),
          ticker: market,
          market,
          direction,
          entry: parseFloat(entryPrice.toFixed(6)),
          exit: parseFloat(exitPrice.toFixed(6)),
          size: entryQty,
          strategy: "Other",
          emotion: "Calm",
          session: entryTime ? detectSession(entryTime) : "RTH Mid",
          notes: "[Imported from Tradovate CSV]",
          source: "csv",
        };
        trade.pnl = calcPnl(trade);
        trades.push(trade);

        if (position !== 0) {
          openOrders = [{ bs, qty: Math.abs(position), price, time: order["Fill Time"] || order["Timestamp"] || order["Date"] }];
        } else {
          openOrders = [];
        }
      } else {
        openOrders.push({ bs, qty, price, time: order["Fill Time"] || order["Timestamp"] || order["Date"] });
      }
    }
  }

  trades.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { trades, error: null };
}

const initialTrades = [
  { id: 1, date: "2026-02-24", ticker: "ES", market: "ES", direction: "Long", entry: 5820.25, exit: 5832.50, size: 2, strategy: "Opening Range", emotion: "Disciplined", session: "RTH Open", notes: "Clean ORB setup. Waited for 9:45 confirm. Held to full target. Textbook execution.", pnl: 1225 },
  { id: 2, date: "2026-02-25", ticker: "NQ", market: "NQ", direction: "Short", entry: 20450, exit: 20510, size: 1, strategy: "VWAP Fade", emotion: "Revenge", session: "RTH Mid", notes: "Took this after a losing trade. Rushed entry, no patience. Stopped out at highs.", pnl: -1200 },
  { id: 3, date: "2026-02-26", ticker: "CL", market: "CL", direction: "Long", entry: 71.20, exit: 71.85, size: 2, strategy: "Trend Follow", emotion: "Calm", session: "RTH Open", notes: "EIA inventory report play. Clean trend continuation setup. Let it run to target.", pnl: 1300 },
  { id: 4, date: "2026-02-27", ticker: "MES", market: "MES", direction: "Short", entry: 5795.50, exit: 5783.00, size: 5, strategy: "Breakout", emotion: "Confident", session: "Pre-Market", notes: "Pre-market breakdown below overnight lows. Clean entry, held to target.", pnl: 312 },
];

function TradingJournal() {
  // Load trades from localStorage or use initial trades
  const [trades, setTrades] = useState(() => {
    try {
      const saved = localStorage.getItem('tradingJournalTrades');
      let loadedTrades = saved ? JSON.parse(saved) : initialTrades;

      // Migrate old date formats to YYYY-MM-DD
      loadedTrades = loadedTrades.map(trade => ({
        ...trade,
        date: formatDateToYMD(trade.date)
      }));

      return loadedTrades;
    } catch (error) {
      console.error('Failed to load trades from localStorage:', error);
      return initialTrades;
    }
  });
  const [view, setView] = useState("dashboard");
  const [showForm, setShowForm] = useState(false);
  const [calendarDate, setCalendarDate] = useState(new Date());

  // Custom strategies
  const [customStrategies, setCustomStrategies] = useState(() => {
    try {
      const saved = localStorage.getItem('tradingJournalCustomStrategies');
      return saved ? JSON.parse(saved) : [];
    } catch (error) {
      return [];
    }
  });
  const [showStrategyManager, setShowStrategyManager] = useState(false);
  const [newStrategy, setNewStrategy] = useState("");
  const [isDark, setIsDark] = useState(() => {
    try {
      const saved = localStorage.getItem('tradingJournalTheme');
      return saved ? JSON.parse(saved) : true;
    } catch (error) {
      return true;
    }
  });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiReport, setAiReport] = useState("");
  const [aiError, setAiError] = useState("");
  const [expandedTrade, setExpandedTrade] = useState(null);
  const [tradeAi, setTradeAi] = useState({});
  const [filterSession, setFilterSession] = useState("All");
  const [form, setForm] = useState({ date: new Date().toISOString().split("T")[0], ticker: "", market: "ES", direction: "Long", entry: "", exit: "", size: "1", strategy: "Opening Range", emotion: "Calm", session: "RTH Open", notes: "" });

  // Save trades to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem('tradingJournalTrades', JSON.stringify(trades));
    } catch (error) {
      console.error('Failed to save trades to localStorage:', error);
    }
  }, [trades]);

  // Save theme preference to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('tradingJournalTheme', JSON.stringify(isDark));
    } catch (error) {
      console.error('Failed to save theme to localStorage:', error);
    }
  }, [isDark]);

  // Save custom strategies to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('tradingJournalCustomStrategies', JSON.stringify(customStrategies));
    } catch (error) {
      console.error('Failed to save custom strategies to localStorage:', error);
    }
  }, [customStrategies]);

  // --- CSV Import state ---
  const [showImport, setShowImport] = useState(false);
  const [importDragOver, setImportDragOver] = useState(false);
  const [importResult, setImportResult] = useState(null); // { trades: [], error: null }
  const [importPreview, setImportPreview] = useState(null); // trades to preview before confirming
  const fileInputRef = useRef(null);

  // --- Delete state ---
  const [deleteConfirm, setDeleteConfirm] = useState(null); // trade id to delete

  // --- Edit strategy state ---
  const [editStrategyTrade, setEditStrategyTrade] = useState(null); // trade being edited
  const [editStrategyValue, setEditStrategyValue] = useState("");

  // --- Edit emotion state ---
  const [editEmotionTrade, setEditEmotionTrade] = useState(null); // trade being edited
  const [editEmotionValue, setEditEmotionValue] = useState("");

  function handleCsvFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = parseTradovateCsv(e.target.result);
      if (result.error) {
        setImportResult({ count: 0, error: result.error });
        setImportPreview(null);
      } else if (result.trades.length === 0) {
        setImportResult({ count: 0, error: "No completed round-trip trades found in file." });
        setImportPreview(null);
      } else {
        setImportPreview(result.trades);
        setImportResult(null);
      }
    };
    reader.readAsText(file);
  }

  function confirmImport() {
    if (!importPreview) return;
    setTrades(prev => [...importPreview, ...prev].sort((a, b) => new Date(b.date) - new Date(a.date)));
    setImportResult({ count: importPreview.length, error: null });
    setImportPreview(null);
  }

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl < 0);
  const winRate = trades.length ? Math.round((winners.length / trades.length) * 100) : 0;
  const avgWin = winners.length ? winners.reduce((s, t) => s + t.pnl, 0) / winners.length : 0;
  const avgLoss = losers.length ? Math.abs(losers.reduce((s, t) => s + t.pnl, 0) / losers.length) : 1;
  const profitFactor = losers.length ? ((avgWin * winners.length) / (avgLoss * losers.length)).toFixed(2) : "\u221e";
  const maxDD = (() => { let peak = 0, mdd = 0, run = 0; trades.slice().reverse().forEach(t => { run += t.pnl; if (run > peak) peak = run; const d = peak - run; if (d > mdd) mdd = d; }); return mdd; })();

  const filtered = filterSession === "All" ? trades : trades.filter(t => t.session === filterSession);
  const cumPnl = trades.slice().reverse().reduce((acc, t) => { acc.push((acc.length ? acc[acc.length - 1] : 0) + t.pnl); return acc; }, []);
  const maxCum = Math.max(...cumPnl.map(Math.abs), 1);

  const previewPnl = form.entry && form.exit && form.size ? calcPnl({ ...form, entry: +form.entry, exit: +form.exit, size: +form.size }) : null;

  function handleSubmit() {
    if (!form.entry || !form.exit || !form.size) return;
    const t = { ...form, id: Date.now(), entry: +form.entry, exit: +form.exit, size: +form.size, ticker: form.market, source: "manual" };
    t.pnl = calcPnl(t);
    setTrades(p => [t, ...p]);
    setForm({ date: new Date().toISOString().split("T")[0], ticker: "", market: "ES", direction: "Long", entry: "", exit: "", size: "1", strategy: "Opening Range", emotion: "Calm", session: "RTH Open", notes: "" });
    setShowForm(false);
  }

  async function runAnalysis() {
    setAiLoading(true); setAiReport(""); setAiError("");
    const summary = trades.map(t => `${t.date}|${t.ticker}|${t.direction}|E:${t.entry} X:${t.exit} ${t.size}ct|$${t.pnl}|${t.strategy}|${t.emotion}|${t.session}|${t.notes}`).join("\n");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: `You are an elite futures trading coach. Analyze this trader's journal:\n\n${summary}\n\nProvide:\n1. **Edge Assessment** \u2014 where is the real edge and why?\n2. **Psychological Patterns** \u2014 what emotional tendencies are costing them money? Be specific and direct.\n3. **Session Timing** \u2014 which sessions/times show best vs worst performance?\n4. **Risk Management** \u2014 position sizing and stop discipline assessment\n5. **Top 3 Action Items** \u2014 specific changes to implement next week\n\nBe sharp and direct. Use futures terminology. Under 450 words.` }] }) });
      const data = await res.json();
      setAiReport(data.content?.map(b => b.text || "").join("") || "No response.");
    } catch { setAiError("Failed to reach AI. Please try again."); }
    setAiLoading(false);
  }

  async function analyzeOne(trade) {
    setTradeAi(p => ({ ...p, [trade.id]: { loading: true, text: "" } }));
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: `Analyze this futures trade as a coach:\n\n${trade.ticker} | ${trade.direction} | Entry: ${trade.entry} Exit: ${trade.exit} | ${trade.size} contracts | P&L: $${trade.pnl}\nStrategy: ${trade.strategy} | Session: ${trade.session} | Emotion: ${trade.emotion}\nNotes: ${trade.notes}\n\nGive: (1) Execution quality \u2014 was entry/exit well-timed for this setup? (2) How did their emotional state (${trade.emotion}) affect this trade? (3) One specific improvement. Use futures terminology. 3 concise paragraphs.` }] }) });
      const data = await res.json();
      setTradeAi(p => ({ ...p, [trade.id]: { loading: false, text: data.content?.map(b => b.text || "").join("") || "No response." } }));
    } catch { setTradeAi(p => ({ ...p, [trade.id]: { loading: false, text: "Analysis failed." } })); }
  }

  function deleteTrade(id) {
    setTrades(prev => prev.filter(t => t.id !== id));
    setDeleteConfirm(null);
    setExpandedTrade(null);
  }

  function addCustomStrategy() {
    const trimmed = newStrategy.trim();
    if (!trimmed) return;
    if (STRATEGIES.includes(trimmed) || customStrategies.includes(trimmed)) {
      alert('Strategy already exists!');
      return;
    }
    setCustomStrategies(prev => [...prev, trimmed]);
    setNewStrategy("");
  }

  function deleteCustomStrategy(strategy) {
    setCustomStrategies(prev => prev.filter(s => s !== strategy));
  }

  function openEditStrategy(trade) {
    setEditStrategyTrade(trade);
    setEditStrategyValue(trade.strategy);
  }

  function saveEditStrategy() {
    if (!editStrategyTrade || !editStrategyValue) return;
    setTrades(prev => prev.map(t =>
      t.id === editStrategyTrade.id
        ? { ...t, strategy: editStrategyValue }
        : t
    ));
    setEditStrategyTrade(null);
    setEditStrategyValue("");
  }

  function openEditEmotion(trade) {
    setEditEmotionTrade(trade);
    setEditEmotionValue(trade.emotion);
  }

  function saveEditEmotion() {
    if (!editEmotionTrade || !editEmotionValue) return;
    setTrades(prev => prev.map(t =>
      t.id === editEmotionTrade.id
        ? { ...t, emotion: editEmotionValue }
        : t
    ));
    setEditEmotionTrade(null);
    setEditEmotionValue("");
  }

  // Combined strategy list (default + custom)
  const allStrategies = [...STRATEGIES, ...customStrategies];

  const stratPerf = allStrategies.map(s => { const st = trades.filter(t => t.strategy === s); const w = st.filter(t => t.pnl > 0); return { name: s, count: st.length, pnl: st.reduce((a, t) => a + t.pnl, 0), wr: st.length ? Math.round(w.length / st.length * 100) : 0 }; }).filter(s => s.count > 0).sort((a, b) => b.pnl - a.pnl);
  const emotPerf = EMOTIONS.map(e => { const em = trades.filter(t => t.emotion === e); return { name: e, count: em.length, pnl: em.reduce((a, t) => a + t.pnl, 0) }; }).filter(e => e.count > 0).sort((a, b) => b.pnl - a.pnl);
  const sessPerf = SESSIONS.map(s => { const st = trades.filter(t => t.session === s); return { name: s, count: st.length, pnl: st.reduce((a, t) => a + t.pnl, 0) }; }).filter(s => s.count > 0);

  return (
    <div style={{ fontFamily: "'DM Mono','Courier New',monospace", background: isDark ? "#06060d" : "#f9f9f2", minHeight: "100vh", color: "#d8d8ec" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=Syne:wght@700;800&display=swap');
        body { background: ${isDark ? "#06060d" : "#f9f9f2"}; margin: 0; }
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-thumb{background:#1e1e30;border-radius:2px;}
        .nb{background:none;border:none;cursor:pointer;padding:8px 13px;border-radius:4px;font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.08em;transition:all .2s;color:#8a8aa8;text-transform:uppercase;}
        .nb.on{color:#7fffb2;background:rgba(127,255,178,.07);}
        .nb:hover{color:#d8d8ec;}
        .card{background:#0c0c16;border:1px solid #181828;border-radius:8px;padding:20px;}
        .gbtn{background:#7fffb2;color:#06060d;border:none;cursor:pointer;padding:10px 22px;border-radius:4px;font-family:'DM Mono',monospace;font-size:11px;font-weight:500;letter-spacing:.1em;transition:all .2s;text-transform:uppercase;}
        .gbtn:hover{background:#5de89a;transform:translateY(-1px);}
        .gbtn:disabled{opacity:.5;cursor:not-allowed;transform:none;}
        .ghost{background:none;border:1px solid #222235;color:#ccc;cursor:pointer;padding:6px 13px;border-radius:4px;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.08em;transition:all .2s;text-transform:uppercase;}
        .ghost:hover{border-color:#5de89a;color:#5de89a;}
        input,select,textarea{background:#0a0a14;border:1px solid #181828;color:#d8d8ec;padding:8px 12px;border-radius:4px;font-family:'DM Mono',monospace;font-size:12px;width:100%;transition:border .2s;outline:none;}
        input:focus,select:focus,textarea:focus{border-color:#7fffb2;}
        select option{background:#0a0a14;}
        .pos{color:#7fffb2;}.neg{color:#ff4466;}
        .tag{display:inline-block;padding:2px 7px;border-radius:3px;font-size:10px;letter-spacing:.05em;}
        .ai-text{white-space:pre-wrap;line-height:1.8;font-size:12px;color:#9a9abc;font-style:italic;}
        .trow{border-bottom:1px solid #0f0f1e;transition:background .15s;cursor:pointer;}
        .trow:hover{background:#0e0e1c;}
        .pulse{animation:p 1.8s infinite;}
        @keyframes p{0%,100%{opacity:1;}50%{opacity:.4;}}
        .ov{position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:50;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);}
        .modal{background:#0c0c18;border:1px solid #22223a;border-radius:12px;padding:28px;width:100%;max-width:580px;max-height:92vh;overflow-y:auto;}
        .lbl{font-size:10px;color:#8888a8;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px;display:block;}
        .tv-badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:8px;letter-spacing:.1em;background:rgba(0,221,255,.1);color:#00ddff;margin-left:6px;vertical-align:middle;}
      `}</style>

      {/* THEME TOGGLE */}
      <div style={{ position: "fixed", bottom: 24, left: 24, zIndex: 100 }}>
        <button className="ghost" onClick={() => setIsDark(d => !d)} style={{ width: 44, height: 44, borderRadius: "50%", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", background: isDark ? "#111120" : "#ffffff", border: `1px solid ${isDark ? "#222235" : "#e0e0e0"}`, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", fontSize: 20 }}>
          {isDark ? "☀️" : "🌙"}
        </button>
      </div>

      <div style={{ background: "#06060d", minHeight: "100vh", filter: isDark ? "none" : "invert(1) hue-rotate(180deg)", transition: "filter 0.3s ease" }}>
        {/* HEADER */}
        <div style={{ borderBottom: "1px solid #0f0f1e", padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#080810" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <svg width="22" height="22" viewBox="0 0 22 22"><rect x="2" y="10" width="4" height="10" fill="#7fffb2" rx="1" /><rect x="9" y="5" width="4" height="15" fill="#7fffb2" opacity=".7" rx="1" /><rect x="16" y="1" width="4" height="19" fill="#7fffb2" opacity=".4" rx="1" /></svg>
            <span style={{ fontFamily: "Syne,sans-serif", fontWeight: 800, fontSize: 16, letterSpacing: ".15em", color: "#fff" }}>EDGE</span>
            <span style={{ color: "#6c6c8c", fontSize: 11, letterSpacing: ".05em" }}>FUTURES JOURNAL</span>
          </div>
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            {[["dashboard", "Dashboard"], ["trades", "Trades"], ["calendar", "Calendar"], ["analytics", "Analytics"], ["ai-coach", "AI Coach"]].map(([v, l]) => (
              <button key={v} className={`nb ${view === v ? "on" : ""}`} onClick={() => setView(v)}>{l}</button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button className="ghost" onClick={() => { setShowImport(true); setImportResult(null); setImportPreview(null); }}>Import CSV</button>
            <button className="gbtn" onClick={() => setShowForm(true)}>+ Log Trade</button>
          </div>
        </div>

        <div style={{ padding: "24px 28px", maxWidth: 1120, margin: "0 auto" }}>

          {/* DASHBOARD */}
          {view === "dashboard" && (
            <div>
              <p style={{ fontFamily: "Syne,sans-serif", fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 4 }}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
              <p style={{ color: "#9595b0", fontSize: 11, letterSpacing: ".05em", marginBottom: 22 }}>{trades.length} trades logged</p>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, marginBottom: 20 }}>
                {[
                  { l: "Net P&L", v: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toLocaleString()}`, pos: totalPnl >= 0, big: true },
                  { l: "Win Rate", v: `${winRate}%`, pos: winRate >= 50 },
                  { l: "Profit Factor", v: profitFactor, pos: parseFloat(profitFactor) >= 1.5 },
                  { l: "Avg Win", v: `+$${avgWin.toFixed(0)}`, pos: true },
                  { l: "Max Drawdown", v: `-$${maxDD.toFixed(0)}`, pos: false },
                ].map(s => (
                  <div key={s.l} style={{ background: "#090912", border: "1px solid #131325", borderRadius: 6, padding: "14px 16px" }}>
                    <p className="lbl" style={{ marginBottom: 8 }}>{s.l}</p>
                    <p style={{ fontFamily: "Syne,sans-serif", fontSize: s.big ? 22 : 18, fontWeight: 700, color: s.pos ? "#7fffb2" : "#ff4466" }}>{s.v}</p>
                  </div>
                ))}
              </div>

              <div className="card" style={{ marginBottom: 16 }}>
                <p className="lbl" style={{ marginBottom: 10 }}>Equity Curve</p>
                <div style={{ height: 72, display: "flex", alignItems: "flex-end", gap: 3 }}>
                  {cumPnl.map((v, i) => {
                    const h = Math.max(3, (Math.abs(v) / maxCum) * 66);
                    return <div key={i} style={{ flex: 1, height: h, borderRadius: "2px 2px 0 0", background: v >= 0 ? "#7fffb2" : "#ff4466", opacity: .7 }} />;
                  })}
                </div>
              </div>

              <div className="card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                  <p className="lbl" style={{ margin: 0 }}>Recent Trades</p>
                  <button className="ghost" onClick={() => setView("trades")}>View All \u2192</button>
                </div>
                {trades.slice(0, 6).map(t => (
                  <div key={t.id} className="trow" style={{ display: "grid", gridTemplateColumns: "80px 55px 1fr 60px 100px 30px", alignItems: "center", padding: "11px 4px", gap: 12 }}>
                    <div>
                      <p style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, color: "#fff", fontSize: 14 }}>
                        {t.ticker}
                        {t.source === "csv" && <span className="tv-badge">CSV</span>}
                      </p>
                      <p style={{ fontSize: 10, color: "#9a9ab5" }}>{formatDateDisplay(t.date)}</p>
                    </div>
                    <span className="tag" style={{ background: t.direction === "Long" ? "rgba(127,255,178,.1)" : "rgba(255,68,102,.1)", color: t.direction === "Long" ? "#7fffb2" : "#ff4466", width: "fit-content" }}>{t.direction}</span>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                      <span className="tag" onClick={(e) => { e.stopPropagation(); openEditStrategy(t); }} style={{ background: "#111120", color: "#ccc", cursor: "pointer", position: "relative" }} title="Click to edit strategy">
                        {t.strategy}
                        <span style={{ fontSize: 8, marginLeft: 4, opacity: 0.5 }}>✎</span>
                      </span>
                      <span className="tag" onClick={(e) => { e.stopPropagation(); openEditEmotion(t); }} style={{ color: emotionColors[t.emotion] || "#888", background: `${emotionColors[t.emotion] || "#888"}14`, cursor: "pointer" }} title="Click to edit emotion">
                        {t.emotion}
                        <span style={{ fontSize: 8, marginLeft: 4, opacity: 0.5 }}>✎</span>
                      </span>
                      <span className="tag" style={{ background: "#111120", color: "#bbb", fontSize: 9 }}>{t.session}</span>
                    </div>
                    <span style={{ fontSize: 11, color: "#a3a3ba" }}>{t.size}ct</span>
                    <p style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, fontSize: 15, textAlign: "right" }} className={t.pnl >= 0 ? "pos" : "neg"}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}</p>
                    <button onClick={(e) => { e.stopPropagation(); setDeleteConfirm(t.id); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, padding: 4, color: "#ff4466", opacity: 0.6, transition: "opacity 0.2s" }} onMouseEnter={(e) => e.target.style.opacity = 1} onMouseLeave={(e) => e.target.style.opacity = 0.6}>×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* TRADES */}
          {view === "trades" && (
            <div>
              <div style={{ display: "flex", gap: 5, marginBottom: 18, flexWrap: "wrap" }}>
                {["All", ...SESSIONS].map(s => (
                  <button key={s} className={`nb ${filterSession === s ? "on" : ""}`} style={{ border: "1px solid #181828" }} onClick={() => setFilterSession(s)}>{s}</button>
                ))}
              </div>
              <div className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div style={{ display: "grid", gridTemplateColumns: "80px 55px 60px 110px 120px 55px 80px 80px 100px 40px", padding: "11px 20px", borderBottom: "1px solid #0f0f1e" }}>
                  {["Ticker", "Dir", "Session", "Strategy", "Emotion", "Cts", "Entry", "Exit", "P&L", ""].map(h => <p key={h} className="lbl" style={{ margin: 0 }}>{h}</p>)}
                </div>
                {filtered.map(t => (
                  <div key={t.id}>
                    <div className="trow" style={{ display: "grid", gridTemplateColumns: "80px 55px 60px 110px 120px 55px 80px 80px 100px 40px", padding: "13px 20px", alignItems: "center" }}>
                      <div onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)} style={{ cursor: "pointer" }}>
                        <p style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, color: "#fff" }}>
                          {t.ticker}
                          {t.source === "csv" && <span className="tv-badge">CSV</span>}
                        </p>
                        <p style={{ fontSize: 9, color: "#9595b0" }}>{formatDateDisplay(t.date)}</p>
                      </div>
                      <span className="tag" style={{ background: t.direction === "Long" ? "rgba(127,255,178,.1)" : "rgba(255,68,102,.1)", color: t.direction === "Long" ? "#7fffb2" : "#ff4466", width: "fit-content" }} onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)}>{t.direction}</span>
                      <span style={{ fontSize: 10, color: "#bbb", cursor: "pointer" }} onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)}>{t.session.replace("RTH ", "")}</span>
                      <span style={{ fontSize: 11, color: "#ccc", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); openEditStrategy(t); }} title="Click to edit strategy">
                        {t.strategy}
                        <span style={{ fontSize: 8, marginLeft: 4, opacity: 0.5 }}>✎</span>
                      </span>
                      <span className="tag" style={{ color: emotionColors[t.emotion] || "#888", background: `${emotionColors[t.emotion] || "#888"}12`, width: "fit-content", cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); openEditEmotion(t); }} title="Click to edit emotion">
                        {t.emotion}
                        <span style={{ fontSize: 8, marginLeft: 4, opacity: 0.5 }}>✎</span>
                      </span>
                      <span style={{ fontSize: 12, color: "#bbb", cursor: "pointer" }} onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)}>{t.size}</span>
                      <span style={{ fontSize: 12, color: "#eee", cursor: "pointer" }} onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)}>{t.entry}</span>
                      <span style={{ fontSize: 12, color: "#eee", cursor: "pointer" }} onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)}>{t.exit}</span>
                      <p style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, textAlign: "right", cursor: "pointer" }} className={t.pnl >= 0 ? "pos" : "neg"} onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}</p>
                      <button onClick={(e) => { e.stopPropagation(); setDeleteConfirm(t.id); }} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, padding: 4, color: "#ff4466", opacity: 0.6, transition: "opacity 0.2s" }} onMouseEnter={(e) => e.target.style.opacity = 1} onMouseLeave={(e) => e.target.style.opacity = 0.6}>×</button>
                    </div>
                    {expandedTrade === t.id && (
                      <div style={{ padding: "14px 20px", background: "#09090f", borderBottom: "1px solid #0f0f1e" }}>
                        <p style={{ fontSize: 12, color: "#ccc", marginBottom: 10, fontStyle: "italic" }}>{t.notes || "No notes recorded."}</p>
                        <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#aaa", marginBottom: 12 }}>
                          <span>Point value: <span style={{ color: "#ddd" }}>${POINT_VALUES[t.market]?.toLocaleString()}</span></span>
                          <span>Move: <span style={{ color: "#ddd" }}>{Math.abs(t.exit - t.entry).toFixed(2)} pts</span></span>
                          <span>Side: <span style={{ color: t.direction === "Long" ? "#7fffb2" : "#ff4466" }}>{t.direction}</span></span>
                          {t.source === "csv" && <span style={{ color: "#00ddff" }}>CSV Import</span>}
                        </div>

                        {!tradeAi[t.id] && <button className="ghost" onClick={(e) => { e.stopPropagation(); analyzeOne(t); }}>AI Analysis</button>}
                        {tradeAi[t.id]?.loading && <p style={{ fontSize: 11, color: "#7fffb2" }} className="pulse">Analyzing trade...</p>}
                        {tradeAi[t.id]?.text && (
                          <div style={{ marginTop: 12, padding: 16, background: "#0c0c18", borderRadius: 6, border: "1px solid #1e1e30" }}>
                            <p style={{ fontSize: 9, color: "#7fffb2", letterSpacing: ".12em", marginBottom: 10 }}>AI COACHING</p>
                            <p className="ai-text">{tradeAi[t.id].text}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ANALYTICS */}
          {view === "analytics" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div className="card">
                <p className="lbl" style={{ marginBottom: 16 }}>Strategy Performance</p>
                {stratPerf.map(s => {
                  const max = Math.max(...stratPerf.map(x => Math.abs(x.pnl)), 1);
                  return (
                    <div key={s.name} style={{ marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 12 }}>{s.name}</span>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <span style={{ fontSize: 10, color: "#aaa" }}>{s.wr}% WR \u00B7 {s.count}t</span>
                          <span className={s.pnl >= 0 ? "pos" : "neg"} style={{ fontSize: 13, fontFamily: "Syne,sans-serif", fontWeight: 700 }}>{s.pnl >= 0 ? "+" : ""}${s.pnl.toLocaleString()}</span>
                        </div>
                      </div>
                      <div style={{ background: "#111120", borderRadius: 3, height: 4 }}>
                        <div style={{ width: `${(Math.abs(s.pnl) / max) * 100}%`, height: 4, borderRadius: 3, background: s.pnl >= 0 ? "linear-gradient(90deg,#7fffb2,#00cc66)" : "linear-gradient(90deg,#ff4466,#cc2244)" }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="card">
                <p className="lbl" style={{ marginBottom: 16 }}>Emotion \u2192 P&L</p>
                {emotPerf.map(e => {
                  const max = Math.max(...emotPerf.map(x => Math.abs(x.pnl)), 1);
                  const col = emotionColors[e.name] || "#888";
                  return (
                    <div key={e.name} style={{ marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 12, color: col }}>{e.name}</span>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span style={{ fontSize: 10, color: "#aaa" }}>{e.count}t</span>
                          <span className={e.pnl >= 0 ? "pos" : "neg"} style={{ fontSize: 13, fontFamily: "Syne,sans-serif", fontWeight: 700 }}>{e.pnl >= 0 ? "+" : ""}${e.pnl.toLocaleString()}</span>
                        </div>
                      </div>
                      <div style={{ background: "#111120", borderRadius: 3, height: 4 }}>
                        <div style={{ width: `${(Math.abs(e.pnl) / max) * 100}%`, height: 4, borderRadius: 3, background: e.pnl >= 0 ? col : "#ff4466" }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="card">
                <p className="lbl" style={{ marginBottom: 16 }}>Session Breakdown</p>
                {sessPerf.map(s => (
                  <div key={s.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #0f0f1e" }}>
                    <span style={{ fontSize: 12 }}>{s.name}</span>
                    <span style={{ fontSize: 11, color: "#aaa" }}>{s.count} trades</span>
                    <span className={s.pnl >= 0 ? "pos" : "neg"} style={{ fontFamily: "Syne,sans-serif", fontWeight: 700 }}>{s.pnl >= 0 ? "+" : ""}${s.pnl.toLocaleString()}</span>
                  </div>
                ))}
              </div>

              <div className="card">
                <p className="lbl" style={{ marginBottom: 16 }}>Risk Metrics</p>
                {[
                  ["Total Trades", trades.length],
                  ["Win Rate", `${winRate}%`],
                  ["Profit Factor", profitFactor],
                  ["Avg Win", `$${avgWin.toFixed(0)}`],
                  ["Avg Loss", `-$${avgLoss.toFixed(0)}`],
                  ["Win/Loss Ratio", avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : "\u221e"],
                  ["Max Drawdown", `-$${maxDD.toFixed(0)}`],
                  ["Net P&L", `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toLocaleString()}`],
                ].map(([l, v]) => (
                  <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #0c0c1c" }}>
                    <span style={{ fontSize: 12, color: "#bbb" }}>{l}</span>
                    <span style={{ fontSize: 13, fontFamily: "Syne,sans-serif", fontWeight: 600, color: "#d8d8ec" }}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI COACH */}
          {/* CALENDAR */}
          {view === "calendar" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <div>
                  <p style={{ fontFamily: "Syne,sans-serif", fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 4 }}>Trading Calendar</p>
                  <p style={{ color: "#999", fontSize: 11, letterSpacing: ".05em" }}>Daily performance breakdown</p>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button className="ghost" onClick={() => setCalendarDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))}>←</button>
                  <span style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, fontSize: 16, color: "#fff", minWidth: 180, textAlign: "center" }}>
                    {calendarDate.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
                  </span>
                  <button className="ghost" onClick={() => setCalendarDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))}>→</button>
                  <button className="ghost" onClick={() => setCalendarDate(new Date())}>Today</button>
                </div>
              </div>

              <div className="card" style={{ padding: 20 }}>
                {(() => {
                  const year = calendarDate.getFullYear();
                  const month = calendarDate.getMonth();
                  const firstDay = new Date(year, month, 1).getDay();
                  const daysInMonth = new Date(year, month + 1, 0).getDate();

                  // Group trades by date
                  const tradesByDate = {};
                  trades.forEach(t => {
                    // Normalize date to YYYY-MM-DD format
                    let dateKey = t.date;
                    if (dateKey && dateKey.includes('T')) {
                      dateKey = dateKey.split('T')[0];
                    }
                    if (dateKey && dateKey.includes(' ')) {
                      dateKey = dateKey.split(' ')[0];
                    }
                    if (!dateKey) return;

                    if (!tradesByDate[dateKey]) {
                      tradesByDate[dateKey] = [];
                    }
                    tradesByDate[dateKey].push(t);
                  });

                  // Calculate stats for each date
                  const dateStats = {};
                  Object.keys(tradesByDate).forEach(dateKey => {
                    const dayTrades = tradesByDate[dateKey];
                    const wins = dayTrades.filter(t => t.pnl > 0).length;
                    const totalPnl = dayTrades.reduce((sum, t) => sum + t.pnl, 0);
                    const winRate = dayTrades.length > 0 ? Math.round((wins / dayTrades.length) * 100) : 0;
                    dateStats[dateKey] = {
                      count: dayTrades.length,
                      pnl: totalPnl,
                      winRate: winRate
                    };
                  });

                  const days = [];
                  // Add empty cells for days before month starts
                  for (let i = 0; i < firstDay; i++) {
                    days.push(<div key={`empty-${i}`} style={{ padding: 8, minHeight: 90 }} />);
                  }

                  // Add calendar days
                  const todayDate = getTodayLocalDate();
                  for (let day = 1; day <= daysInMonth; day++) {
                    const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const stats = dateStats[dateKey];
                    const isToday = todayDate === dateKey;

                    days.push(
                      <div key={day} style={{
                        padding: 8,
                        minHeight: 90,
                        background: stats ? (stats.pnl >= 0 ? "rgba(127,255,178,0.08)" : "rgba(255,68,102,0.08)") : "#09090f",
                        border: isToday ? "2px solid #7fffb2" : "1px solid #0f0f1e",
                        borderRadius: 6,
                        position: "relative"
                      }}>
                        <div style={{ fontSize: 11, color: isToday ? "#7fffb2" : "#555", marginBottom: 6, fontWeight: isToday ? 700 : 400 }}>{day}</div>
                        {stats && (
                          <div style={{ fontSize: 10 }}>
                            <div style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, fontSize: 13, marginBottom: 4 }} className={stats.pnl >= 0 ? "pos" : "neg"}>
                              {stats.pnl >= 0 ? "+" : ""}${stats.pnl.toLocaleString()}
                            </div>
                            <div style={{ color: "#666", marginBottom: 2 }}>{stats.count} trade{stats.count !== 1 ? 's' : ''}</div>
                            <div style={{ color: stats.winRate >= 50 ? "#7fffb2" : "#ff4466", fontSize: 9 }}>{stats.winRate}% win</div>
                          </div>
                        )}
                      </div>
                    );
                  }

                  return (
                    <div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, marginBottom: 8 }}>
                        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => (
                          <div key={d} style={{ textAlign: "center", fontSize: 10, color: "#666", letterSpacing: ".1em", padding: "8px 0" }}>{d}</div>
                        ))}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8 }}>
                        {days}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Legend */}
              <div style={{ display: "flex", gap: 20, marginTop: 16, fontSize: 11, color: "#666", justifyContent: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 12, height: 12, background: "rgba(127,255,178,0.08)", border: "1px solid rgba(127,255,178,0.3)", borderRadius: 2 }} />
                  <span>Profitable Day</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 12, height: 12, background: "rgba(255,68,102,0.08)", border: "1px solid rgba(255,68,102,0.3)", borderRadius: 2 }} />
                  <span>Loss Day</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 12, height: 12, border: "2px solid #7fffb2", borderRadius: 2 }} />
                  <span>Today</span>
                </div>
              </div>
            </div>
          )}

          {view === "ai-coach" && (
            <div>
              <p style={{ fontFamily: "Syne,sans-serif", fontSize: 20, fontWeight: 700, color: "#fff", marginBottom: 6 }}>AI Trading Coach</p>
              <p style={{ color: "#aaa", fontSize: 12, marginBottom: 22 }}>Powered by Claude \u2014 deep analysis of your futures edge, psychology & risk management.</p>

              <div className="card" style={{ marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: aiReport || aiLoading || aiError ? 20 : 0 }}>
                  <div>
                    <p style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, fontSize: 15, color: "#fff", marginBottom: 5 }}>Full Portfolio Review</p>
                    <p style={{ fontSize: 12, color: "#aaa" }}>Analyzes all {trades.length} trades \u2014 strategy edge, psychology, session timing & risk</p>
                  </div>
                  <button className="gbtn" onClick={runAnalysis} disabled={aiLoading}>{aiLoading ? "Analyzing..." : "Run Analysis"}</button>
                </div>
                {aiLoading && <div style={{ padding: 20, background: "#09090f", borderRadius: 6, textAlign: "center" }}><p style={{ color: "#7fffb2", fontSize: 12 }} className="pulse">Claude is reviewing your trading journal...</p></div>}
                {aiError && <p style={{ color: "#ff4466", fontSize: 12 }}>{aiError}</p>}
                {aiReport && (
                  <div style={{ padding: 20, background: "#09090f", borderRadius: 6, border: "1px solid #7fffb218" }}>
                    <div style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 14 }}>
                      <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#7fffb2", boxShadow: "0 0 6px #7fffb2" }} />
                      <p style={{ fontSize: 9, color: "#7fffb2", letterSpacing: ".12em" }}>AI ANALYSIS COMPLETE</p>
                    </div>
                    <p className="ai-text">{aiReport}</p>
                  </div>
                )}
              </div>

              <div className="card">
                <p className="lbl" style={{ marginBottom: 4 }}>Trade-by-Trade Coaching</p>
                <p style={{ fontSize: 11, color: "#9595b0", marginBottom: 16 }}>Get specific AI feedback on execution, psychology & improvement for each trade.</p>
                {trades.map(t => (
                  <div key={t.id} style={{ padding: "12px 0", borderBottom: "1px solid #0f0f1e" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <span style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, color: "#fff", fontSize: 14 }}>
                          {t.ticker}
                          {t.source === "csv" && <span className="tv-badge">CSV</span>}
                        </span>
                        <span style={{ fontSize: 10, color: "#9595b0" }}>{formatDateDisplay(t.date)}</span>
                        <span className="tag" style={{ background: "#111120", color: "#ccc" }}>{t.strategy}</span>
                        <span className="tag" style={{ color: emotionColors[t.emotion] || "#888", background: `${emotionColors[t.emotion] || "#888"}12` }}>{t.emotion}</span>
                        <span className="tag" style={{ background: "#111120", color: "#aaa", fontSize: 9 }}>{t.session}</span>
                      </div>
                      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                        <span className={t.pnl >= 0 ? "pos" : "neg"} style={{ fontFamily: "Syne,sans-serif", fontWeight: 700 }}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}</span>
                        {!tradeAi[t.id] && <button className="ghost" onClick={() => analyzeOne(t)}>Analyze</button>}
                        {tradeAi[t.id]?.loading && <span style={{ fontSize: 10, color: "#7fffb2" }} className="pulse">Thinking...</span>}
                      </div>
                    </div>
                    {tradeAi[t.id]?.text && (
                      <div style={{ marginTop: 10, padding: 14, background: "#09090f", borderRadius: 6, border: "1px solid #181828" }}>
                        <p className="ai-text">{tradeAi[t.id].text}</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CSV IMPORT MODAL */}
      {showImport && (
        <div className="ov" onClick={e => { if (e.target === e.currentTarget) setShowImport(false); }}>
          <div className="modal" style={{ filter: isDark ? "none" : "invert(1) hue-rotate(180deg)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
              <p style={{ fontFamily: "Syne,sans-serif", fontWeight: 800, fontSize: 17, color: "#fff" }}>Import Tradovate CSV</p>
              <button onClick={() => setShowImport(false)} style={{ background: "none", border: "none", color: "#aaa", cursor: "pointer", fontSize: 24 }}>{"\u00D7"}</button>
            </div>

            <div
              onDragOver={e => { e.preventDefault(); setImportDragOver(true); }}
              onDragLeave={() => setImportDragOver(false)}
              onDrop={e => { e.preventDefault(); setImportDragOver(false); handleCsvFile(e.dataTransfer.files[0]); }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${importDragOver ? "#7fffb2" : "#1e1e38"}`,
                borderRadius: 8,
                padding: "40px 20px",
                textAlign: "center",
                cursor: "pointer",
                background: importDragOver ? "rgba(127,255,178,.04)" : "transparent",
                transition: "all .2s",
                marginBottom: 16,
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                style={{ display: "none" }}
                onChange={e => handleCsvFile(e.target.files[0])}
              />
              <p style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>{"\uD83D\uDCC4"}</p>
              <p style={{ fontSize: 13, color: "#ccc", marginBottom: 6 }}>Drag & drop your Tradovate CSV here</p>
              <p style={{ fontSize: 11, color: "#aaa" }}>or click to browse files</p>
            </div>

            <div style={{ background: "#09090f", borderRadius: 6, padding: "14px 16px", marginBottom: 16 }}>
              <p style={{ fontSize: 10, color: "#7fffb2", letterSpacing: ".1em", marginBottom: 8 }}>HOW TO EXPORT FROM TRADOVATE</p>
              <ol style={{ fontSize: 11, color: "#ccc", lineHeight: 1.8, paddingLeft: 16, margin: 0 }}>
                <li>Open Tradovate &rarr; click your account name dropdown</li>
                <li>Click the gear icon &rarr; <b style={{ color: "#eee" }}>Account Reports</b></li>
                <li>Go to the <b style={{ color: "#7fffb2" }}>Orders</b> tab (not Performance)</li>
                <li>Select your date range &rarr; click <b style={{ color: "#eee" }}>Download Report</b></li>
                <li>Drop the downloaded CSV file here</li>
              </ol>
            </div>

            {/* Import preview */}
            {importPreview && (
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 11, color: "#7fffb2", marginBottom: 10 }}>Found {importPreview.length} trade{importPreview.length !== 1 ? "s" : ""} to import:</p>
                <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #181828", borderRadius: 6 }}>
                  {importPreview.map((t, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #0f0f1e" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, color: "#fff", fontSize: 13 }}>{t.ticker}</span>
                        <span className="tag" style={{ background: t.direction === "Long" ? "rgba(127,255,178,.1)" : "rgba(255,68,102,.1)", color: t.direction === "Long" ? "#7fffb2" : "#ff4466" }}>{t.direction}</span>
                        <span style={{ fontSize: 10, color: "#aaa" }}>{t.date}</span>
                        <span style={{ fontSize: 10, color: "#bbb" }}>{t.size}ct</span>
                      </div>
                      <span className={t.pnl >= 0 ? "pos" : "neg"} style={{ fontFamily: "Syne,sans-serif", fontWeight: 700, fontSize: 13 }}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                  <button className="gbtn" onClick={confirmImport} style={{ flex: 1 }}>Import {importPreview.length} Trade{importPreview.length !== 1 ? "s" : ""}</button>
                  <button className="ghost" onClick={() => { setImportPreview(null); setImportResult(null); }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Import result message */}
            {importResult && (
              <div style={{ padding: "12px 16px", borderRadius: 6, background: importResult.error ? "rgba(255,68,102,.08)" : "rgba(127,255,178,.08)", border: `1px solid ${importResult.error ? "#ff446633" : "#7fffb233"}` }}>
                <p style={{ fontSize: 12, color: importResult.error ? "#ff4466" : "#7fffb2" }}>
                  {importResult.error || `Successfully imported ${importResult.count} trade${importResult.count !== 1 ? "s" : ""}!`}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* LOG TRADE MODAL */}
      {showForm && (
        <div className="ov" onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <div className="modal" style={{ filter: isDark ? "none" : "invert(1) hue-rotate(180deg)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
              <p style={{ fontFamily: "Syne,sans-serif", fontWeight: 800, fontSize: 17, color: "#fff" }}>Log Futures Trade</p>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", color: "#aaa", cursor: "pointer", fontSize: 24 }}>\u00D7</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div><span className="lbl">Date</span><input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} /></div>
              <div>
                <span className="lbl">Instrument</span>
                <select value={form.market} onChange={e => setForm(p => ({ ...p, market: e.target.value, ticker: e.target.value }))}>
                  {INSTRUMENTS.map(i => <option key={i}>{i}</option>)}
                </select>
                {form.market && POINT_VALUES[form.market] && <p style={{ fontSize: 9, color: "#aaa", marginTop: 4 }}>Point value: ${POINT_VALUES[form.market]?.toLocaleString()}/pt</p>}
              </div>
              <div>
                <span className="lbl">Direction</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {["Long", "Short"].map(d => (
                    <button key={d} onClick={() => setForm(p => ({ ...p, direction: d }))} style={{ flex: 1, padding: "8px", border: `1px solid ${form.direction === d ? (d === "Long" ? "#7fffb2" : "#ff4466") : "#181828"}`, borderRadius: 4, background: form.direction === d ? (d === "Long" ? "rgba(127,255,178,.1)" : "rgba(255,68,102,.1)") : "none", color: form.direction === d ? (d === "Long" ? "#7fffb2" : "#ff4466") : "#ccc", cursor: "pointer", fontFamily: "'DM Mono',monospace", fontSize: 12, letterSpacing: ".05em" }}>{d}</button>
                  ))}
                </div>
              </div>
              <div><span className="lbl">Contracts</span><input type="number" min="1" placeholder="1" value={form.size} onChange={e => setForm(p => ({ ...p, size: e.target.value }))} /></div>
              <div><span className="lbl">Entry Price</span><input type="number" step="0.25" placeholder="0.00" value={form.entry} onChange={e => setForm(p => ({ ...p, entry: e.target.value }))} /></div>
              <div><span className="lbl">Exit Price</span><input type="number" step="0.25" placeholder="0.00" value={form.exit} onChange={e => setForm(p => ({ ...p, exit: e.target.value }))} /></div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span className="lbl" style={{ margin: 0 }}>Strategy</span>
                  <button type="button" className="ghost" onClick={() => setShowStrategyManager(true)} style={{ padding: "4px 8px", fontSize: 9 }}>Manage</button>
                </div>
                <select value={form.strategy} onChange={e => setForm(p => ({ ...p, strategy: e.target.value }))}>
                  {allStrategies.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <span className="lbl">Session</span>
                <select value={form.session} onChange={e => setForm(p => ({ ...p, session: e.target.value }))}>
                  {SESSIONS.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <span className="lbl">Emotional State</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {EMOTIONS.map(e => {
                    const col = emotionColors[e] || "#888";
                    return (
                      <button key={e} onClick={() => setForm(p => ({ ...p, emotion: e }))} style={{ padding: "4px 9px", border: `1px solid ${form.emotion === e ? col : "#1a1a2a"}`, borderRadius: 4, background: form.emotion === e ? `${col}18` : "none", color: form.emotion === e ? col : "#bbb", cursor: "pointer", fontSize: 10, fontFamily: "'DM Mono',monospace", transition: "all .15s", letterSpacing: ".05em" }}>{e}</button>
                    );
                  })}
                </div>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <span className="lbl">Trade Notes</span>
                <textarea rows={3} placeholder="Setup rationale, what happened, what you learned..." value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
              </div>
            </div>

            {previewPnl !== null && (
              <div style={{ margin: "16px 0", padding: "12px 16px", background: "#09090f", borderRadius: 6, border: `1px solid ${previewPnl >= 0 ? "#7fffb222" : "#ff446622"}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <p style={{ fontSize: 9, color: "#aaa", letterSpacing: ".1em", marginBottom: 3 }}>ESTIMATED P&L</p>
                  <p style={{ fontSize: 10, color: "#9595b0" }}>{Math.abs((+form.exit) - (+form.entry)).toFixed(2)} pts \u00D7 {form.size}ct \u00D7 ${POINT_VALUES[form.market]}</p>
                </div>
                <p style={{ fontFamily: "Syne,sans-serif", fontSize: 22, fontWeight: 700 }} className={previewPnl >= 0 ? "pos" : "neg"}>{previewPnl >= 0 ? "+" : ""}${previewPnl.toLocaleString()}</p>
              </div>
            )}
            <button className="gbtn" onClick={handleSubmit} style={{ width: "100%", marginTop: 4 }}>Save Trade</button>
          </div>
        </div>
      )}

      {/* STRATEGY MANAGER */}
      {showStrategyManager && (
        <div onClick={() => setShowStrategyManager(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#0c0c18", border: "1px solid #1e1e30", borderRadius: 8, padding: "28px 32px", maxWidth: 500, width: "90%", maxHeight: "80vh", overflow: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <p style={{ fontFamily: "Syne,sans-serif", fontSize: 18, fontWeight: 700, color: "#fff", margin: 0 }}>Manage Strategies</p>
              <button onClick={() => setShowStrategyManager(false)} style={{ background: "none", border: "none", color: "#aaa", cursor: "pointer", fontSize: 24 }}>×</button>
            </div>

            <div style={{ marginBottom: 24 }}>
              <p className="lbl" style={{ marginBottom: 8 }}>Add Custom Strategy</p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  placeholder="e.g., Supply & Demand"
                  value={newStrategy}
                  onChange={e => setNewStrategy(e.target.value)}
                  onKeyPress={e => e.key === 'Enter' && addCustomStrategy()}
                  style={{ flex: 1 }}
                />
                <button className="gbtn" onClick={addCustomStrategy}>Add</button>
              </div>
            </div>

            <div>
              <p className="lbl" style={{ marginBottom: 12 }}>Default Strategies</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
                {STRATEGIES.map(s => (
                  <div key={s} style={{ padding: "6px 12px", background: "#111120", border: "1px solid #222235", borderRadius: 4, fontSize: 11, color: "#aaa" }}>
                    {s}
                  </div>
                ))}
              </div>
            </div>

            {customStrategies.length > 0 && (
              <div>
                <p className="lbl" style={{ marginBottom: 12 }}>Custom Strategies</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {customStrategies.map(s => (
                    <div key={s} style={{ padding: "6px 12px", background: "#7fffb218", border: "1px solid #7fffb244", borderRadius: 4, fontSize: 11, color: "#7fffb2", display: "flex", alignItems: "center", gap: 8 }}>
                      {s}
                      <button onClick={() => deleteCustomStrategy(s)} style={{ background: "none", border: "none", color: "#ff4466", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* EDIT STRATEGY MODAL */}
      {editStrategyTrade && (
        <div onClick={() => setEditStrategyTrade(null)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#0c0c18", border: "1px solid #1e1e30", borderRadius: 8, padding: "28px 32px", maxWidth: 450, width: "90%" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <p style={{ fontFamily: "Syne,sans-serif", fontSize: 18, fontWeight: 700, color: "#fff", margin: 0 }}>Edit Strategy</p>
              <button onClick={() => setEditStrategyTrade(null)} style={{ background: "none", border: "none", color: "#aaa", cursor: "pointer", fontSize: 24 }}>×</button>
            </div>
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
                Trade: <span style={{ color: "#fff", fontWeight: 600 }}>{editStrategyTrade.ticker}</span> | {formatDateDisplay(editStrategyTrade.date)}
                {editStrategyTrade.source === "csv" && <span className="tv-badge" style={{ marginLeft: 8 }}>CSV</span>}
              </p>
              <p className="lbl" style={{ marginBottom: 8 }}>Strategy</p>
              <select value={editStrategyValue} onChange={e => setEditStrategyValue(e.target.value)} style={{ width: "100%", marginBottom: 16 }}>
                {allStrategies.map(s => <option key={s}>{s}</option>)}
              </select>
              <p style={{ fontSize: 11, color: "#666", fontStyle: "italic" }}>You can also create custom strategies from the "Manage" button in the trade form.</p>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="ghost" onClick={() => setEditStrategyTrade(null)} style={{ flex: 1 }}>Cancel</button>
              <button className="gbtn" onClick={saveEditStrategy} style={{ flex: 1 }}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT EMOTION MODAL */}
      {editEmotionTrade && (
        <div onClick={() => setEditEmotionTrade(null)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#0c0c18", border: "1px solid #1e1e30", borderRadius: 8, padding: "28px 32px", maxWidth: 500, width: "90%" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <p style={{ fontFamily: "Syne,sans-serif", fontSize: 18, fontWeight: 700, color: "#fff", margin: 0 }}>Edit Emotional State</p>
              <button onClick={() => setEditEmotionTrade(null)} style={{ background: "none", border: "none", color: "#aaa", cursor: "pointer", fontSize: 24 }}>×</button>
            </div>
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 12, color: "#999", marginBottom: 16 }}>
                Trade: <span style={{ color: "#fff", fontWeight: 600 }}>{editEmotionTrade.ticker}</span> | {formatDateDisplay(editEmotionTrade.date)}
                {editEmotionTrade.source === "csv" && <span className="tv-badge" style={{ marginLeft: 8 }}>CSV</span>}
              </p>
              <p className="lbl" style={{ marginBottom: 12 }}>Emotional State</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {EMOTIONS.map(e => {
                  const col = emotionColors[e] || "#888";
                  const isSelected = editEmotionValue === e;
                  return (
                    <button
                      key={e}
                      onClick={() => setEditEmotionValue(e)}
                      style={{
                        padding: "8px 14px",
                        border: `1px solid ${isSelected ? col : "#1a1a2a"}`,
                        borderRadius: 4,
                        background: isSelected ? `${col}18` : "none",
                        color: isSelected ? col : "#666",
                        cursor: "pointer",
                        fontSize: 11,
                        fontFamily: "'DM Mono',monospace",
                        transition: "all .15s",
                        letterSpacing: ".05em"
                      }}
                    >
                      {e}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="ghost" onClick={() => setEditEmotionTrade(null)} style={{ flex: 1 }}>Cancel</button>
              <button className="gbtn" onClick={saveEditEmotion} style={{ flex: 1 }}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION */}
      {deleteConfirm && (
        <div onClick={() => setDeleteConfirm(null)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#0c0c18", border: "1px solid #1e1e30", borderRadius: 8, padding: "28px 32px", maxWidth: 420, width: "90%" }}>
            <p style={{ fontFamily: "Syne,sans-serif", fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 12 }}>Delete Trade?</p>
            <p style={{ fontSize: 12, color: "#ddd", marginBottom: 24, lineHeight: 1.6 }}>This action cannot be undone. The trade will be permanently removed from your journal.</p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="ghost" onClick={() => setDeleteConfirm(null)} style={{ flex: 1 }}>Cancel</button>
              <button onClick={() => deleteTrade(deleteConfirm)} style={{ flex: 1, background: "#ff4466", border: "none", color: "#fff", padding: "10px 20px", borderRadius: 6, cursor: "pointer", fontFamily: "'DM Mono',monospace", fontSize: 11, letterSpacing: ".08em", fontWeight: 500 }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
