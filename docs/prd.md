# Requirements Document

## 1. Application Overview

**Application Name**: TradeMindMZ - AI Trading Assistant for Pionex

**Version**: V2.1 - TRADING FLOW SEPARATION + MANUAL BUY + AUTO TRADE DEBUG

**Description**: An AI-powered cryptocurrency market analysis assistant designed to help users analyze markets and make informed trading decisions on Pionex. The application features a local-first analysis engine that processes all available USDT pairs, server-side recommendation scoring, AI verification of top candidates, three distinct trading modes (Demo Trading, Manual Live Trading, Auto Trading), and read-only Pionex integration. TradeMindMZ focuses exclusively on AI analysis and Pionex integration - it is NOT a general cryptocurrency website.

**Visual Design Reference**: https://miaoda-conversation-file.s3cdn.medo.dev/user-9eisix7s87i8/app-dkpfpbala41t/20260808/1000027376.png (A3 design concept as inspiration)

**Design Style**: Dark premium interface with black/charcoal background, purple neon accent (#7C3AED or similar), green for positive/recommended values, orange for watch/warning, red for rejected/risk, clean cards, soft edges, subtle glow effects, professional typography.

## 2. Users and Use Scenarios

**Target Users**: Cryptocurrency traders who use or plan to use Pionex exchange and want AI-powered market analysis, risk-free practice trading, and live trading capabilities.

**Core Use Scenarios**:
- Analyze cryptocurrency market opportunities through local-first analysis engine and AI-verified signals
- Practice trading strategies using demo account with virtual funds
- Execute manual live trades on Pionex with confirmation and safety checks
- Monitor automated trading execution and diagnostics
- Monitor Pionex portfolio and trading activity (read-only)
- Track AI signal performance, demo trading results, and live trading results
- View real-time market regime and pipeline diagnostics

## 3. Page Structure and Functionality

```
TradeMindMZ
├── Authentication Pages
│   ├── Register
│   ├── Login
│   ├── Forgot Password
│   └── Reset Password
├── Dashboard
├── AI Signals
├── Market Overview
├── Pipeline Diagnostics
├── AI Performance
├── Trading Diagnostics (NEW)
├── Exchange Connections
└── Settings
```

### 3.1 Authentication Pages

#### 3.1.1 Register
- User provides email, password, confirm password
- System validates input and creates account
- User redirected to Login after successful registration

#### 3.1.2 Login
- User provides email and password
- System authenticates and creates persistent session
- User redirected to Dashboard after successful login

#### 3.1.3 Logout
- User clicks logout
- System terminates session but preserves user account, demo trading account data, and live trading records

#### 3.1.4 Forgot Password
- User provides email
- System sends password reset link

#### 3.1.5 Reset Password
- User clicks reset link from email
- User provides new password and confirms
- System updates password

### 3.2 Dashboard

#### 3.2.1 Top Status Bar
- Displays Pionex connection status (CONNECTED / NOT CONNECTED)
- Displays system status:
  + LOCAL ENGINE: ACTIVE
  + MARKET SCANNER: ACTIVE
  + AI REVIEW: ACTIVE / RATE LIMITED / ERROR
- Displays last update timestamp
- Displays user profile information
- Displays trading mode indicators: DEMO ACCOUNT / LIVE TRADING ENABLED / LIVE TRADING DISABLED

#### 3.2.2 Pipeline Overview Section
- **PAIRS SCANNED**: Total number of USDT pairs analyzed locally
- **LOCAL SETUPS**: Number of qualified local setups (STRONG_SETUP + GOOD_SETUP)
- **AI REVIEW**: Number of candidates sent to AI
- **AI VERIFIED**: Number of AI-approved signals
- **RECOMMENDED**: Number of signals meeting all criteria for Auto Trader

#### 3.2.3 Best Current Setup Card
- Displays top-ranked opportunity:
  + Coin logo and name
  + Trading pair
  + Signal type: BUY / SELL
  + Recommendation score (0-100)
  + AI confidence percentage
  + Risk/Reward ratio
  + Market regime
  + Historical win rate
  + Sample size
  + AI status: LOCAL_SETUP / AI_REVIEW / AI_VERIFIED / RECOMMENDED
  + Current price
  + Entry zone
  + Take Profit target
  + Stop Loss level
- Trading action buttons:
  + Demo Buy button
  + BUY LIVE button (if Pionex connected and live trading enabled)

#### 3.2.4 Main Status Cards
- **Portfolio Value**: Total value from Pionex account (if connected)
- **Today's P/L**: Profit/loss for current day
- **Demo Balance**: Available virtual USDT in demo account
- **Open Demo Trades**: Number of active demo positions
- **Open Live Trades**: Number of active live positions on Pionex
- **Active Pionex Bots**: Number of running bots on Pionex (if connected)
- **Market Sentiment**: Overall market sentiment indicator

#### 3.2.5 Top Opportunities Section
- Displays 3-5 highest-ranked opportunities
- Each opportunity card shows:
  + Coin logo and name
  + Trading pair
  + Current price
  + Signal type: BUY / SELL
  + Recommendation score
  + AI confidence percentage
  + Risk level
  + Entry zone price range
  + Take Profit target
  + Stop Loss level
  + Risk/Reward ratio
  + Expected hold time
  + Signal strength
  + Market regime
  + Historical win rate
  + Sample size
  + MFE (Maximum Favorable Excursion)
  + MAE (Maximum Adverse Excursion)
  + AI status
  + Freshness indicator
  + AI reasoning with indicators (Trend, Momentum, RSI, MACD, Volume, Support/Resistance)
  + Recommendation score breakdown
- Trading action buttons for each opportunity:
  + Demo Buy button
  + BUY LIVE button (visually distinct, disabled if Pionex not connected or live trading disabled, shows reason when disabled)

### 3.3 AI Signals

#### 3.3.1 Signal List
- Displays all signals with status: LOCAL_SETUP, AI_REVIEW, AI_VERIFIED, RECOMMENDED, WATCH, NO_TRADE, EXPIRED, WIN, LOSS
- Each signal includes:
  + All information from Dashboard opportunities
  + Signal status
  + Creation timestamp
  + Expiration timestamp (if applicable)
- Filter options: Signal status, Signal type (BUY/SELL), Risk level, Confidence level, Market regime
- Sort options: Recommendation score, Confidence, Risk/Reward, Signal strength, Freshness
- Trading action buttons:
  + Demo Buy button
  + BUY LIVE button (visually distinct, disabled if Pionex not connected or live trading disabled)

#### 3.3.2 Demo Trading Actions

##### 3.3.2.1 Demo Buy Flow
- Demo Buy button opens confirmation modal
- Confirmation modal displays:
  + Coin and trading pair
  + Current price
  + Entry price
  + Available demo balance
  + Trade amount options: 25 USDT, 50 USDT, 100 USDT, 250 USDT, Custom amount
  + Position size calculation
  + Stop Loss level
  + Take Profit target
  + Risk/Reward ratio
  + AI confidence
  + Clear label: DEMO TRADE (SIMULATED FUNDS)
- User confirms to execute demo trade
- System validates:
  + Trade amount does not exceed available demo balance
  + Trade amount is positive
- System deducts amount from demo balance and creates open demo position
- Demo trade record includes:
  + signal_id
  + Entry price
  + Quantity
  + Investment amount
  + Stop Loss level
  + Take Profit target
  + Opened timestamp

##### 3.3.2.2 Open Demo Trades
- Displays all active demo positions
- Each position shows:
  + Coin logo and name
  + Trading pair
  + Buy price
  + Current price (live updates)
  + Quantity
  + Investment amount
  + Current value (live calculation)
  + Unrealized P/L (live calculation)
  + P/L percentage (live calculation)
  + Stop Loss level
  + Take Profit target
  + AI confidence at entry
  + Opened time
- Close Trade button for each position

##### 3.3.2.3 AI Trade Monitoring (Demo)
- For each open demo trade displays:
  + AI status: Holding / Bullish / Bearish / Take Profit Approaching / Stop Loss Approaching / Trend Changed / Risk Increased / Potential Exit
  + AI recommendation: Hold / Reduce Risk / Consider Closing / Take Profit / Exit
- AI monitors but does NOT automatically close trades (except automatic TP/SL triggers)

##### 3.3.2.4 Close Demo Trade
- User clicks Close Trade button
- Confirmation modal displays:
  + Entry price and current price
  + Quantity
  + Investment amount
  + Current value
  + P/L amount
  + P/L percentage
- User confirms closure
- System calculates final value, returns to demo balance, records in demo trade history

##### 3.3.2.5 Demo Trade History
- Displays closed demo trades
- Each record shows:
  + Coin and trading pair
  + Buy price
  + Sell price
  + Investment amount
  + P/L amount
  + Profit percentage
  + Duration
  + AI confidence at entry
  + Entry date
  + Exit date
  + Exit reason (Manual Close / Take Profit / Stop Loss)

##### 3.3.2.6 Demo Performance Statistics
- **Account Overview**:
  + Demo account value
  + Available USDT
  + Invested amount
  + Unrealized P/L
  + Realized P/L
  + Total return percentage
- **Trading Statistics**:
  + Total trades
  + Winning trades
  + Losing trades
  + Win rate
  + Average gain
  + Average loss
  + Best trade
  + Worst trade

##### 3.3.2.7 Demo Account Management
- **Reset Demo Account**: Button with confirmation modal, resets balance to 500 USDT, removes all open trades, history and statistics
- **Top Up Demo Account**: Options to add +500 USDT, +1,000 USDT, +5,000 USDT (virtual money, clearly labeled SIMULATED)

#### 3.3.3 Manual Live Trading Actions (NEW)

##### 3.3.3.1 BUY LIVE Flow
- BUY LIVE button appears on each live signal card
- Button is visually distinct from Demo Buy button
- Button states:
  + Enabled: Pionex connected AND live trading enabled
  + Disabled: Shows reason (Pionex Not Connected / Live Trading Disabled / Duplicate Trade Exists)
- User clicks BUY LIVE button
- System opens confirmation dialog displaying:
  + Pair (e.g., ETH/USDT)
  + Side: BUY
  + Entry/Current price
  + Investment amount (USDT)
  + Estimated quantity
  + Estimated fee
  + Total estimated cost
  + Confirm and Cancel buttons
  + Clear label: LIVE TRADE (REAL FUNDS)
- User clicks Confirm
- System runs pre-flight safety checks (same as place_order):
  + Pionex connected
  + Valid symbol
  + Sufficient balance
  + Valid quantity
  + basePrecision validation
  + Minimum order value validation
  + Maximum live trade limit (MAX_LIVE_TRADE_USDT)
  + No existing open trade for same signal_id (duplicate protection)
  + Correct symbol format conversion (ETH/USDT → ETHUSDT)
- If any check fails:
  + Display concrete error reason: INSUFFICIENT_BALANCE / RATE_LIMITED / REJECTED / INVALID_SYMBOL / BELOW_MIN_ORDER / DUPLICATE / TIMEOUT / PIONEX_NOT_CONNECTED / BALANCE_CHECK_FAILED
  + Do NOT create fake FILLED/EXECUTED record
  + Do NOT proceed to Pionex
- If all checks pass:
  + Call existing place_order flow
  + Send one real BUY order to Pionex via Pionex-proxy
  + Receive Pionex response with order_id and status
  + Save live_orders record with:
    - signal_id
    - user_id
    - symbol
    - side: BUY
    - quantity
    - price
    - order_id (from Pionex)
    - status: NEW / FILLED / UNKNOWN (per Pionex response)
    - created_at timestamp
  + Display Pionex order_id to user
  + Display order status: NEW / FILLED / UNKNOWN
- If Pionex rejects order:
  + Display rejection reason from Pionex
  + Do NOT create live_orders record with fake FILLED status

##### 3.3.3.2 Open Live Trades
- Displays all active live positions from Pionex
- Each position shows:
  + Coin logo and name
  + Trading pair
  + Buy price
  + Current price (live updates)
  + Quantity
  + Investment amount
  + Current value (live calculation)
  + Unrealized P/L (live calculation)
  + P/L percentage (live calculation)
  + Pionex order_id
  + Order status: NEW / FILLED / PARTIALLY_FILLED / UNKNOWN
  + Opened time
- Note: Manual close functionality not included in this release (read-only Pionex integration)

##### 3.3.3.3 Live Trade History
- Displays closed live trades from Pionex
- Each record shows:
  + Coin and trading pair
  + Buy price
  + Sell price
  + Investment amount
  + P/L amount
  + Profit percentage
  + Duration
  + Pionex order_id
  + Entry date
  + Exit date

##### 3.3.3.4 Live Performance Statistics
- **Account Overview**:
  + Live account value (from Pionex)
  + Available USDT (from Pionex)
  + Invested amount
  + Unrealized P/L
  + Realized P/L
  + Total return percentage
- **Trading Statistics**:
  + Total live trades
  + Winning trades
  + Losing trades
  + Win rate
  + Average gain
  + Average loss
  + Best trade
  + Worst trade

#### 3.3.4 Auto Trading Status
- Displays Auto Trade status: ENABLED / DISABLED
- Displays last Auto Trade evaluation timestamp
- Displays Auto Trade execution count today
- Toggle to enable/disable Auto Trade

#### 3.3.5 AI Performance Tracking
- Total AI signals generated
- Winning signals count
- Losing signals count
- Win rate percentage
- Average return per signal
- Best signal performance
- Worst signal performance

### 3.4 Market Overview

#### 3.4.1 Market Regime Display
- Current market regime: BULL / BEAR / RANGING / VOLATILE
- Pair count per regime
- BUY opportunities count
- SELL opportunities count

#### 3.4.2 Market Statistics
- Total pairs analyzed
- Pairs with strong setups
- Pairs with good setups
- Pairs under watch
- Average volatility
- Average volume change

### 3.5 Pipeline Diagnostics

#### 3.5.1 Analysis Funnel
- Displays pipeline stages with counts and timing:
  + Market Scan: [count] pairs, [time]ms
  + Local Analysis: [count] analyzed, [time]ms
  + Qualified: [count] setups (STRONG + GOOD)
  + Top Candidates: [count] sent to AI
  + AI Review: [count] processed, [time]ms
  + AI Verified: [count] approved
  + Recommended: [count] meeting all criteria
  + Auto Trader: [count] eligible

#### 3.5.2 Stage Details
- Each stage shows:
  + Input count
  + Output count
  + Processing time
  + Success rate
  + Error count (if any)

### 3.6 AI Performance

#### 3.6.1 AI Call Statistics
- AI calls today
- Gemini calls
- Groq calls
- Rate limits encountered
- AI success rate

#### 3.6.2 AI Decision Tracking
- AI verified count
- AI rejected count
- AI upgraded count (from WATCH to RECOMMENDED)
- AI downgraded count (from RECOMMENDED to WATCH)

#### 3.6.3 Performance Comparison
- LOCAL_SETUP performance: Win rate, Avg P/L
- AI_VERIFIED performance: Win rate, Avg P/L
- RECOMMENDED performance: Win rate, Avg P/L

### 3.7 Trading Diagnostics (NEW)

#### 3.7.1 Auto Trade Execution Trace
- Displays complete Auto Trade flow trace:
  + Signal selected for evaluation
  + Signal details: pair, side, confidence, strength, risk/reward
  + auto-trader-eval triggered: YES / NO
  + Pre-flight gates status:
    - Gate 1 (Max 5 USDT per trade): PASS / FAIL
    - Gate 2 (Max 1 open trade): PASS / FAIL
    - Gate 3 (Duplicate protection): PASS / FAIL
    - Gate 4 (Balance check): PASS / FAIL
    - Gate 5 (Symbol validation): PASS / FAIL
    - Gate 6 (Live trading flag): PASS / FAIL
    - Gate 7 (Pionex connection): PASS / FAIL
    - Gate 8 (Confidence ≥65): PASS / FAIL
    - Gate 9 (Strength ≥65): PASS / FAIL
    - Gate 10 (Risk/Reward ≥1.50): PASS / FAIL
    - Gate 11 (TP/SL limits): PASS / FAIL
  + place_order called: YES / NO
  + Pionex request sent: YES / NO
  + Pionex HTTP status: 200 / 400 / 429 / 500 / TIMEOUT
  + Pionex order_id: [order_id] / NULL
  + live_orders record created: YES / NO
  + Order status: NEW / FILLED / REJECTED / UNKNOWN
  + Failure reason (if any): [concrete reason]
  + Timestamp

#### 3.7.2 Manual Buy Execution Trace
- Displays Manual Buy execution details:
  + Signal selected
  + User confirmation: YES / NO
  + Pre-flight gates status (same as Auto Trade)
  + place_order called: YES / NO
  + Pionex request sent: YES / NO
  + Pionex HTTP status
  + Pionex order_id
  + live_orders record created: YES / NO
  + Order status
  + Failure reason (if any)
  + Timestamp

#### 3.7.3 Demo Buy Execution Trace
- Displays Demo Buy execution details:
  + Signal selected
  + User confirmation: YES / NO
  + Demo balance validation: PASS / FAIL
  + Demo trade created: YES / NO
  + Demo balance updated: YES / NO
  + Failure reason (if any)
  + Timestamp

#### 3.7.4 Dry Run Testing
- Toggle for Dry Run mode
- When enabled:
  + Manual Buy dry run: Executes all checks, displays Pionex request details, does NOT send to Pionex
  + Auto Trade dry run: Executes all checks, displays Pionex request details, does NOT send to Pionex
  + Dry run report includes: Signal details, Pre-flight gates, Pionex request payload, Expected response, Pionex request: NOT SENT

### 3.8 Exchange Connections

#### 3.8.1 Pionex Connection Status
- Displays connection status: Connected / Not Connected
- Displays last sync time
- Displays API permissions (read-only)

#### 3.8.2 Pionex API Configuration
- Input fields for API Key and API Secret
- Connect button to establish connection
- Disconnect button to remove connection
- Test Connection button to verify credentials

#### 3.8.3 Pionex Portfolio View (Read-Only)
- Portfolio balances for all assets
- Open orders list
- Trade history
- Running bots list
- Bot performance data

#### 3.8.4 Connection Error Handling
- If Pionex API fails, display clear error message
- Application continues to function with AI signals and demo trading
- User can retry connection

### 3.9 Settings

#### 3.9.1 User Preferences
- Display name
- Email address
- Password change option

#### 3.9.2 API Key Management
- View connected exchanges
- Update Pionex API credentials
- Remove API connections

#### 3.9.3 Trading Settings (NEW)
- Live trading toggle: ENABLED / DISABLED
- Maximum live trade amount (USDT)
- Auto Trade toggle: ENABLED / DISABLED

#### 3.9.4 Notification Settings
- Email notifications toggle
- AI signal notifications toggle
- Demo trade notifications toggle
- Live trade notifications toggle

#### 3.9.5 Theme Options
- Dark mode (default)
- Color accent preferences

## 4. Business Rules and Logic

### 4.1 Local-First Analysis Pipeline

#### 4.1.1 Pipeline Flow
- Pionex market data → Local market scanner → Technical analysis → Market regime → Local scoring → Historical performance → MFE/MAE → Volatility → RR/TP/SL → Server recommendation score → Top opportunities → Gemini/Groq review → RECOMMENDED/WATCH/NO_TRADE → Auto Trader safety gates → Pionex

#### 4.1.2 Local Engine Analysis
- Analyzes ALL available USDT pairs locally
- Per pair calculates:
  + EMA9/EMA21
  + Trend direction
  + Momentum
  + RSI
  + MACD
  + Volume + relative volume
  + 24h change
  + ATR
  + Volatility
  + Support/resistance levels
  + Market regime
  + BUY/SELL bias
  + Estimated Risk/Reward
  + Take Profit / Stop Loss
  + Historical win rate
  + Average P/L
  + Sample size
  + MFE (Maximum Favorable Excursion)
  + MAE (Maximum Adverse Excursion)

#### 4.1.3 Candidate Selection
- Ranks all locally analyzed coins
- Classifies as: STRONG_SETUP, GOOD_SETUP, WATCH, EXPLORATION
- Selects best ~5 candidates to send to AI
- Qualified local setups NOT sent to AI remain visible as LOCAL_SETUP or WATCH

#### 4.1.4 AI Role
- AI receives only best candidates with all TradeMindMZ calculations
- AI returns: RECOMMENDED / WATCH / NO_TRADE + confidence + explanation
- AI cannot override hard server rules, safety gates, or mathematically calculated TP/SL

#### 4.1.5 AI Rate Limit Handling (CRITICAL)
- If AI returns 429/timeout/error:
  + Preserve existing LIVE signals
  + Never write signals=[]
  + Never delete cache
  + Continue local scoring
  + Continue showing local setups
  + Mark AI as RATE LIMITED
- UI shows: \"LOCAL ENGINE: ACTIVE / MARKET SCANNER: ACTIVE / AI REVIEW: RATE LIMITED\"

### 4.2 Recommendation Engine (Canonical, Server-Side)

#### 4.2.1 Scoring Components
- Historical evidence: 40%
- Local technical score: 25%
- Risk/Reward: 15%
- Market regime: 10%
- Momentum: 5%
- Freshness: 5%

#### 4.2.2 Classification Thresholds
- 80-100: STRONG_SETUP
- 70-79: GOOD_SETUP
- 60-69: WATCH
- <60: NO_TRADE

#### 4.2.3 Sample Size Protection
- Applies shrinkage protection for insufficient sample sizes
- Reduces weight of historical evidence when sample size < minimum threshold

### 4.3 Signal Status Definitions

#### 4.3.1 Status Types
- **LOCAL_SETUP**: Qualified by local analysis, not yet sent to AI
- **AI_REVIEW**: Currently being reviewed by AI
- **AI_VERIFIED**: Approved by AI
- **RECOMMENDED**: Meets all criteria for Auto Trader
- **WATCH**: Qualified but requires caution
- **NO_TRADE**: Does not meet criteria
- **EXPIRED**: Signal validity period expired
- **WIN**: Closed trade with profit
- **LOSS**: Closed trade with loss

### 4.4 Trading Flow Separation (CRITICAL)

#### 4.4.1 Three Distinct Trading Modes

**Mode 1: DEMO BUY**
- Preserves existing Demo Buy behavior
- Never sends real orders to Pionex
- Only creates demo trades/positions using demo balance
- Stores: signal_id, entry price, quantity, investment amount, TP, SL, timestamp
- Completely separate from live trading
- Uses virtual funds only
- All demo funds clearly labeled: DEMO ACCOUNT / SIMULATED FUNDS

**Mode 2: MANUAL BUY (NEW)**
- User-initiated live trading via BUY LIVE button
- Shows clear confirmation dialog before execution
- Runs same safety checks as place_order
- Calls existing place_order flow
- Sends one real BUY order to Pionex
- Saves live_orders record with Pionex order_id and status
- Shares same order logic with Auto Trade
- Only difference: initiated by user click vs auto-trader-eval

**Mode 3: AUTO TRADE**
- System-initiated live trading via auto-trader-eval
- Runs same safety checks as place_order
- Calls existing place_order flow
- Sends one real BUY order to Pionex
- Saves live_orders record with Pionex order_id and status
- Shares same order logic with Manual Buy
- Only difference: initiated by auto-trader-eval vs user click

#### 4.4.2 Shared Order Logic
- Manual Buy and Auto Trade use identical place_order flow
- place_order → Pionex-proxy → Pionex API → live_orders record
- Same security checks
- Same duplicate protection
- Same balance validation
- Same quantity validation
- Same symbol format conversion
- Same error handling
- Same status mapping

### 4.5 Manual Buy Rules (NEW)

#### 4.5.1 Pre-Flight Safety Checks
Before sending order to Pionex, system validates:
1. Pionex connected
2. Valid symbol
3. Sufficient balance (from Pionex account)
4. Valid quantity (positive, meets basePrecision)
5. Minimum order value met
6. Maximum live trade limit (MAX_LIVE_TRADE_USDT) not exceeded
7. No existing open trade for same signal_id (duplicate protection)
8. Correct symbol format (ETH/USDT → ETHUSDT)

#### 4.5.2 Confirmation Dialog Requirements
- Must display:
  + Pair
  + Side: BUY
  + Entry/Current price
  + Investment amount (USDT)
  + Estimated quantity
  + Estimated fee
  + Total estimated cost
  + Confirm and Cancel buttons
  + Clear label: LIVE TRADE (REAL FUNDS)

#### 4.5.3 Error Handling
- If any pre-flight check fails:
  + Display concrete error reason
  + Do NOT create fake FILLED/EXECUTED record
  + Do NOT proceed to Pionex
- Possible error reasons:
  + INSUFFICIENT_BALANCE
  + RATE_LIMITED
  + REJECTED
  + INVALID_SYMBOL
  + BELOW_MIN_ORDER
  + DUPLICATE
  + TIMEOUT
  + PIONEX_NOT_CONNECTED
  + BALANCE_CHECK_FAILED

#### 4.5.4 Success Flow
- If all checks pass:
  + Call place_order
  + Send real BUY order to Pionex
  + Receive Pionex response
  + Save live_orders record with:
    - signal_id
    - user_id
    - symbol
    - side: BUY
    - quantity
    - price
    - order_id (from Pionex)
    - status: NEW / FILLED / UNKNOWN
    - created_at
  + Display Pionex order_id to user
  + Display order status

#### 4.5.5 Duplicate Protection
- One user + same signal_id = maximum one live order
- Check live_orders table before creating new order
- If duplicate exists, reject with DUPLICATE error

### 4.6 Auto Trade Rules

#### 4.6.1 Safety Gates (UNCHANGED)
- Max 5 USDT per trade (MAX_LIVE_TRADE_USDT)
- Max 1 open trade at a time
- Duplicate protection (one signal_id per user)
- Balance check
- Symbol validation
- Live trading flag check
- Pionex connection required
- Confidence gate: ≥65
- Strength gate: ≥65
- Risk/Reward gate: ≥1.50
- Take Profit / Stop Loss limits validation

#### 4.6.2 Execution Criteria
- Signal must be RECOMMENDED
- Signal must be FRESH
- All safety gates must pass

#### 4.6.3 Auto Trade Diagnostics (NEW)
- System traces complete Auto Trade flow:
  + Signal selection
  + auto-trader-eval triggered: YES / NO
  + Each safety gate: PASS / FAIL
  + place_order called: YES / NO
  + Pionex request sent: YES / NO
  + HTTP status
  + order_id
  + live_orders creation: YES / NO
  + Order status
  + Failure reason (if any)
- No silent failures allowed
- All failures must be logged and displayed in Trading Diagnostics

### 4.7 Demo Trading System Rules

#### 4.7.1 Separation from Real Trading
- Demo trading completely separated from Pionex
- Uses only virtual money (NO REAL MONEY)
- Does NOT send orders to Pionex
- Does NOT interact with Pionex trading API
- Starting demo balance: 500 USDT
- All demo funds clearly labeled as DEMO ACCOUNT / SIMULATED FUNDS

#### 4.7.2 Demo Trade Execution
- User cannot use more than available demo balance
- Trade amount validation before execution
- Position size calculated based on trade amount and entry price
- Stop Loss and Take Profit levels set at trade creation

#### 4.7.3 Live P/L Calculation
- Uses live market prices from market data service
- Updates without page refresh
- Unrealized P/L = (Current price - Buy price) × Quantity
- P/L % = (Unrealized P/L / Investment) × 100

#### 4.7.4 Automatic Trade Closure
- When current price ≤ Stop Loss: Trade closes automatically (simulated)
- When current price ≥ Take Profit: Trade closes automatically (simulated)
- Closure returns final value to demo balance
- Records closure in demo trade history with exit reason

### 4.8 Background AI Analysis

#### 4.8.1 Analysis Execution
- User does NOT wait for AI analysis when application opens
- System uses cached analysis from previous run
- New analysis runs in background every 5-10 minutes
- Previous analysis remains displayed while update in progress
- Small status indicator shows \"Updating AI analysis...\"

#### 4.8.2 Analysis Error Handling
- If analysis fails, retain display of last successful analysis
- Never show completely empty page
- Never force full page refresh
- Display error status if analysis repeatedly fails

### 4.9 Market Data Service

#### 4.9.1 Data Source
- Use one centralized market data service
- Use reliable established market data API (CoinGecko or similar)
- Prioritize Pionex trading pairs: BTC/USDT, ETH/USDT, SOL/USDT, etc.
- DO NOT scrape Google
- DO NOT use hardcoded prices
- DO NOT use fake market data

#### 4.9.2 Data Error Handling
- If primary API fails: retain last successful market data
- Display status: \"Live data temporarily unavailable\"
- Application continues to function with cached data
- Retry connection in background

### 4.10 Pionex Integration Rules

#### 4.10.1 Read-Only Access
- Integration is READ-ONLY for portfolio/orders/bots display
- Write access ONLY for Manual Buy and Auto Trade order placement
- DO NOT cancel or modify existing orders
- DO NOT create or modify bots
- DO NOT transfer funds
- Only fetch and display: Portfolio balances, Open orders, Trade history, Running bots, Bot performance data

#### 4.10.2 API Security
- Never store Pionex API Secret in localStorage, sessionStorage, URL or frontend code
- Store credentials securely on backend
- Encrypt sensitive credentials
- Never return API Secret to frontend

#### 4.10.3 Connection Error Handling
- If Pionex API fails, application continues to function
- Display clear connection error message
- Never crash application
- User can retry connection or continue using AI signals and demo trading

### 4.11 Session Management

#### 4.11.1 Persistent Sessions
- User sessions persist across browser sessions
- After logout and re-login, user account data remains available
- Demo trading account data remains available after logout/login
- Open demo trades persist
- Demo trade history persists
- Live trading records persist

### 4.12 Data Source Indicator

#### 4.12.1 Always Visible Status
- Market data: LIVE
- Pionex: CONNECTED / NOT CONNECTED
- AI analysis: Updated X minutes ago
- Demo trading: SIMULATED FUNDS
- Live trading: ENABLED / DISABLED

### 4.13 Asynchronous UI

#### 4.13.1 Non-Blocking Display
- DO NOT wait for AI
- Show local results immediately while AI processes
- Display loading indicators for AI review stage only
- Never block user interaction

## 5. Exceptions and Edge Cases

| Scenario | Handling |
|----------|----------|
| User attempts demo trade exceeding available balance | Display error message, prevent trade execution |
| User attempts Manual Buy with insufficient Pionex balance | Display INSUFFICIENT_BALANCE error, prevent order |
| User attempts Manual Buy for signal with existing open trade | Display DUPLICATE error, prevent order |
| User attempts Manual Buy when Pionex not connected | Disable BUY LIVE button, show PIONEX_NOT_CONNECTED |
| User attempts Manual Buy when live trading disabled | Disable BUY LIVE button, show LIVE_TRADING_DISABLED |
| Pionex rejects Manual Buy order | Display rejection reason, do NOT create fake FILLED record |
| Pionex returns 429 rate limit for Manual Buy | Display RATE_LIMITED error, suggest retry later |
| Pionex timeout during Manual Buy | Display TIMEOUT error, suggest retry |
| Auto Trade evaluation triggered but all gates fail | Log failure reason in Trading Diagnostics, do NOT send order |
| Auto Trade sends order but Pionex rejects | Log rejection in Trading Diagnostics, do NOT create fake record |
| Auto Trade duplicate protection triggered | Log DUPLICATE in Trading Diagnostics, skip order |
| Market data API unavailable | Use cached data, display \"Live data temporarily unavailable\" |
| Pionex API connection fails | Display connection error, allow retry, application continues to function |
| AI analysis fails | Retain display of last successful analysis, display error status |
| User provides invalid API credentials | Display authentication error, prevent connection |
| Demo trade Stop Loss/Take Profit triggered | Close trade automatically (simulated), record in history |
| User attempts to close already closed demo trade | Prevent action, display error message |
| User attempts demo account reset | Require confirmation before executing reset |
| Network timeout during API request | Display timeout message, implement retry logic |
| User logs out with open demo trades | Preserve all demo trades and data for next login |
| User logs out with open live trades | Preserve all live trades records for next login |
| AI generates no high-confidence signals | Display WAIT status or \"No high-confidence opportunity detected\" |
| User attempts to connect multiple exchanges | Only Pionex supported, display message |
| Server analyzes 70+ coins but finds no TOP 5 candidates | Display WAIT status, no signals sent to AI |
| AI returns WATCH for all TOP 5 candidates | Display WATCH signals with concrete reason |
| Historical sample size insufficient | Mark as \"Insufficient historical data\", reduce historical score weight |
| Gemini/Groq rate limit reached | Preserve existing LIVE signals, log error, retry after cooldown, mark AI as RATE LIMITED |
| Local engine finds qualified setups but AI unavailable | Display LOCAL_SETUP signals, continue showing local analysis results |
| AI returns 429/timeout/error | Preserve existing signals, never write signals=[], continue local scoring, mark AI as RATE LIMITED |
| place_order called but Pionex request fails | Log failure in Trading Diagnostics, display error to user, do NOT create live_orders record |
| live_orders record creation fails | Log error, display to user, mark order as UNKNOWN |
| Dry run mode enabled | Execute all checks, display Pionex request details, do NOT send to Pionex, show \"Pionex request: NOT SENT\" |

## 6. Acceptance Criteria

1. User registers account, logs in and accesses Dashboard
2. User sees Pipeline Overview showing PAIRS SCANNED, LOCAL SETUPS, AI REVIEW, AI VERIFIED, RECOMMENDED counts
3. User sees Best Current Setup card displaying top-ranked opportunity with Demo Buy and BUY LIVE buttons
4. User sees Top Opportunities section showing 3-5 signals with Demo Buy and BUY LIVE buttons
5. User clicks Demo Buy on a signal, confirms trade with selected amount, and demo trade opens successfully
6. User sees Open Demo Trades displaying live P/L updates without page refresh
7. User closes demo trade, confirms closure, and sees updated demo balance and trade recorded in history
8. User clicks BUY LIVE on a signal, sees confirmation dialog with pair, side, price, investment, quantity, fee, total cost
9. User confirms Manual Buy, system runs all pre-flight safety checks, sends order to Pionex, receives order_id and status, creates live_orders record
10. User sees Open Live Trades displaying live positions from Pionex with order_id and status
11. User connects to Pionex account using API credentials and sees portfolio data (read-only)
12. User navigates to Market Overview and sees current market regime with pair counts
13. User navigates to Pipeline Diagnostics and sees analysis funnel with counts and timing for each stage
14. User navigates to AI Performance and sees AI call statistics and performance comparison between LOCAL_SETUP, AI_VERIFIED and RECOMMENDED
15. User navigates to Trading Diagnostics and sees complete Auto Trade execution trace with signal selection, gate status, place_order call, Pionex request, order_id, live_orders creation, status
16. User navigates to Trading Diagnostics and sees Manual Buy execution trace with all relevant details
17. User navigates to Trading Diagnostics and sees Demo Buy execution trace
18. User enables Dry Run mode, executes Manual Buy dry run, sees all checks and Pionex request details with \"Pionex request: NOT SENT\"
19. User enables Dry Run mode, Auto Trade dry run executes, sees all checks and Pionex request details with \"Pionex request: NOT SENT\"
20. User navigates to Settings, updates preferences, and changes are saved
21. User logs out and logs in again, all demo trades, live trades records, and account data remain intact
22. Server analyzes 70+ coins locally, ranks all, sends only TOP ~5 candidates to AI, AI returns RECOMMENDED/WATCH/NO_TRADE with transparent scoring
23. When AI encounters rate limit, system preserves existing LIVE signals, continues local scoring, displays LOCAL_SETUP signals, marks AI as RATE LIMITED
24. User sees signals with status LOCAL_SETUP when qualified by local analysis but not yet sent to AI
25. User sees AI status indicator showing LOCAL ENGINE: ACTIVE / MARKET SCANNER: ACTIVE / AI REVIEW: ACTIVE or RATE LIMITED
26. When Manual Buy pre-flight check fails, user sees concrete error reason (INSUFFICIENT_BALANCE / DUPLICATE / INVALID_SYMBOL / etc.), no fake record created
27. When Pionex rejects Manual Buy order, user sees rejection reason, no fake FILLED record created
28. When Auto Trade gate fails, failure logged in Trading Diagnostics with concrete reason, no order sent
29. When Auto Trade Pionex request fails, failure logged in Trading Diagnostics, no fake record created
30. BUY LIVE button is visually distinct from Demo Buy button, disabled when Pionex not connected or live trading disabled, shows reason when disabled

## 7. Features Not Included in This Release

- Market scanner (separate from local analysis engine)
- Trending Coins section
- Crypto news feed
- Whale Alerts
- Economic calendar
- Technical analysis tools (separate from AI analysis)
- Social features (likes, comments, shares)
- Community features
- Chat functionality
- Integration with exchanges other than Pionex
- NFT features
- Manual close of live trades (read-only Pionex integration for v1)
- Manual sell orders (only BUY orders in v1)
- Write access to Pionex for order cancellation or modification
- Write access to Pionex for bot creation or modification
- Fund transfers on Pionex
- Mobile native application (mobile-responsive web only)
- Multi-language support
- Advanced charting tools
- Portfolio optimization recommendations
- Tax reporting
- Automated trading bot creation (beyond Auto Trade)
- Copy trading features
- Change of UI/design (V2.1 updates only as specified)
- Change of TradingContext unless necessary for new trading flow (V2.1)
- Change of safety gates (V2.1)
- Change of Capacitor/Android (V2.1)
- Change of Supabase credentials (V2.1)
- Change of AI analysis logic (V2.1)
- Change of signal scoring logic (V2.1)
- Change of risk-reward calculation (V2.1)
- Change of signal thresholds (V2.1)

## 8. V2.1 Implementation Details

### 8.1 Affected Files
- supabase/functions/ai-analysis/index.ts (NO CHANGE)
- supabase/functions/ai-analysis/local_engine.ts (NO CHANGE)
- supabase/functions/ai-analysis/local_scorer.ts (NO CHANGE)
- supabase/functions/ai-analysis/recommendation_engine.ts (NO CHANGE)
- supabase/functions/ai-analysis/tpsl_engine.ts (NO CHANGE)
- supabase/functions/ai-analysis/market_scanner.ts (NO CHANGE)
- supabase/functions/ai-analysis/pipeline_diagnostics.ts (NO CHANGE)
- supabase/functions/place-order/index.ts (MODIFY: add Manual Buy support, preserve existing Auto Trade logic)
- supabase/functions/pionex-proxy/index.ts (NO CHANGE)
- Frontend components for Dashboard (MODIFY: add BUY LIVE button)
- Frontend components for AI Signals (MODIFY: add BUY LIVE button, Manual Buy confirmation dialog)
- Frontend components for Trading Diagnostics (NEW)
- Frontend components for Settings (MODIFY: add live trading toggle)
- Database schema for live_orders (NO CHANGE)
- Database schema for demo_trades (NO CHANGE)

### 8.2 New Functions
- Manual Buy confirmation dialog component
- Manual Buy execution flow (calls existing place_order)
- Trading Diagnostics page and components
- Dry Run mode toggle and execution
- Auto Trade execution trace logging
- Manual Buy execution trace logging
- Demo Buy execution trace logging

### 8.3 Modified Functions
- place_order: Add Manual Buy entry point, preserve existing Auto Trade logic
- Dashboard: Add BUY LIVE button to signal cards
- AI Signals: Add BUY LIVE button to signal cards, add Manual Buy confirmation dialog
- Settings: Add live trading toggle

### 8.4 Pre-Deploy Checklist
- Lint all code
- Test Demo Buy flow: PASS / FAIL
- Test Manual Buy flow with all pre-flight checks: PASS / FAIL
- Test Manual Buy confirmation dialog: PASS / FAIL
- Test Manual Buy error handling (INSUFFICIENT_BALANCE, DUPLICATE, etc.): PASS / FAIL
- Test Manual Buy success flow (place_order → Pionex → live_orders): PASS / FAIL
- Test Auto Trade flow with diagnostics: PASS / FAIL
- Test Auto Trade gate failures logged correctly: PASS / FAIL
- Test Auto Trade Pionex request failures logged correctly: PASS / FAIL
- Test Dry Run mode for Manual Buy: PASS / FAIL
- Test Dry Run mode for Auto Trade: PASS / FAIL
- Test BUY LIVE button states (enabled/disabled): PASS / FAIL
- Test Trading Diagnostics page displays all traces: PASS / FAIL
- Verify place_order shared logic works for both Manual Buy and Auto Trade: PASS / FAIL
- Verify Pionex connection check: PASS / FAIL
- Verify duplicate protection: PASS / FAIL
- Verify balance validation: PASS / FAIL
- Verify quantity validation: PASS / FAIL
- Verify live_orders persistence: PASS / FAIL
- Verify no changes to AI analysis logic: PASS / FAIL
- Verify no changes to signal scoring logic: PASS / FAIL
- Verify no changes to risk-reward calculation: PASS / FAIL
- Verify no changes to signal thresholds: PASS / FAIL
- Verify no changes to safety gates: PASS / FAIL
- STOP before deploy and report: FILES CHANGED, NEW FUNCTIONS, MODIFIED FUNCTIONS, DEMO BUY FLOW, MANUAL BUY FLOW, AUTO TRADE FLOW, place_order SHARED LOGIC, TRADING DIAGNOSTICS, DRY RUN MODE, DATABASE CHANGES, UI CHANGES, SAFETY GATES, REMAINING BUGS

### 8.5 Verification Requirements
- Must provide complete implementation plan before deployment
- Must demonstrate Demo Buy remains unchanged and functional
- Must demonstrate Manual Buy executes all pre-flight checks correctly
- Must demonstrate Manual Buy shares place_order logic with Auto Trade
- Must demonstrate Auto Trade diagnostics trace complete flow
- Must demonstrate Dry Run mode works for both Manual Buy and Auto Trade
- Must demonstrate BUY LIVE button states work correctly
- Must demonstrate Trading Diagnostics displays all execution traces
- Must confirm no changes to AI analysis, signal scoring, risk-reward, signal thresholds
- Must confirm all existing safety gates remain active
- Must provide final test report: Manual Buy PASS/FAIL, Demo Buy PASS/FAIL, Auto Trade PASS/FAIL, place_order shared PASS/FAIL, Pionex connection PASS/FAIL, duplicate protection PASS/FAIL, balance validation PASS/FAIL, quantity validation PASS/FAIL, live_orders persistence PASS/FAIL, remaining bugs