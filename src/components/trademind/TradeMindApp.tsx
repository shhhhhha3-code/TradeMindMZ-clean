import React, { useState } from "react";
import "./TradeMindUI.css";
import "./TradeMindUI.refresh.css";
import { useTrading } from '@/contexts/TradingContext';

type Page = "Dashboard"|"Trading"|"Open Positions"|"Signals"|"AI Analysis"|"Auto Trader"|"History"|"Wallet"|"Settings";
const nav: {label: Page; icon: string}[] = [
  {label:"Dashboard",icon:"⌂"},{label:"Trading",icon:"⌁"},{label:"Open Positions",icon:"◫"},
  {label:"Signals",icon:"◈"},{label:"AI Analysis",icon:"✦"},{label:"Auto Trader",icon:"◉"},
  {label:"History",icon:"↺"},{label:"Wallet",icon:"◌"},{label:"Settings",icon:"⚙"}
];
const positions = [
  ["BTCUSDT","LONG","0.215 BTC","65,820","66,947","+242.11","68,500","64,900"],
  ["ETHUSDT","LONG","10.5 ETH","3,420","3,468","+126.40","3,580","3,350"],
  ["SOLUSDT","SHORT","50 SOL","195.20","191.80","-32.50","184.00","201.00"]
];
const signals = [["BTCUSDT","LONG","95","66,050","68,500","1m"],["ETHUSDT","LONG","87","3,420","3,580","12m"],["SOLUSDT","SHORT","82","195.20","184.00","31m"],["XRPUSDT","LONG","76","2.41","2.68","1h"]];

export default function TradeMindApp(){
  const [page,setPage]=useState<Page>("Dashboard"),[mobile,setMobile]=useState(false);
  const trading = useTrading();
  return <div className="tm-shell">
    <aside className={"tm-sidebar "+(mobile?"open":"")}>
      <div className="tm-brand"><img src="/assets/trademindmz-logo.svg"/><div><b>TRADE<span>MIND</span><i>MZ</i></b><small>AI-POWERED TRADING</small></div></div>
      <div className="tm-live">
        <span className={"dot " + (trading.isPionexLive ? "live" : "")}/>
        <span>Live Trading</span>
        <span className="demo-switch">{trading.isPionexLive ? "LIVE" : "OFF"}</span>
      </div>
      <nav>{nav.map(n=><button className={page===n.label?"active":""} onClick={()=>{setPage(n.label);setMobile(false)}} key={n.label}><em>{n.icon}</em>{n.label}</button>)}</nav>
      <div className="tm-user"><strong>M</strong><div>TradeMindMZ<small>Premium Plan</small></div></div>
    </aside>
    {mobile&&<button className="tm-overlay" onClick={()=>setMobile(false)}/>}
    <main className="tm-main">
      <header><button className="tm-menu" onClick={()=>setMobile(true)}>☰</button><div><small>TRADEMINDMZ / TERMINAL</small><h1>{page}</h1></div><div className="head-actions"><button>⌕</button><button>♢</button><b>M</b></div></header>
      {page==="Dashboard"&&<Dashboard/>}{page==="Trading"&&<Trading/>}{page==="Open Positions"&&<Positions/>}
      {page==="Signals"&&<Signals/>}{page==="AI Analysis"&&<AI/>}{page==="Auto Trader"&&<Auto/>}
      {page==="History"&&<History/>}{page==="Wallet"&&<Wallet/>}{page==="Settings"&&<Settings/>}
    </main>
  </div>
}
function Card(p:{title:string;children:React.ReactNode;className?:string}){return <section className={"card "+(p.className||"")}><div className="card-head"><h3>{p.title}</h3><span>VIEW ALL</span></div>{p.children}</section>}
function Stats(){
  const trading = useTrading();

  const balance = Number(
    trading?.demoAccount?.balance ??
    0
  );

  const openPositions = Array.isArray(trading?.liveOrders)
    ? trading.liveOrders.filter((o: any) =>
        ["NEW", "PARTIALLY_FILLED", "OPEN"].includes(
          String(o?.status ?? "").toUpperCase()
        )
      ).length
    : 0;

  const liveSignals = Array.isArray(trading?.liveSignals)
    ? trading.liveSignals.length
    : 0;

  return (
    <div className="stats">
      <Stat
        a="Account Balance"
        b={formatNumber(balance, 2)}
        c="USDT"
        d={trading?.isPionexLive ? "PIONEX LIVE" : "DEMO / OFF"}
      />

      <Stat
        a="Open Positions"
        b={String(openPositions)}
        c="ACTIVE"
        d={`${openPositions} currently open`}
      />

      <Stat
        a="Live Signals"
        b={String(liveSignals)}
        c="SIGNALS"
        d="CURRENT SIGNAL POOL"
      />

      <Stat
        a="Trading State"
        b={trading?.isPionexLive ? "LIVE" : "OFF"}
        c=""
        d={String(trading?.pionexAccountStatus ?? "unknown").toUpperCase()}
      />
    </div>
  );
}
function Stat(p:any){return <div className="stat"><small>{p.a}</small><div><b>{p.b}</b><i>{p.c}</i></div><span>{p.d}</span></div>}

function normalizeSignalSide(value: unknown): "LONG" | "SHORT" {
  return String(value ?? "").toUpperCase() === "SELL" ||
    String(value ?? "").toUpperCase() === "SHORT"
    ? "SHORT"
    : "LONG";
}

function formatNumber(value: unknown, digits = 2): string {
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : "—";
}

function getSignalScore(signal: any): string {
  const value =
    signal?.ai_score ??
    signal?.score ??
    signal?.confidence ??
    signal?.confidence_score;

  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n <= 1 ? `${Math.round(n * 100)}` : `${Math.round(n)}`;
}

function getSignalEntry(signal: any): string {
  return formatNumber(
    signal?.entry_price ??
      signal?.entryPrice ??
      signal?.price ??
      signal?.current_price,
    2
  );
}

function getSignalTarget(signal: any): string {
  return formatNumber(
    signal?.take_profit ??
      signal?.takeProfit ??
      signal?.take_profit_1 ??
      signal?.target_price,
    2
  );
}

function getOrderPnL(order: any): number {
  const value = Number(
    order?.realized_pnl ??
      order?.unrealized_pnl ??
      order?.pnl ??
      0
  );
  return Number.isFinite(value) ? value : 0;
}

function getOrderQuantity(order: any): string {
  return formatNumber(
    order?.quantity ??
      order?.filled_qty ??
      0,
    4
  );
}

function getOrderEntry(order: any): string {
  return formatNumber(
    order?.entry_price ??
      order?.fill_price ??
      0,
    2
  );
}

function DashboardLiveRows({ trading }: { trading: any }) {
  const orders = Array.isArray(trading?.liveOrders)
    ? trading.liveOrders.slice(0, 5)
    : [];

  if (!orders.length) {
    return (
      <div className="tm-empty">
        No open live positions
      </div>
    );
  }

  return (
    <div className="rows">
      {orders.map((order: any) => {
        const pnl = getOrderPnL(order);
        return (
          <div className="row" key={order.id ?? order.pionex_order_id}>
            <b>{order.pair ?? order.symbol ?? "—"}</b>
            <label className={order.side === "BUY" ? "green" : "red"}>
              {order.side === "BUY" ? "LONG" : "SHORT"}
            </label>
            <small>{getOrderQuantity(order)}</small>
            <strong className={pnl >= 0 ? "green" : "red"}>
              {pnl >= 0 ? "+" : ""}
              {formatNumber(pnl)}
            </strong>
          </div>
        );
      })}
    </div>
  );
}

function DashboardLiveSignals({ trading }: { trading: any }) {
  const source = Array.isArray(trading?.liveSignals)
    ? trading.liveSignals
    : Array.isArray(trading?.scoredSignals)
      ? trading.scoredSignals
      : [];

  const items = source.slice(0, 5);

  if (!items.length) {
    return (
      <div className="tm-empty">
        No live signals
      </div>
    );
  }

  return (
    <div className="rows">
      {items.map((signal: any, index: number) => {
        const side = normalizeSignalSide(signal?.signal_type ?? signal?.side);
        return (
          <div className="row" key={signal?.id ?? `${signal?.pair ?? "signal"}-${index}`}>
            <b>{signal?.pair ?? signal?.symbol ?? "—"}</b>
            <label className={side === "LONG" ? "green" : "red"}>
              {side}
            </label>
            <small>
              {signal?.generated_at
                ? new Date(signal.generated_at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                : "—"}
            </small>
            <strong>{getSignalScore(signal)}%</strong>
          </div>
        );
      })}
    </div>
  );
}

function ConnectedPositions({ trading }: { trading: any }) {
  const orders = Array.isArray(trading?.liveOrders)
    ? trading.liveOrders
    : [];

  if (!orders.length) {
    return (
      <div className="tm-empty">
        No open live positions.
      </div>
    );
  }

  return (
    <div className="table">
      <div className="tr th">
        PAIR　 SIDE　 SIZE　 ENTRY　 PnL　 TP / SL
      </div>

      {orders.map((order: any) => {
        const pnl = getOrderPnL(order);
        const side = order?.side === "BUY" ? "LONG" : "SHORT";

        return (
          <div
            className="tr"
            key={order?.id ?? order?.pionex_order_id}
          >
            <b>{order?.pair ?? order?.symbol ?? "—"}</b>

            <label className={side === "LONG" ? "green" : "red"}>
              {side}
            </label>

            <span>{getOrderQuantity(order)}</span>

            <span>{getOrderEntry(order)}</span>

            <span className={pnl >= 0 ? "green" : "red"}>
              {pnl >= 0 ? "+" : ""}
              {formatNumber(pnl)}
            </span>

            <small>
              TP {formatNumber(order?.take_profit, 2)}
              {" / "}
              SL {formatNumber(order?.stop_loss, 2)}
            </small>
          </div>
        );
      })}
    </div>
  );
}

function ConnectedSignals({ trading }: { trading: any }) {
  const source = Array.isArray(trading?.liveSignals)
    ? trading.liveSignals
    : Array.isArray(trading?.scoredSignals)
      ? trading.scoredSignals
      : [];

  if (!source.length) {
    return (
      <div className="tm-empty">
        No signals available.
      </div>
    );
  }

  return (
    <div className="signal-grid">
      {source.slice(0, 12).map((signal: any, index: number) => {
        const side = normalizeSignalSide(signal?.signal_type ?? signal?.side);
        const score = getSignalScore(signal);

        return (
          <div
            className="signal"
            key={signal?.id ?? `${signal?.pair ?? "signal"}-${index}`}
          >
            <b>{signal?.pair ?? signal?.symbol ?? "—"}</b>

            <label className={side === "LONG" ? "green" : "red"}>
              {side}
            </label>

            <strong>{score}</strong>

            <p>
              Entry {getSignalEntry(signal)}
              {" → "}
              Target {getSignalTarget(signal)}
            </p>

            <div className="bar">
              <i
                style={{
                  width: `${Math.max(
                    0,
                    Math.min(100, Number(score) || 0)
                  )}%`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Dashboard(){
  const trading = useTrading();

  return (
    <div className="page">
      <div className="welcome">
        <div>
          <small>MARKET CONTROL CENTER</small>
          <h2>Welcome back, Trader <i>✦</i></h2>
          <p>Everything important at a glance.</p>
        </div>
        <div className="range">24H　7D　30D　90D</div>
      </div>

      <Stats/>

      <div className="grid2">
        <Card title="Portfolio Performance">
          <div className="big">Live account data <small>USDT</small></div>
          <Chart/>
        </Card>

        <Card title="Asset Allocation">
          <div className="alloc">
            <div className="donut">
              <b>{formatNumber(trading?.demoAccount?.balance ?? 0, 2)}</b>
              <small>USDT</small>
            </div>
            <div>
              ● Account balance<br/>
              ● Live positions<br/>
              ● Signal pool<br/>
              ● Risk controls
            </div>
          </div>
        </Card>
      </div>

      <div className="grid3">
        <Card title="Recent Signals">
          <DashboardLiveSignals trading={trading}/>
        </Card>

        <Card title="Open Positions">
          <DashboardLiveRows trading={trading}/>
        </Card>

        <Card title="AI Insight">
          <div className="ai">
            <strong>✦</strong>
            <div>
              <small>AI STATUS</small>
              <b>{String(trading?.aiAnalysisStatus ?? "idle").toUpperCase()}</b>
              <p>
                {trading?.liveSignals?.length
                  ? `${trading.liveSignals.length} live signals currently available.`
                  : "No live signals currently available."}
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
function Chart(){return <svg className="chart" viewBox="0 0 500 130" preserveAspectRatio="none"><defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#6d63ff" stopOpacity=".4"/><stop offset="1" stopColor="#6d63ff" stopOpacity="0"/></linearGradient></defs><polygon points="0,110 45,88 80,98 120,60 155,72 200,45 245,58 290,30 330,48 370,20 410,34 450,12 500,24 500,130 0,130" fill="url(#a)"/><polyline points="0,110 45,88 80,98 120,60 155,72 200,45 245,58 290,30 330,48 370,20 410,34 450,12 500,24" fill="none" stroke="#8b84ff" strokeWidth="3"/></svg>}
function ListSignals(){return <div className="rows">{signals.map(s=><div className="row" key={s[0]}><b>{s[0]}</b><label className={s[1]==="LONG"?"green":"red"}>{s[1]}</label><small>{s[5]}</small><strong>{s[2]}%</strong></div>)}</div>}
function ListPositions(){return <div className="rows">{positions.map(p=><div className="row" key={p[0]}><b>{p[0]}</b><strong className={p[5][0]==="+"?"green":"red"}>{p[5]}</strong><small>{p[1]}</small></div>)}</div>}
function Trading(){return <div className="page"><div className="market"><b>₿　BTCUSDT</b><strong>66,247.25 <i>+2.34%</i></strong></div><div className="terminal"><Card title="Price Chart"><Chart/><div className="time">1m　5m　15m　<b>1h</b>　4h　1D</div></Card><Card title="Order Entry"><div className="buttons"><b>Long</b><span>Short</span></div>{["Available　1,234.56 USDT","Quantity　0.000 BTC","Leverage　10×","TP　68,500.00","SL　64,900.00"].map(x=><div className="field" key={x}>{x}</div>)}<button className="primary">Place Long Order　→</button></Card></div></div>}
function Positions(){
  const trading = useTrading();

  return (
    <div className="page">
      <Card title="Open Positions">
        <ConnectedPositions trading={trading}/>
      </Card>
    </div>
  );
}

function Signals(){
  const trading = useTrading();

  return (
    <div className="page">
      <Card title="AI Trading Signals">
        <ConnectedSignals trading={trading}/>
      </Card>
    </div>
  );
}

function AI(){
  const trading = useTrading();

  const liveSignals = Array.isArray(trading?.liveSignals)
    ? trading.liveSignals
    : [];

  return (
    <div className="page">
      <div className="metrics">
        <Card title="Market Sentiment">
          <h2 className="green">
            {liveSignals.length ? "ACTIVE" : "WAITING"}
          </h2>
          <p>{liveSignals.length} live signals</p>
        </Card>

        <Card title="AI Analysis">
          <h2>
            {String(trading?.aiAnalysisStatus ?? "unknown").toUpperCase()}
          </h2>
          <p>
            {trading?.lastAIUpdate
              ? new Date(trading.lastAIUpdate).toLocaleString()
              : "No completed analysis yet"}
          </p>
        </Card>

        <Card title="Signal Pool">
          <h2 className="green">
            {String(trading?.signalsCache?.signals?.length ?? 0)}
          </h2>
          <p>Total cached signals</p>
        </Card>
      </div>

      <Card title="AI Market Analysis">
        <div className="analysis">
          <div className="orb">✦</div>
          <div>
            <small>AI STATUS</small>
            <h2>
              {trading?.aiAnalysisStatus === "updating"
                ? "Analysis in progress..."
                : "AI analysis connected"}
            </h2>
            <p>
              This preview is connected to the existing TradingContext.
              No AI/trading actions are modified by the redesign.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Auto(){
  const trading = useTrading();

  return (
    <div className="page">
      <div className="metrics">
        <Card title="Auto Trader">
          <div className="settings">
            <div>
              Status
              <strong>
                {trading?.autoTraderEnabled ? "RUNNING" : "OFF"}
              </strong>
            </div>

            <div>
              Open Live Positions
              <strong>
                {String(trading?.liveOrders?.filter(
                  (o: any) =>
                    ["NEW", "PARTIALLY_FILLED", "OPEN"].includes(
                      String(o?.status ?? "").toUpperCase()
                    )
                ).length ?? 0)}
              </strong>
            </div>

            <div>
              Trading Mode
              <strong>
                {trading?.isPionexLive ? "PIONEX LIVE" : "DEMO"}
              </strong>
            </div>

            <div>
              Last Auto Action
              <strong>
                {trading?.autoTradeTrace?.timestamp
                  ? new Date(trading.autoTradeTrace.timestamp).toLocaleString()
                  : "—"}
              </strong>
            </div>
          </div>

          <div className="tm-readonly">
            Read-only preview. Trading actions remain on the existing app.
          </div>
        </Card>

        <Card title="System Status">
          <div className="settings">
            <div>Pionex Account<strong>{String(trading?.pionexAccountStatus ?? "unknown").toUpperCase()}</strong></div>
            <div>Market Data<strong>{String(trading?.marketDataStatus ?? "unknown").toUpperCase()}</strong></div>
            <div>AI Analysis<strong>{String(trading?.aiAnalysisStatus ?? "unknown").toUpperCase()}</strong></div>
            <div>Live Trading<strong>{trading?.isPionexLive ? "ON" : "OFF"}</strong></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function History(){
  const trading = useTrading();

  const orders = Array.isArray(trading?.liveOrders)
    ? trading.liveOrders
    : [];

  return (
    <div className="page">
      <Card title="Trading History">
        {!orders.length ? (
          <div className="tm-empty">No live trading history available.</div>
        ) : (
          <div className="table">
            <div className="tr th">
              PAIR　 SIDE　 STATUS　 ENTRY　 TP　 SL　 PnL
            </div>

            {orders.map((order: any) => {
              const pnl = getOrderPnL(order);
              const side = order?.side === "BUY" ? "LONG" : "SHORT";

              return (
                <div
                  className="tr"
                  key={order?.id ?? order?.pionex_order_id}
                >
                  <b>{order?.pair ?? order?.symbol ?? "—"}</b>

                  <label className={side === "LONG" ? "green" : "red"}>
                    {side}
                  </label>

                  <span>{String(order?.status ?? "—")}</span>

                  <span>{getOrderEntry(order)}</span>

                  <span className="green">
                    {formatNumber(order?.take_profit, 2)}
                  </span>

                  <span className="red">
                    {formatNumber(order?.stop_loss, 2)}
                  </span>

                  <span className={pnl >= 0 ? "green" : "red"}>
                    {pnl >= 0 ? "+" : ""}
                    {formatNumber(pnl)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function Wallet(){
  const trading = useTrading();

  const account = trading?.demoAccount ?? null;

  const balance = Number(
    account?.balance ??
      0
  );

  return (
    <div className="page">
      <Card title="Wallet Overview">
        <h2 className="wallet">
          {formatNumber(balance, 2)}
          <small> USDT</small>
        </h2>

        <div className="wallet-actions">
          Account status:{" "}
          {trading?.pionexAccountStatus ?? "disconnected"}
        </div>

        <div className="assets">
          <div>
            Available Balance
            <strong>{formatNumber(account?.balance, 2)} USDT</strong>
          </div>

          <div>
            Open Positions
            <strong>{String(trading?.liveOrders?.length ?? 0)}</strong>
          </div>

          <div>
            Trading State
            <strong>{trading?.isPionexLive ? "LIVE" : "OFF"}</strong>
          </div>

          <div>
            Market Data
            <strong>{String(trading?.marketDataStatus ?? "unknown").toUpperCase()}</strong>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Settings(){return <div className="page"><Card title="Trading Settings"><div className="settings">{["Default Leverage　10×","Default Risk per Trade　2%","Confirm Orders　● ON","Auto Set TP/SL from AI　● ON","Show Advanced Options　○"].map(x=><div key={x}>{x}</div>)}</div></Card></div>}
