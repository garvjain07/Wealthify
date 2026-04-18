import React, { useState, useEffect, useRef } from 'react';
import { getAccounts, getCategories, getTransactions, addTransaction, editTransaction, deleteTransaction, exportCSV, importCSV, uploadMedia, login, register, addAccount, editAccount, getAccountDeleteImpact, addCategory, editCategory, getCategoryDeleteImpact, deleteAccount, deleteCategory, getProfile, updateProfile, checkUsernameAvailability, getSubscriptions, addSubscription, editSubscription, deleteSubscription, getAnalytics, getDebts, addDebt, settleDebt, verifyPin, getInvestments, addInvestment, editInvestment, deleteInvestment, getGoals, getGoalUtilizationHistory, addGoal, editGoal, contributeGoal, withdrawGoal, utilizeGoal, deleteGoal, downloadBackup, getReminders, getForecast, runRecurringAutomation, getNotifications, markNotificationRead, markAllNotificationsRead, clearNotifications, bulkDeleteTransactions, bulkTagTransactions, getYearlyComparison, downloadMonthlyPdf, downloadTaxExport, restoreBackup, closeMonthSnapshot, getSnapshots, getSavedFilters, deleteSmartFilter, resetPin, getTransactionQualityIssues, markTransactionQualityIssueIgnored, getOfflineQueueCount, getOfflineQueueItems, syncOfflineTransactionQueue, removeOfflineQueueItem, clearOfflineQueue, retryOfflineQueueItemNow } from './api';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as ChartTooltip, LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { Wallet, User, Landmark, Banknote, ArrowUpCircle, ArrowDownCircle, Plus, LayoutDashboard, ListOrdered, Download, Moon, Sun, Trash2, Edit2, LogOut, Settings, Upload, Repeat, BarChart2, CalendarClock, FileText, Target, CheckCircle2, TrendingUp, Shield, PiggyBank, Hash, Bell, Search, Filter, Command, ArrowLeftRight } from 'lucide-react';
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { format, parseISO, startOfMonth, endOfMonth, isWithinInterval } from 'date-fns';

export function cn(...inputs) { return twMerge(clsx(inputs)) }

const TAB_IDS = ['dashboard', 'transactions', 'subscriptions', 'wealth', 'goals', 'calendar', 'analytics', 'notifications', 'settings'];

function doubleConfirmDelete(entityLabel = 'item') {
  return window.confirm(`Please confirm: delete this ${entityLabel}? This action cannot be undone.`);
}

function TxFormInput({ darkMode, ...props }) {
  return <input {...props} className={cn("w-full rounded-lg border-0 py-2.5 px-3 ring-1", darkMode ? "bg-slate-900 ring-slate-700" : "bg-white ring-slate-300")} />;
}

function TxFormSelect({ darkMode, children, className, ...props }) {
  return <select {...props} className={cn("w-full rounded-lg border-0 py-2.5 px-3 ring-1", darkMode ? "bg-slate-900 ring-slate-700" : "bg-white ring-slate-300", className)}>{children}</select>;
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('darkMode') === 'true');
  const [userProfile, setUserProfile] = useState({});
    const [pinVerified, setPinVerified] = useState(false);

  useEffect(() => {
    if (darkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
    localStorage.setItem('darkMode', darkMode ? 'true' : 'false');
  }, [darkMode]);

  const loadProfile = async () => { try { const res = await getProfile(); setUserProfile(res.data); } catch(e) { handleLogout() } };
  
    useEffect(() => { if (token) loadProfile(); }, [token]);
    useEffect(() => {
        if (!token) setPinVerified(false);
    }, [token]);

    const handleLogout = () => { localStorage.removeItem('token'); setToken(null); setUserProfile({}); setPinVerified(false); };

  if (!token) return <AuthScreen onAuth={(t) => { setToken(t); localStorage.setItem('token', t); }} darkMode={darkMode} />;

    if (userProfile.has_pin && !pinVerified) {
        return <PinLockScreen onVerify={async (pin) => {
        try {
          const res = await verifyPin(pin);
          if (res.data.valid) {
            setPinVerified(true);
            return { ok: true };
          }
          return { ok: false, message: res.data?.attempts_left ? `Wrong PIN. ${res.data.attempts_left} attempts left.` : 'Invalid PIN' };
        } catch (e) {
          return { ok: false, message: e.response?.data?.error || 'PIN validation failed' };
            }
        }} darkMode={darkMode} onLogout={handleLogout} />;
    }

  return <MainApp userProfile={userProfile} onLogout={handleLogout} darkMode={darkMode} setDarkMode={setDarkMode} refreshProfile={loadProfile} />;
}

function MainApp({ userProfile, onLogout, darkMode, setDarkMode, refreshProfile }) {
  const [activeTab, setActiveTab] = useState(() => {
    const savedTab = localStorage.getItem('activeTab');
    return TAB_IDS.includes(savedTab) ? savedTab : 'dashboard';
  });
  const [accounts, setAccounts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [txPage, setTxPage] = useState(1);
  const [txPageSize, setTxPageSize] = useState(50);
  const [txTotal, setTxTotal] = useState(0);
  const [subscriptions, setSubscriptions] = useState([]);
  const [analytics, setAnalytics] = useState([]);
  const [yearlyComparison, setYearlyComparison] = useState([]);
  const [debts, setDebts] = useState([]);
  const [investments, setInvestments] = useState([]);
  const [goals, setGoals] = useState([]);
  const [goalUtilizationItems, setGoalUtilizationItems] = useState([]);
  const [goalUtilizationTotalDeposit, setGoalUtilizationTotalDeposit] = useState(0);
  const [reminders, setReminders] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [savedFilters, setSavedFilters] = useState([]);
  const [snapshots, setSnapshots] = useState([]);
  const [qualityIssueMap, setQualityIssueMap] = useState({});
  const [qualityDetailsMap, setQualityDetailsMap] = useState({});
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [offlineQueueItems, setOfflineQueueItems] = useState([]);
  const [syncingOffline, setSyncingOffline] = useState(false);
  const [forecast, setForecast] = useState({ forecast_income: 0, forecast_expense: 0, forecast_savings: 0, based_on_months: 0 });
  const [dateFilter, setDateFilter] = useState('current');
  const [showAlerts, setShowAlerts] = useState(false);
  const [showAlertsPanel, setShowAlertsPanel] = useState(true);
  const [dismissedAlertKeys, setDismissedAlertKeys] = useState([]);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [lazyCharts, setLazyCharts] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setLazyCharts(true), 300);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => { fetchData(); }, [activeTab, txPage, txPageSize]);

  useEffect(() => {
    localStorage.setItem('activeTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const noti = await getNotifications();
        setNotifications(noti.data || []);
      } catch (_) {}
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const inactivityMs = 10 * 60 * 1000;
    let timeoutId;
    const resetTimer = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        localStorage.removeItem('token');
        window.location.reload();
      }, inactivityMs);
    };
    ['mousemove', 'keydown', 'click', 'touchstart'].forEach(evt => window.addEventListener(evt, resetTimer));
    resetTimer();
    return () => {
      clearTimeout(timeoutId);
      ['mousemove', 'keydown', 'click', 'touchstart'].forEach(evt => window.removeEventListener(evt, resetTimer));
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowQuickAdd(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const updateQueueState = () => {
      setOfflineQueueCount(getOfflineQueueCount());
      setOfflineQueueItems(getOfflineQueueItems());
    };
    updateQueueState();
    window.addEventListener('online', updateQueueState);
    return () => window.removeEventListener('online', updateQueueState);
  }, []);

  useEffect(() => {
    const onOnlineSync = async () => {
      setSyncingOffline(true);
      try {
        await syncOfflineTransactionQueue();
      } finally {
        setSyncingOffline(false);
        setOfflineQueueCount(getOfflineQueueCount());
        setOfflineQueueItems(getOfflineQueueItems());
        fetchData();
      }
    };
    window.addEventListener('online', onOnlineSync);
    return () => window.removeEventListener('online', onOnlineSync);
  }, [activeTab, txPage, txPageSize]);

  const fetchData = async () => {
    try {
      const txParams = activeTab === 'transactions' ? { page: txPage, pageSize: txPageSize } : { page: 1, pageSize: 2000 };
      const [acc, cat, txn, sub, anl, yoy, dbts, invs, gls, goalHist, rem, fcast, noti, filtersRes, snaps, quality] = await Promise.all([getAccounts(), getCategories(), getTransactions(txParams), getSubscriptions(), getAnalytics(), getYearlyComparison(), getDebts(), getInvestments(), getGoals(), getGoalUtilizationHistory(), getReminders(), getForecast(), getNotifications(), getSavedFilters(), getSnapshots(), getTransactionQualityIssues()]);
      const qMap = (quality.data?.items || []).reduce((accm, item) => { accm[item.transaction_id] = item.issues || []; return accm; }, {});
      const qDetailMap = (quality.data?.items || []).reduce((accm, item) => { accm[item.transaction_id] = item; return accm; }, {});
      setAccounts(acc.data); setCategories(cat.data); setTransactions(txn.data.items || []); setTxTotal(txn.data.total || 0); setSubscriptions(sub.data); setAnalytics(anl.data); setYearlyComparison(yoy.data || []); setDebts(dbts.data); setInvestments(invs.data); setGoals(gls.data); setGoalUtilizationItems(goalHist.data?.items || []); setGoalUtilizationTotalDeposit(Number(goalHist.data?.total_utilized || 0)); setReminders(rem.data || []); setForecast(fcast.data || {}); setNotifications(noti.data || []); setSavedFilters(filtersRes.data || []); setSnapshots(snaps.data || []); setQualityIssueMap(qMap); setQualityDetailsMap(qDetailMap); setOfflineQueueCount(getOfflineQueueCount()); setOfflineQueueItems(getOfflineQueueItems());
    } catch (e) { if(e.response?.status===401) onLogout(); }
  };

  const filteredTxns = transactions.filter(t => {
      if (dateFilter === 'all') return true;
      const start = dateFilter === 'current' ? startOfMonth(new Date()) : startOfMonth(new Date(new Date().setMonth(new Date().getMonth()-1)));
      const end = dateFilter === 'current' ? endOfMonth(new Date()) : endOfMonth(new Date(new Date().setMonth(new Date().getMonth()-1)));
      return isWithinInterval(parseISO(t.date), { start, end });
  });

  const totalBal = accounts.reduce((a, c) => a + c.balance, 0);
  const totalInc = filteredTxns.filter(t => t.transaction_type === 'Income').reduce((a, c) => a + c.amount, 0);
  const totalExp = filteredTxns.filter(t => t.transaction_type === 'Expense').reduce((a, c) => a + c.amount, 0);
  
  const curr = userProfile.currency || '$';
  const gBud = userProfile.monthly_budget || 0;
  const gBudPercent = gBud > 0 ? Math.min((totalExp / gBud) * 100, 100) : 0;
  const gBudOver = gBud > 0 && totalExp >= gBud;

  const expData = Object.entries(filteredTxns.filter(t => t.transaction_type === 'Expense').reduce((acc, curr) => {
      acc[curr.category_name] = (acc[curr.category_name] || 0) + curr.amount; return acc;
  }, {})).map(([name, value]) => ({ name, value }));

  const goalContributionSpent = filteredTxns
    .filter((t) => t.transaction_type === 'Expense' && (t.tag === 'GoalContribution' || String(t.description || '').startsWith('Goal Contribution:')))
    .reduce((sum, t) => sum + Number(t.amount || 0), 0);

  const reminderKey = (r) => `${r.type || ''}|${r.level || ''}|${r.message || ''}`;
  const visibleReminders = reminders.filter((r) => !dismissedAlertKeys.includes(reminderKey(r)));

    const incData = Object.entries(filteredTxns.filter(t => t.transaction_type === 'Income').reduce((acc, curr) => {
      acc[curr.category_name] = (acc[curr.category_name] || 0) + curr.amount; return acc;
    }, {})).map(([name, value]) => ({ name, value }));

  const COLORS = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981'];
  const getIcon = (type) => type==='Bank' ? <Landmark className="w-5 h-5 text-blue-500" /> : type==='Wallet' ? <Wallet className="w-5 h-5 text-purple-500" /> : <Banknote className="w-5 h-5 text-emerald-500" />;
  const mobileTopTabs = [
    { id: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { id: 'transactions', icon: ListOrdered, label: 'Transactions' },
    { id: 'subscriptions', icon: Repeat, label: 'Subscriptions' },
    { id: 'wealth', icon: TrendingUp, label: 'Wealth' },
    { id: 'goals', icon: PiggyBank, label: 'Goals' },
    { id: 'calendar', icon: CalendarClock, label: 'Calendar' },
    { id: 'analytics', icon: BarChart2, label: 'Analytics' },
    { id: 'notifications', icon: Bell, label: 'Notifications' },
    { id: 'settings', icon: Settings, label: 'Settings' }
  ];
  const mobileBottomTabs = [
    { id: 'dashboard', icon: LayoutDashboard, label: 'Home' },
    { id: 'transactions', icon: ListOrdered, label: 'Txns' },
    { id: 'wealth', icon: TrendingUp, label: 'Wealth' },
    { id: 'goals', icon: PiggyBank, label: 'Goals' },
    { id: 'calendar', icon: CalendarClock, label: 'Calendar' }
  ];

    const NavBtn = ({ id, icon: Icon, label }) => (
      <button onClick={() => setActiveTab(id)} className={cn("flex items-center gap-2 px-3 py-2 rounded-xl font-medium text-sm transition", activeTab === id ? "bg-emerald-500 text-white" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700")}><Icon className="w-4 h-4" /> {label}</button>
  );

  const MobileNavBtn = ({ id, icon: Icon, label }) => (
    <button
      onClick={() => setActiveTab(id)}
      className={cn(
        "flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition",
        activeTab === id ? "bg-emerald-500 text-white" : "text-slate-500 bg-slate-100 dark:bg-slate-800 dark:text-slate-300"
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
  const unreadCount = notifications.filter(n => !n.is_read).length;

  return (
    <div className={cn("min-h-screen md:h-screen flex", darkMode ? "bg-slate-900 text-slate-100" : "bg-slate-50 text-slate-900")}>
      <aside className={cn("w-64 border-r px-3 py-4 flex-col gap-2 hidden md:flex md:sticky md:top-0 md:h-screen md:overflow-y-hidden", darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200")}>
          <div className="flex items-center gap-2 px-2 mb-2">
           <div className="bg-emerald-500 p-2 rounded-lg"><Wallet className="w-6 h-6 text-white" /></div>
          <h1 className="text-lg font-bold">Wealthify App</h1>
        </div>
          <nav className="flex flex-col gap-1">
          <NavBtn id="dashboard" icon={LayoutDashboard} label="Dashboard" />
          <NavBtn id="transactions" icon={ListOrdered} label="Transactions" />
          <NavBtn id="subscriptions" icon={Repeat} label="Subscriptions" />
          <NavBtn id="wealth" icon={TrendingUp} label="Wealth" />
          <NavBtn id="goals" icon={PiggyBank} label="Goals" />
          <NavBtn id="calendar" icon={CalendarClock} label="Calendar" />
          <NavBtn id="analytics" icon={BarChart2} label="Analytics" />
          <button onClick={() => setActiveTab('notifications')} className={cn("flex items-center justify-between px-3 py-2 rounded-xl font-medium text-sm transition", activeTab === 'notifications' ? "bg-emerald-500 text-white" : "text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700")}><span className="flex items-center gap-2"><Bell className="w-4 h-4" /> Notifications</span>{unreadCount > 0 && <span className={cn("text-xs px-2 py-0.5 rounded-full", activeTab === 'notifications' ? "bg-white text-emerald-600" : "bg-rose-500 text-white")}>{unreadCount}</span>}</button>
          <NavBtn id="settings" icon={Settings} label="Settings" />
        </nav>
        <div className="flex flex-col gap-1 mt-1">
          <button onClick={() => setShowQuickAdd(true)} className="flex items-center gap-2 px-3 py-2 text-indigo-500 hover:bg-indigo-50 dark:hover:bg-slate-700 rounded-xl text-sm"><Command className="w-4 h-4"/> Quick Add (Ctrl+K)</button>
          <button onClick={() => setDarkMode(!darkMode)} className="flex items-center gap-2 px-3 py-2 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-xl text-sm">{darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />} Mode</button>
          <button onClick={onLogout} className="flex items-center gap-2 px-3 py-2 text-rose-500 hover:bg-rose-50 dark:hover:bg-slate-700 rounded-xl text-sm"><LogOut className="w-4 h-4"/> Logout</button>
        </div>
      </aside>

      <main className="flex-1 p-4 pb-24 md:pb-8 md:p-8 overflow-y-auto">
        <div className="md:hidden mb-4 space-y-3">
          <div className={cn("p-3 rounded-2xl border flex items-center justify-between", darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200")}>
            <div className="flex items-center gap-2 min-w-0">
              <div className="bg-emerald-500 p-2 rounded-lg"><Wallet className="w-4 h-4 text-white" /></div>
              <div className="min-w-0">
                <p className="text-xs opacity-70">Welcome</p>
                <p className="text-sm font-bold truncate">Wealthify App</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowQuickAdd(true)} className="p-2 rounded-lg bg-indigo-500 text-white"><Plus className="w-4 h-4" /></button>
              <button onClick={() => setDarkMode(!darkMode)} className={cn("p-2 rounded-lg", darkMode ? "bg-slate-700 text-slate-100" : "bg-slate-100 text-slate-700")}>{darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}</button>
              <button onClick={onLogout} className="p-2 rounded-lg bg-rose-500 text-white"><LogOut className="w-4 h-4" /></button>
            </div>
          </div>

          <div className="overflow-x-auto pb-1 custom-scrollbar">
            <div className="flex gap-2 w-max">
              {mobileTopTabs.map((tab) => (
                <MobileNavBtn key={`mobile-top-${tab.id}`} id={tab.id} icon={tab.icon} label={tab.label} />
              ))}
            </div>
          </div>
        </div>

        {(offlineQueueCount > 0 || syncingOffline) && <div className={cn("mb-4 p-3 rounded-xl text-sm flex items-center justify-between", darkMode ? "bg-amber-900/40 border border-amber-700" : "bg-amber-50 border border-amber-200")}><span>{syncingOffline ? 'Syncing offline transactions...' : `${offlineQueueCount} transaction(s) queued offline`}</span><button onClick={async()=>{ setSyncingOffline(true); try { await syncOfflineTransactionQueue(); } finally { setSyncingOffline(false); setOfflineQueueCount(getOfflineQueueCount()); setOfflineQueueItems(getOfflineQueueItems()); fetchData(); } }} className="px-3 py-1 rounded bg-amber-500 text-white text-xs font-bold">Sync Now</button></div>}
        {activeTab === 'dashboard' && (
           <div className="w-full space-y-5">
             <header className="flex flex-col gap-3 md:flex-row md:justify-between md:items-center">
               <div><h2 className="text-2xl font-bold">Overview</h2><p className="opacity-70">Track your finances</p></div>
               <div className="flex flex-col sm:flex-row gap-2 md:gap-4 w-full md:w-auto">
                 <button onClick={exportCSV} className="flex gap-2 items-center justify-center bg-indigo-50 text-indigo-600 px-4 py-2 font-medium rounded-xl hover:bg-indigo-100 transition"><FileText className="w-4 h-4"/> Export Report (CSV)</button>
                 <select value={dateFilter} onChange={e=>setDateFilter(e.target.value)} className={cn("px-4 py-2 rounded-xl text-sm font-medium border outline-none", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                   <option value="current">This Month</option><option value="last">Last Month</option><option value="all">All Time</option>
                 </select>
               </div>
             </header>

             {gBud > 0 && <div className={cn("p-4 rounded-2xl border shadow-sm space-y-2", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                 <div className="flex justify-between font-semibold text-sm"><span>Global Monthly Budget</span><span className={cn(gBudOver?"text-rose-500":"")}>{curr}{totalExp.toLocaleString()} / {curr}{gBud.toLocaleString()}</span></div>
                 <div className={cn("h-4 w-full rounded-full overflow-hidden", darkMode?"bg-slate-900":"bg-slate-100")}>
                     <div className={cn("h-full transition-all", gBudOver?"bg-rose-500":gBudPercent>80?"bg-amber-500":"bg-emerald-500")} style={{width:`${gBudPercent}%`}}></div>
                 </div>
             </div>}

             {visibleReminders.length > 0 && showAlertsPanel && <div className={cn("p-4 rounded-2xl border shadow-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
               <div className="flex items-center justify-between">
                 <h3 className="font-semibold text-base">Smart Alerts</h3>
                 <button onClick={() => setShowAlerts(!showAlerts)} className={cn("px-3 py-1 rounded-lg text-xs font-semibold", darkMode ? "bg-slate-700 text-slate-100" : "bg-slate-100 text-slate-700")}>{showAlerts ? 'Hide' : `Show (${Math.min(visibleReminders.length, 6)})`}</button>
               </div>
               {showAlerts && <div className="space-y-2 mt-3">
                 {visibleReminders.slice(0, 6).map((r, i) => <div key={`${reminderKey(r)}-${i}`} className={cn("text-sm px-3 py-2 rounded-lg flex items-center justify-between", r.level === 'danger' ? "bg-rose-100 text-rose-700" : r.level === 'warning' ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700")}><span>{r.message}</span><button onClick={() => setDismissedAlertKeys((prev) => [...new Set([...prev, reminderKey(r)])])} aria-label="Dismiss alert" className="ml-3 w-6 h-6 rounded-md bg-white/60 hover:bg-white text-xs font-bold">x</button></div>)}
               </div>}
             </div>}

             {reminders.length > 0 && visibleReminders.length === 0 && <div className="flex justify-end -mt-2 gap-2">
               <button onClick={() => setDismissedAlertKeys([])} className={cn("px-3 py-1 rounded-lg text-xs font-semibold", darkMode ? "bg-slate-700 text-slate-100" : "bg-slate-100 text-slate-700")}>Restore Alerts</button>
             </div>}

             <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {[{l: "Total Balance", v: totalBal, c: ""}, {l: "Income", v: totalInc, c: "text-emerald-500", ic: ArrowUpCircle}, {l: "Expenses", v: totalExp, c: "text-rose-500", ic: ArrowDownCircle}].map((b, i) => (
                    <div key={i} className={cn("p-4 rounded-2xl border shadow-sm flex flex-col gap-1", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                       <div className="flex items-center gap-2 opacity-70 font-medium text-sm">{b.l} {b.ic && <b.ic className={cn("w-4 h-4", b.c)}/>}</div>
                       <div className={cn("text-2xl font-bold", b.c)}>{b.l === 'Expenses' && b.v>0?'-':b.l==='Income'&&b.v>0?'+':''}{curr}{b.v.toLocaleString()}</div>
                    </div>
                ))}
             </div>

             <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                 <div className={cn("p-4 border rounded-2xl shadow-sm h-[420px] flex flex-col", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                    <h3 className="text-base font-semibold mb-2">Expenses Breakdown</h3>
                      {expData.length > 0 ? (
                        <div className="flex-1 min-h-0 w-full">
                           <ResponsiveContainer width="100%" height="100%">
                            <PieChart><Pie data={expData} cx="50%" cy="50%" innerRadius={74} outerRadius={126} paddingAngle={5} dataKey="value">{expData.map((e, idx) => (<Cell key={`cell-${idx}`} fill={COLORS[idx % COLORS.length]} />))}</Pie><ChartTooltip formatter={(v) => `${curr}${v}`} /></PieChart>
                           </ResponsiveContainer>
                        </div>
                    ) : <div className="flex-1 min-h-0 flex items-center justify-center opacity-50 text-sm">No expenses.</div>}
                 </div>

                 <div className={cn("p-4 border rounded-2xl shadow-sm h-[420px] flex flex-col", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                    <h3 className="text-base font-semibold mb-2">Income Breakdown</h3>
                    {incData.length > 0 ? (
                      <div className="flex-1 min-h-0 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={incData} cx="50%" cy="50%" innerRadius={74} outerRadius={126} paddingAngle={5} dataKey="value">
                              {incData.map((e, idx) => (<Cell key={`inc-cell-${idx}`} fill={COLORS[(idx + 3) % COLORS.length]} />))}
                            </Pie>
                            <ChartTooltip formatter={(v) => `${curr}${v}`} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    ) : <div className="flex-1 min-h-0 flex items-center justify-center opacity-50 text-sm">No income.</div>}
                 </div>

                 <div className={cn("p-4 border rounded-2xl shadow-sm h-[420px] flex flex-col", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                    <h3 className="text-base font-semibold">Category Budgets (This Month)</h3>
                <div className="space-y-4 mt-3 overflow-y-auto pr-1">
                  {categories.filter(c => c.type === 'Expense' && c.monthly_budget > 0).map(c => {
                      const spent = expData.find(e => e.name === c.name)?.value || 0;
                      const percent = Math.min((spent / c.monthly_budget) * 100, 100);
                      const isOver = spent >= c.monthly_budget;
                      return (
                        <div key={c.id}>
                           <div className="flex justify-between text-sm mb-1">
                              <span className="font-medium">{c.name}</span>
                              <span className={cn(isOver ? "text-rose-500 font-bold" : "opacity-70")}>{curr}{spent} / {curr}{c.monthly_budget}</span>
                           </div>
                           <div className={cn("h-3 w-full rounded-full overflow-hidden", darkMode ? "bg-slate-900" : "bg-slate-100")}>
                              <div className={cn("h-full transition-all", isOver ? "bg-rose-500" : percent > 80 ? "bg-amber-500" : "bg-emerald-500")} style={{width: `${percent}%`}}></div>
                           </div>
                        </div>
                      )
                  })}

                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-medium">Goals Contribution</span>
                        <span className={cn(goalContributionSpent > 0 ? "text-indigo-500 font-bold" : "opacity-70")}>{curr}{goalContributionSpent.toLocaleString()}</span>
                      </div>
                      <div className={cn("h-3 w-full rounded-full overflow-hidden", darkMode ? "bg-slate-900" : "bg-slate-100")}>
                        <div className="h-full transition-all bg-indigo-500" style={{width: `${goalContributionSpent > 0 ? 100 : 0}%`}}></div>
                      </div>
                    </div>

                  <div className={cn("pt-3 border-t", darkMode ? "border-slate-700" : "border-slate-200")}> 
                    <h4 className="font-semibold text-sm mb-2">Income Targets</h4>
                    <div className="space-y-3">
                      {categories.filter(c => c.type === 'Income' && c.monthly_budget > 0).map(c => {
                        const earned = incData.find(e => e.name === c.name)?.value || 0;
                        const percent = Math.min((earned / c.monthly_budget) * 100, 100);
                        const met = earned >= c.monthly_budget;
                        return (
                          <div key={`inc-${c.id}`}>
                            <div className="flex justify-between text-sm mb-1">
                              <span className="font-medium">{c.name}</span>
                              <span className={cn(met ? "text-emerald-500 font-bold" : "opacity-70")}>{curr}{earned} / {curr}{c.monthly_budget}</span>
                            </div>
                            <div className={cn("h-3 w-full rounded-full overflow-hidden", darkMode ? "bg-slate-900" : "bg-slate-100")}>
                              <div className={cn("h-full transition-all", met ? "bg-emerald-500" : "bg-sky-500")} style={{width: `${percent}%`}}></div>
                            </div>
                          </div>
                        );
                      })}
                      {categories.filter(c => c.type === 'Income' && c.monthly_budget > 0).length === 0 && <p className="text-xs opacity-60">No income targets set.</p>}
                    </div>
                  </div>
                </div>
                 </div>
             </div>
           </div>
        )}

        {activeTab === 'transactions' && <TransactionView transactions={transactions} accounts={accounts} categories={categories} onRefresh={fetchData} darkMode={darkMode} curr={curr} txPage={txPage} setTxPage={setTxPage} txPageSize={txPageSize} setTxPageSize={setTxPageSize} txTotal={txTotal} savedFilters={savedFilters} qualityIssueMap={qualityIssueMap} qualityDetailsMap={qualityDetailsMap} setOfflineQueueCount={setOfflineQueueCount} setOfflineQueueItems={setOfflineQueueItems} />}
        {activeTab === 'subscriptions' && <SubscriptionsView subs={subscriptions} accounts={accounts} categories={categories} onRefresh={fetchData} darkMode={darkMode} curr={curr} />}
        {activeTab === 'wealth' && <WealthView investments={investments} accounts={accounts} curr={curr} onRefresh={fetchData} darkMode={darkMode} />}
        {activeTab === 'goals' && <GoalsView goals={goals} goalUtilizationItems={goalUtilizationItems} goalUtilizationTotalDeposit={goalUtilizationTotalDeposit} accounts={accounts} curr={curr} onRefresh={fetchData} darkMode={darkMode} />}
        {activeTab === 'debts' && <DebtsView debts={debts} onRefresh={fetchData} darkMode={darkMode} curr={curr} />}
        {activeTab === 'calendar' && <CalendarView transactions={transactions} darkMode={darkMode} curr={curr} />}
        {activeTab === 'analytics' && <AnalyticsView analytics={analytics} transactions={transactions} forecast={forecast} yearlyComparison={yearlyComparison} darkMode={darkMode} curr={curr} lazyCharts={lazyCharts} />}
        {activeTab === 'notifications' && <NotificationsView notifications={notifications} darkMode={darkMode} onRefresh={fetchData} />}
        {activeTab === 'settings' && <SettingsView accounts={accounts} categories={categories} onRefresh={fetchData} refreshProfile={refreshProfile} userProfile={userProfile} darkMode={darkMode} snapshots={snapshots} offlineQueueItems={offlineQueueItems} setOfflineQueueItems={setOfflineQueueItems} setOfflineQueueCount={setOfflineQueueCount} />}

        {showQuickAdd && <QuickAddModal accounts={accounts} categories={categories} onClose={() => setShowQuickAdd(false)} onSaved={fetchData} darkMode={darkMode} setOfflineQueueCount={setOfflineQueueCount} />}

        <div className={cn("md:hidden fixed bottom-0 left-0 right-0 z-20 border-t px-2 py-2", darkMode ? "bg-slate-900/95 border-slate-700" : "bg-white/95 border-slate-200") }>
          <div className="grid grid-cols-5 gap-1">
            {mobileBottomTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={`mobile-bottom-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn("flex flex-col items-center justify-center py-1 rounded-lg text-[11px] font-semibold", activeTab === tab.id ? "text-emerald-500" : "text-slate-500")}
                >
                  <Icon className="w-4 h-4 mb-0.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}

function AuthScreen({ onAuth, darkMode }) {
    const [isLogin, setIsLogin] = useState(true); const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState('');
    const handleSubmit = async (e) => {
        e.preventDefault(); setError('');
        try { const res = isLogin ? await login({username, password}) : await register({username, password}); onAuth(res.data.token); }
        catch (err) { setError(err.response?.data?.error || "Error"); }
    }
    return (
        <div className={cn("min-h-screen flex items-center justify-center", darkMode ? "bg-slate-900 text-slate-100" : "bg-slate-50")}>
            <div className={cn("p-8 rounded-2xl border shadow-xl w-full max-w-md", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                <div className="flex justify-center mb-6"><div className="bg-emerald-500 p-3 rounded-xl"><Wallet className="w-8 h-8 text-white" /></div></div>
                <h2 className="text-2xl font-bold text-center mb-8">{isLogin ? 'Login' : 'Sign Up'}</h2>
                {error && <div className="bg-rose-50 text-rose-500 p-3 rounded mb-4 text-center text-sm">{error}</div>}
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <input required placeholder="Username" className={cn("w-full p-3 rounded-lg border outline-none", darkMode ? "bg-slate-900 border-slate-700" : "border-slate-300")} value={username} onChange={e=>setUsername(e.target.value)} />
                    <input type="password" required placeholder="Password" className={cn("w-full p-3 rounded-lg border outline-none", darkMode ? "bg-slate-900 border-slate-700" : "border-slate-300")} value={password} onChange={e=>setPassword(e.target.value)} />
                    <button className="bg-emerald-500 text-white font-bold py-3 rounded-xl">{isLogin ? 'Login' : 'Sign Up'}</button>
                </form>
                <div className="text-center mt-6 text-sm"><button onClick={() => setIsLogin(!isLogin)} className="text-emerald-500 font-bold underline">{isLogin ? 'Needs an account? Register' : 'Have an account? Login'}</button></div>
            </div>
        </div>
    );
}

function TransactionView({ transactions, accounts, categories, onRefresh, darkMode, curr, txPage, setTxPage, txPageSize, setTxPageSize, txTotal, savedFilters, qualityIssueMap, qualityDetailsMap, setOfflineQueueCount, setOfflineQueueItems }) {
  const [isOpen, setIsOpen] = useState(false); const [uploading, setUploading] = useState(false); const [editingId, setEditingId] = useState(null);
  const txFormRef = useRef(null);
  const [formData, setFormData] = useState({ type: 'Expense', amount: '', account_id: '', to_account_id: '', category_id: '', date: new Date().toISOString().split('T')[0], description: '', receipt_url: '', tag: '', payment_mode: '', payment_app: '' });
  const [tagFilter, setTagFilter] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [quickFilter, setQuickFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkTag, setBulkTag] = useState('');
  const [splitMode, setSplitMode] = useState(false);
  const [splitItems, setSplitItems] = useState([{ category_id: '', amount: 0, tag: '' }, { category_id: '', amount: 0, tag: '' }]);
  const [expandedSplitRows, setExpandedSplitRows] = useState({});

  const selectedSourceAccount = accounts.find((a) => Number(a.id) === Number(formData.account_id));
  const selectedSourceType = String(selectedSourceAccount?.type || '').toLowerCase();
  const showPaymentFields = selectedSourceType === 'bank' || selectedSourceType === 'wallet';
  const normalizedTxType = String(formData.type || '').toLowerCase();
  const paymentModeOptions = selectedSourceType === 'bank'
    ? (normalizedTxType === 'transfer'
      ? ['UPI', 'UPI LITE', 'RTGS', 'IMPS', 'NEFT', 'Check', 'Net Banking']
      : normalizedTxType === 'income'
        ? ['Cash Deposit', 'Check', 'UPI', 'IMPS', 'NEFT', 'RTGS', 'Net Banking']
        : ['Cash Withdraw', 'Check', 'UPI', 'IMPS', 'NEFT', 'RTGS', 'Debit Card', 'Credit Card', 'Net Banking'])
    : selectedSourceType === 'wallet'
      ? (normalizedTxType === 'transfer'
        ? ['UPI', 'UPI LITE', 'Wallet Transfer']
        : normalizedTxType === 'income'
          ? ['UPI', 'UPI LITE', 'Wallet Transfer']
          : ['UPI', 'UPI LITE', 'Wallet Transfer', 'Card', 'Other'])
      : [];
  const isUpiMode = ['UPI', 'UPI LITE'].includes(String(formData.payment_mode || ''));
  const upiAppSuggestions = ['BHIM', 'PhonePe', 'GPay', 'Paytm'];
  const upiAppSelectValue = upiAppSuggestions.includes(String(formData.payment_app || ''))
    ? formData.payment_app
    : '';

  useEffect(() => {
    if (!showPaymentFields) {
      setFormData((prev) => ({ ...prev, payment_mode: '', payment_app: '' }));
      return;
    }
    if (formData.payment_mode && !paymentModeOptions.includes(formData.payment_mode)) {
      setFormData((prev) => ({ ...prev, payment_mode: '', payment_app: '' }));
    }
  }, [showPaymentFields, selectedSourceType]);

  useEffect(() => {
    if (!isUpiMode && formData.payment_app) {
      setFormData((prev) => ({ ...prev, payment_app: '' }));
    }
  }, [isUpiMode, formData.payment_app]);

  useEffect(() => {
    if (isOpen && editingId && txFormRef.current) {
      txFormRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [isOpen, editingId]);

  const isProtectedTxn = (tx) => {
      const tag = String(tx?.tag || '').trim().toLowerCase();
      const desc = String(tx?.description || '').trim();
      return ['goalcontribution', 'goalwithdraw', 'goalutilizedeposit', 'openingbalance', '#auto-recurring', 'auto-recurring', 'autorecurring'].includes(tag)
        || desc === 'Opening Balance'
        || desc.startsWith('[AUTO:');
  };

  const handleTxFile = async (e) => {
      const file = e.target.files[0]; if(!file) return; setUploading(true);
      try { const r = await uploadMedia(file); setFormData({...formData, receipt_url: r.data.url}); } catch(e){ alert("Upload failed"); } setUploading(false);
  }
  const handleCsvImport = async (e) => {
      const file = e.target.files[0]; if(!file) return;
      try { await importCSV(file); alert("Imported!"); onRefresh(); } catch(e){ alert("CSV Import failed"); }
  }
  
  const handleEdit = (tx) => {
      setEditingId(tx.id);
      setFormData({ type: tx.transaction_type, amount: tx.amount, account_id: tx.account_id || '', to_account_id: tx.to_account_id || '', category_id: tx.category_id || '', date: tx.date || new Date().toISOString().split('T')[0], description: tx.description || '', receipt_url: tx.receipt_url || '', tag: tx.tag || '', payment_mode: tx.payment_mode || '', payment_app: tx.payment_app || '' });
      if (tx.splits && tx.splits.length > 0) {
        setSplitMode(true);
        setSplitItems(tx.splits.map(s => ({ category_id: s.category_id || '', amount: s.amount, tag: s.tag || '' })));
      } else {
        setSplitMode(false);
        setSplitItems([{ category_id: '', amount: 0, tag: '' }, { category_id: '', amount: 0, tag: '' }]);
      }
      setIsOpen(true);
  };

  const submit = async (e) => { 
      e.preventDefault(); 
      if (formData.type === 'Transfer' && Number(formData.account_id) === Number(formData.to_account_id)) {
        alert('Source and destination account cannot be the same for transfer.');
        return;
      }
      const payload = splitMode && formData.type !== 'Transfer'
        ? { ...formData, split_items: splitItems.filter(s => Number(s.amount) > 0).map(s => ({ ...s, amount: Number(s.amount) })), amount: splitItems.reduce((sum, s) => sum + Number(s.amount || 0), 0) }
        : formData;
      const result = editingId ? await editTransaction(editingId, payload) : await addTransaction(payload);
      if (editingId) setEditingId(null);
      if (result?.data?.queued) {
        alert('No internet. Transaction saved in offline queue.');
        setOfflineQueueCount(getOfflineQueueCount());
        setOfflineQueueItems(getOfflineQueueItems());
      }
      setIsOpen(false); 
      setFormData({ type: 'Expense', amount: '', account_id: '', to_account_id: '', category_id: '', date: new Date().toISOString().split('T')[0], description: '', receipt_url: '', tag: '', payment_mode: '', payment_app: '' });
      setSplitMode(false);
      setSplitItems([{ category_id: '', amount: 0, tag: '' }, { category_id: '', amount: 0, tag: '' }]);
      onRefresh(); 
  };
  const filteredList = transactions.filter(t => {
      const hay = `${t.description || ''} ${t.category_name || ''} ${t.account_name || ''} ${t.tag || ''} ${t.payment_mode || ''} ${t.payment_app || ''}`.toLowerCase();
      const matchesText = !searchFilter || hay.includes(searchFilter.toLowerCase());
      const tagNeedle = tagFilter.toLowerCase();
      const matchesTag = !tagFilter
        || (t.tag || '').toLowerCase().includes(tagNeedle)
        || (t.payment_mode || '').toLowerCase().includes(tagNeedle)
        || (t.payment_app || '').toLowerCase().includes(tagNeedle)
        || (t.splits || []).some(s => (s.tag || '').toLowerCase().includes(tagNeedle));
      const dt = new Date(t.date);
      const now = new Date();
      const weekStart = new Date(now); weekStart.setDate(now.getDate() - 7);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const matchesQuick = quickFilter === 'all'
        || (quickFilter === 'income' && t.transaction_type === 'Income')
        || (quickFilter === 'expense' && t.transaction_type === 'Expense')
        || (quickFilter === 'transfer' && t.transaction_type === 'Transfer')
        || (quickFilter === 'thisWeek' && dt >= weekStart)
        || (quickFilter === 'thisMonth' && dt >= monthStart)
        || (quickFilter === 'highSpend' && t.transaction_type === 'Expense' && Number(t.amount) >= 1000)
        || (quickFilter === 'suspicious' && (qualityIssueMap[t.id] || []).length > 0);
      return matchesText && matchesTag && matchesQuick;
  });

      const buildEditPayloadFromRow = (t, forceDate) => {
        if (t.transaction_type === 'Transfer') {
          return {
            type: 'Transfer',
            amount: t.amount,
            account_id: t.account_id,
            to_account_id: t.to_account_id,
            category_id: null,
            date: forceDate || t.date,
            description: t.description || '',
            receipt_url: t.receipt_url || null,
            tag: t.tag || '',
            payment_mode: t.payment_mode || '',
            payment_app: t.payment_app || ''
          };
        }
        if (t.splits && t.splits.length > 0) {
          return {
            type: t.transaction_type,
            amount: t.amount,
            account_id: t.account_id,
            category_id: null,
            date: forceDate || t.date,
            description: t.description || '',
            receipt_url: t.receipt_url || null,
            tag: t.tag || '',
            payment_mode: t.payment_mode || '',
            payment_app: t.payment_app || '',
            split_items: t.splits.map(s => ({ category_id: s.category_id || null, amount: Number(s.amount || 0), tag: s.tag || '' }))
          };
        }
        return {
          type: t.transaction_type,
          amount: t.amount,
          account_id: t.account_id,
          category_id: t.category_id,
          date: forceDate || t.date,
          description: t.description || '',
          receipt_url: t.receipt_url || null,
          tag: t.tag || '',
          payment_mode: t.payment_mode || '',
          payment_app: t.payment_app || ''
        };
      };

      const handleFixDate = async (t) => {
        const payload = buildEditPayloadFromRow(t, new Date().toISOString().split('T')[0]);
        const r = await editTransaction(t.id, payload);
        if (r?.data?.queued) {
          setOfflineQueueCount(getOfflineQueueCount());
          setOfflineQueueItems(getOfflineQueueItems());
        }
        onRefresh();
      };

      const handleFixDuplicate = async (t) => {
        if (!doubleConfirmDelete('transaction')) return;
        const r = await deleteTransaction(t.id);
        if (r?.data?.queued) {
          setOfflineQueueCount(getOfflineQueueCount());
          setOfflineQueueItems(getOfflineQueueItems());
        }
        onRefresh();
      };

      const mapIssueLabelToCode = (issueLabel) => {
        const label = String(issueLabel || '').toLowerCase();
        if (label.includes('duplicate')) return 'possible_duplicate';
        if (label.includes('suspicious transaction date')) return 'suspicious_date';
        if (label.includes('high expense amount')) return 'high_expense_amount';
        if (label.includes('high income amount')) return 'high_income_amount';
        return null;
      };

      const handleMarkIssuesAsCorrect = async (t) => {
        const issues = qualityDetailsMap[t.id]?.issues || [];
        const issueCodes = [...new Set(issues.map(mapIssueLabelToCode).filter(Boolean))];
        if (!issueCodes.length) return;
        for (const code of issueCodes) {
          await markTransactionQualityIssueIgnored(t.id, code);
        }
        onRefresh();
      };

  const toolbarBtnBase = "h-9 px-3 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 whitespace-nowrap";
  const toolbarFieldClass = cn("h-9 px-3 rounded-xl border text-sm outline-none", darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-300");
  const toolbarGroupClass = cn("h-9 flex items-center gap-2 px-3 rounded-xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-slate-100 border-slate-200");

  return (
    <div className="w-full space-y-6">
       <div className={cn("p-4 rounded-2xl border shadow-sm space-y-3", darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200")}>
         <header className="flex items-center justify-between gap-3">
           <h2 className="text-2xl font-bold">Transactions</h2>
         </header>

         <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
           <div className={`${toolbarGroupClass} lg:col-span-5`}>
             <Search className="w-4 h-4 opacity-60" />
             <input value={searchFilter} onChange={e=>setSearchFilter(e.target.value)} placeholder="Search txns" className={cn("bg-transparent outline-none text-sm flex-1", darkMode ? "placeholder:text-slate-400" : "placeholder:text-slate-500")} />
           </div>
           <div className={`${toolbarGroupClass} lg:col-span-3`}>
             <Filter className="w-4 h-4 opacity-60" />
             <select value={quickFilter} onChange={e=>setQuickFilter(e.target.value)} className={cn("bg-transparent outline-none text-sm flex-1", darkMode ? "text-slate-200" : "text-slate-700")}>
               <option value="all">All</option>
               <option value="income">Income</option>
               <option value="expense">Expense</option>
               <option value="transfer">Transfer</option>
               <option value="thisWeek">This Week</option>
               <option value="thisMonth">This Month</option>
               <option value="highSpend">High Spend</option>
               <option value="suspicious">Suspicious</option>
             </select>
           </div>
           <div className={`${toolbarGroupClass} lg:col-span-4`}>
             <Hash className="w-4 h-4 opacity-60" />
             <input value={tagFilter} onChange={e=>setTagFilter(e.target.value)} placeholder="Filter #tag" className={cn("bg-transparent outline-none text-sm flex-1", darkMode ? "placeholder:text-slate-400" : "placeholder:text-slate-500")} />
           </div>
         </div>

         {savedFilters.length > 0 && <div className="flex flex-wrap gap-2">
             {savedFilters.map(f => (
               <div key={f.id} className={cn("h-9 px-2 rounded-xl flex items-center gap-2 border", darkMode ? "bg-slate-700 border-slate-600" : "bg-slate-100 border-slate-200")}>
                 <button onClick={()=>{ setSearchFilter(f.filter?.searchFilter || ''); setTagFilter(f.filter?.tagFilter || ''); setQuickFilter(f.filter?.quickFilter || 'all'); }} className="text-xs font-medium px-2">{f.name}</button>
                 <button onClick={async()=>{ if (!doubleConfirmDelete('saved filter')) return; await deleteSmartFilter(f.id); onRefresh(); }} className="text-xs text-rose-500 px-1">x</button>
               </div>
             ))}
         </div>}
       </div>

       <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
         <div className="flex items-center gap-2 flex-wrap">
           <span className="text-sm opacity-70">Bulk:</span>
           <input value={bulkTag} onChange={e=>setBulkTag(e.target.value)} placeholder="Tag selected" className={`${toolbarFieldClass} w-full sm:w-56`} />
           <button onClick={async()=>{ if (!selectedIds.length) return; await bulkTagTransactions(selectedIds, bulkTag); setSelectedIds([]); setBulkTag(''); onRefresh(); }} className={`${toolbarBtnBase} bg-indigo-500 text-white`}>Apply Tag</button>
           <button onClick={async()=>{ if (!selectedIds.length) return; if (!doubleConfirmDelete('selected transactions')) return; await bulkDeleteTransactions(selectedIds); setSelectedIds([]); onRefresh(); }} className={`${toolbarBtnBase} bg-rose-500 text-white`}>Delete Selected</button>
           <span className="text-xs opacity-60">{selectedIds.length} selected</span>
         </div>
         <div className="flex items-center gap-2 flex-wrap lg:justify-end">
           <button onClick={exportCSV} className={`${toolbarBtnBase} ${darkMode ? 'bg-slate-700 text-slate-100' : 'bg-slate-200 text-slate-800'}`}><Download className="w-4 h-4"/> CSV Export</button>
           <label className={`${toolbarBtnBase} bg-indigo-500 hover:bg-indigo-600 text-white cursor-pointer`}><Upload className="w-4 h-4"/> CSV Import<input type="file" accept=".csv" className="hidden" onChange={handleCsvImport}/></label>
           <button onClick={() => setIsOpen(!isOpen)} className={`${toolbarBtnBase} bg-emerald-500 text-white`}><Plus className="w-5 h-5"/> New</button>
         </div>
       </div>

       {isOpen && (
         <div ref={txFormRef} className={cn("p-4 md:p-6 rounded-2xl border shadow-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
            <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div><label className="block text-sm mb-2">Type</label><TxFormSelect darkMode={darkMode} value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}><option>Expense</option><option>Income</option><option>Transfer</option></TxFormSelect></div>
                <div><label className="block text-sm mb-2">Amount</label><TxFormInput darkMode={darkMode} type="number" step="0.01" required value={splitMode && formData.type !== 'Transfer' ? splitItems.reduce((sum, s) => sum + Number(s.amount || 0), 0) : formData.amount} onChange={e => setFormData({...formData, amount: parseFloat(e.target.value)})} disabled={splitMode && formData.type !== 'Transfer'} /></div>
                <div><label className="block text-sm mb-2">{formData.type === 'Transfer' ? 'From' : 'Account'}</label><TxFormSelect darkMode={darkMode} required value={formData.account_id} onChange={e => setFormData({...formData, account_id: parseInt(e.target.value)})}><option value="">Select...</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</TxFormSelect></div>
                {formData.type === 'Transfer' ? 
                  <div><label className="block text-sm mb-2">To</label><TxFormSelect darkMode={darkMode} required value={formData.to_account_id} onChange={e => setFormData({...formData, to_account_id: parseInt(e.target.value)})}><option value="">Select...</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</TxFormSelect></div> :
                  <div><label className="block text-sm mb-2">Category</label><TxFormSelect darkMode={darkMode} required value={formData.category_id} onChange={e => setFormData({...formData, category_id: parseInt(e.target.value)})}><option value="">Select...</option>{categories.filter(c=>c.type===formData.type).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</TxFormSelect></div>}
                <div><label className="block text-sm mb-2">Date</label><TxFormInput darkMode={darkMode} type="date" required value={formData.date} onChange={e => setFormData({...formData, date: e.target.value})} /></div>
                <div><label className="block text-sm mb-2">Description</label><TxFormInput darkMode={darkMode} value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} /></div>
                <div><label className="block text-sm mb-2">Tag (optional)</label><TxFormInput darkMode={darkMode} placeholder="#GoaTrip2026" value={formData.tag || ''} onChange={e => setFormData({...formData, tag: e.target.value})} /></div>
                {formData.type !== 'Transfer' && (
                  <div className="flex items-center gap-3 mt-7">
                    <input type="checkbox" checked={splitMode} onChange={(e)=>setSplitMode(e.target.checked)} />
                    <span className="text-sm font-medium">Enable Split Transaction</span>
                  </div>
                )}
                {splitMode && formData.type !== 'Transfer' && (
                  <div className="md:col-span-2 space-y-3 p-4 rounded-xl border border-dashed border-slate-400/40">
                    {splitItems.map((item, idx) => (
                      <div key={idx} className="grid grid-cols-1 md:grid-cols-4 gap-3">
                        <TxFormSelect darkMode={darkMode} value={item.category_id} onChange={e=>setSplitItems(splitItems.map((s,i)=>i===idx?{...s, category_id: Number(e.target.value)}:s))}><option value="">Category...</option>{categories.filter(c=>c.type===formData.type).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</TxFormSelect>
                        <TxFormInput darkMode={darkMode} type="number" step="0.01" value={item.amount} onChange={e=>setSplitItems(splitItems.map((s,i)=>i===idx?{...s, amount: Number(e.target.value)}:s))} />
                        <TxFormInput darkMode={darkMode} placeholder="#tag" value={item.tag || ''} onChange={e=>setSplitItems(splitItems.map((s,i)=>i===idx?{...s, tag: e.target.value}:s))} />
                        <button type="button" onClick={()=>setSplitItems(splitItems.filter((_,i)=>i!==idx))} className="text-rose-500 text-sm">Remove</button>
                      </div>
                    ))}
                    <button type="button" onClick={()=>setSplitItems([...splitItems, { category_id: '', amount: 0, tag: '' }])} className="text-indigo-500 text-sm font-medium">+ Add Split Row</button>
                  </div>
                )}
                 <div className="md:col-span-2"><label className="block text-sm mb-2">Receipt (Image)</label><input type="file" onChange={handleTxFile} /> {uploading && 'Uploading...'} {formData.receipt_url && <a href={formData.receipt_url} className="text-emerald-500">View</a>}</div>
                <div className="md:col-span-2 min-h-[64px]">
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
                    <div className="md:col-span-4 md:max-w-[280px]">
                      <label className={cn("block text-sm mb-2", !showPaymentFields && "invisible")}>Mode (optional)</label>
                      <TxFormSelect darkMode={darkMode} aria-label="Mode (optional)" value={showPaymentFields ? (formData.payment_mode || '') : ''} onChange={e => setFormData({ ...formData, payment_mode: e.target.value })} disabled={!showPaymentFields} className={!showPaymentFields ? 'invisible pointer-events-none' : ''}>
                        <option value="">Select...</option>
                        {paymentModeOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                      </TxFormSelect>
                    </div>
                    <div className="md:col-span-4 md:max-w-[280px]">
                      <label className={cn("block text-sm mb-2", !isUpiMode && "invisible")}>App/Instrument Name (optional)</label>
                      <TxFormSelect darkMode={darkMode} aria-label="App/Instrument Name (optional)" value={isUpiMode ? upiAppSelectValue : ''} onChange={e => {
                        setFormData({ ...formData, payment_app: e.target.value });
                      }} disabled={!isUpiMode} className={!isUpiMode ? 'invisible pointer-events-none' : ''}>
                        <option value="">Select...</option>
                        {upiAppSuggestions.map((name) => <option key={name} value={name}>{name}</option>)}
                      </TxFormSelect>
                    </div>
                    <div className="md:col-span-4 flex flex-col items-stretch md:items-end">
                      <label className="block text-sm mb-2 invisible">Save</label>
                      <button type="submit" disabled={uploading} className="bg-emerald-600 text-white px-6 h-[42px] rounded-xl w-full md:w-auto">Save</button>
                    </div>
                  </div>
                </div>
            </form>
         </div>
       )}

           <div className={cn("border text-sm rounded-2xl shadow-sm overflow-hidden", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
             <div className="overflow-x-auto">
             <table className="w-full min-w-[900px] text-left"><thead className={cn("border-b opacity-70", darkMode ? "bg-slate-900 border-slate-700":"bg-slate-50")}><tr><th className="p-4"><input type="checkbox" onChange={(e)=>setSelectedIds(e.target.checked ? filteredList.map(x=>x.id) : [])} checked={filteredList.length > 0 && selectedIds.length === filteredList.length} /></th><th className="p-4">Date</th><th className="p-4">Details</th><th className="p-4">Category</th><th className="p-4">Account</th><th className="p-4 text-right">Amount</th><th className="p-4"></th></tr></thead>
            <tbody>
              {filteredList.map(t => (
                  
                  <tr key={t.id} className={cn("border-b border-slate-100 dark:border-slate-800", (qualityIssueMap[t.id] || []).length ? (darkMode ? "bg-amber-900/10" : "bg-amber-50/60") : "")}>
                    <td className="p-4"><input type="checkbox" checked={selectedIds.includes(t.id)} onChange={(e)=>setSelectedIds(prev => e.target.checked ? [...new Set([...prev, t.id])] : prev.filter(id => id !== t.id))} /></td>
                    <td className="p-4 opacity-70">{t.date}</td><td className="p-4">{t.description} {(t.tag || '').trim() && <span className="ml-2 text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-700">{t.tag}</span>} {t.payment_mode && <span className="ml-2 text-xs px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">{t.payment_mode}</span>} {t.payment_app && <span className="ml-2 text-xs px-2 py-0.5 rounded bg-sky-100 text-sky-700">{t.payment_app}</span>} {t.receipt_url && <a href={t.receipt_url} className="text-indigo-500 text-xs ml-2">(Img)</a>} {(qualityIssueMap[t.id] || []).length > 0 && <div className="mt-1 text-xs text-amber-600 font-medium">{qualityIssueMap[t.id].join(' • ')}</div>}</td>
                    <td className="p-4">{t.transaction_type==='Transfer'?'Transfer':(t.splits && t.splits.length ? `Split (${t.splits.length})` : t.category_name)}
                      {t.splits && t.splits.length > 0 && <div className="mt-1"><button onClick={() => setExpandedSplitRows(prev => ({ ...prev, [t.id]: !prev[t.id] }))} className="text-xs text-indigo-500 font-medium">{expandedSplitRows[t.id] ? 'Hide split details' : 'Show split details'}</button>{expandedSplitRows[t.id] && <div className="text-xs opacity-70 mt-1 space-y-1">{t.splits.map((s, i) => <div key={i}>{s.category_name || 'Uncategorized'}: {curr}{s.amount} {s.tag ? `(${s.tag})` : ''}</div>)}</div>}</div>}
                    </td>
                    <td className="p-4">
                      {t.transaction_type === 'Transfer'
                        ? <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-300"><ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />From {t.account_name || 'Unknown'} -&gt; To {t.to_account_name || 'Unknown'}</span>
                        : t.transaction_type === 'Income'
                          ? `To ${t.account_name || 'Unknown'}`
                          : `From ${t.account_name || 'Unknown'}`}
                    </td>
                    <td className={cn("p-4 text-right font-bold", t.transaction_type==='Income'?"text-emerald-500":t.transaction_type==='Transfer'?"text-blue-500":"text-rose-500")}>{t.transaction_type==='Transfer' ? <span className="inline-flex items-center gap-1"><ArrowLeftRight className="w-3.5 h-3.5 shrink-0" />{curr}{Math.abs(t.amount)}</span> : <span>{t.transaction_type==='Income'?'+':'-'}{curr}{Math.abs(t.amount)}</span>}</td>
                    <td className="p-4 text-right">
                      {(() => {
                        const isGoalTxn = isProtectedTxn(t);
                        return (
                      <div className="flex justify-end gap-3">
                        <button disabled={isGoalTxn} title={isGoalTxn ? 'System-generated transaction cannot be edited' : 'Edit transaction'} onClick={() => !isGoalTxn && handleEdit(t)} className={cn("h-8 w-8 rounded-lg inline-flex items-center justify-center", isGoalTxn ? "opacity-40 cursor-not-allowed bg-slate-200 text-slate-400" : (darkMode ? "bg-slate-700 text-indigo-300" : "bg-indigo-50 text-indigo-500"))}><Edit2 className="w-4 h-4"/></button>
                        <button disabled={isGoalTxn} title={isGoalTxn ? 'System-generated transaction cannot be deleted' : 'Delete transaction'} onClick={async ()=>{ if (isGoalTxn) return; if (!doubleConfirmDelete('transaction')) return; const result = await deleteTransaction(t.id); if (result?.data?.queued) { alert('Delete queued in offline mode.'); setOfflineQueueCount(getOfflineQueueCount()); setOfflineQueueItems(getOfflineQueueItems()); } onRefresh()}} className={cn("h-8 w-8 rounded-lg inline-flex items-center justify-center", isGoalTxn ? "opacity-40 cursor-not-allowed bg-slate-200 text-slate-400" : (darkMode ? "bg-slate-700 text-rose-300" : "bg-rose-50 text-rose-500"))}><Trash2 className="w-4 h-4"/></button>
                      </div>
                        );
                      })()}
                      {(qualityDetailsMap[t.id]?.issues || []).length > 0 && !isProtectedTxn(t) && <div className="mt-2 flex gap-2 justify-end">
                        {qualityDetailsMap[t.id].issues.includes('Suspicious transaction date') && <button onClick={() => handleFixDate(t)} className="text-[10px] px-2 py-1 rounded bg-amber-500 text-white">Fix Date</button>}
                        <button onClick={() => handleMarkIssuesAsCorrect(t)} className="text-[10px] px-2 py-1 rounded bg-emerald-600 text-white">Mark as Correct</button>
                        <button onClick={() => handleFixDuplicate(t)} className="text-[10px] px-2 py-1 rounded bg-rose-500 text-white">Delete</button>
                      </div>}
                    </td>
                  </tr>
              ))}
            </tbody>
          </table>
          </div>
       </div>
       <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between pt-2 gap-2">
         <div className="text-sm opacity-70">Total: {txTotal}</div>
         <div className="flex items-center gap-2 flex-wrap sm:justify-end">
           <button disabled={txPage <= 1} onClick={()=>setTxPage(Math.max(1, txPage - 1))} className={cn("h-9 px-3 rounded-lg border text-sm font-medium disabled:opacity-40", darkMode ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white")}>Prev</button>
           <span className="text-sm">Page {txPage}</span>
           <button disabled={txPage * txPageSize >= txTotal} onClick={()=>setTxPage(txPage + 1)} className={cn("h-9 px-3 rounded-lg border text-sm font-medium disabled:opacity-40", darkMode ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white")}>Next</button>
           <select value={txPageSize} onChange={e=>{ setTxPageSize(Number(e.target.value)); setTxPage(1); }} className={cn("h-9 px-2 rounded-lg border text-sm", darkMode ? "border-slate-700 bg-slate-800" : "border-slate-300 bg-white")}>
             <option value={25}>25</option><option value={50}>50</option><option value={100}>100</option>
           </select>
         </div>
       </div>
    </div>
  );
}

function AnalyticsView({ analytics, transactions, forecast, yearlyComparison, darkMode, curr, lazyCharts }) {
    const [trendView, setTrendView] = useState('monthly');

    const pad2 = (n) => String(n).padStart(2, '0');
    const formatYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const getWeekStart = (d) => {
      const tmp = new Date(d);
      const day = (tmp.getDay() + 6) % 7;
      tmp.setDate(tmp.getDate() - day);
      tmp.setHours(0, 0, 0, 0);
      return tmp;
    };

    const txItems = Array.isArray(transactions) ? transactions : [];
    const chartDataFromTx = txItems.length ? (() => {
      const buckets = new Map();
      txItems.forEach((t) => {
        if (t.transaction_type === 'Transfer') return;
        const dt = new Date(t.date);
        if (Number.isNaN(dt.getTime())) return;

        const amount = Math.abs(Number(t.amount || 0));
        if (!Number.isFinite(amount)) return;

        let key = '';
        let sortKey = '';
        if (trendView === 'daily') {
          key = formatYmd(dt);
          sortKey = key;
        } else if (trendView === 'weekly') {
          const weekStart = getWeekStart(dt);
          const year = weekStart.getFullYear();
          const jan1 = new Date(year, 0, 1);
          const jan1Day = (jan1.getDay() + 6) % 7;
          const firstWeekStart = new Date(year, 0, 1 - jan1Day);
          firstWeekStart.setHours(0, 0, 0, 0);
          const weekNo = Math.floor((weekStart - firstWeekStart) / (7 * 24 * 60 * 60 * 1000)) + 1;
          key = `${year}-W${pad2(weekNo)}`;
          sortKey = `${year}-${pad2(weekNo)}`;
        } else if (trendView === 'yearly') {
          key = String(dt.getFullYear());
          sortKey = key;
        } else {
          key = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
          sortKey = key;
        }

        if (!buckets.has(key)) {
          buckets.set(key, { period: key, income: 0, expense: 0, sortKey });
        }
        const bucket = buckets.get(key);
        if (t.transaction_type === 'Income') bucket.income += amount;
        if (t.transaction_type === 'Expense') bucket.expense += amount;
      });

      return Array.from(buckets.values())
        .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
        .map(({ sortKey, ...rest }) => rest);
    })() : [];

    const chartDataFallback = (analytics || []).map((a) => ({
      period: String(a.month || a.period || a.label || ''),
      income: Number(a.income || 0),
      expense: Number(a.expense || 0),
    }));

    const chartData = chartDataFromTx.length ? chartDataFromTx : chartDataFallback;
    if (!chartData.length) return <div className="p-8 text-center">No Data available. Add transactions to see trends.</div>;

    return (
    <div className="w-full space-y-6">
            <h2 className="text-2xl font-bold">Trends</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className={cn("p-4 rounded-xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}><p className="text-xs opacity-70">Forecast Income</p><p className="text-xl font-bold text-emerald-500">{curr}{Number(forecast?.forecast_income || 0).toLocaleString()}</p></div>
        <div className={cn("p-4 rounded-xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}><p className="text-xs opacity-70">Forecast Expense</p><p className="text-xl font-bold text-rose-500">{curr}{Number(forecast?.forecast_expense || 0).toLocaleString()}</p></div>
        <div className={cn("p-4 rounded-xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}><p className="text-xs opacity-70">Projected Savings</p><p className={cn("text-xl font-bold", Number(forecast?.forecast_savings || 0) >= 0 ? "text-emerald-500" : "text-rose-500")}>{curr}{Number(forecast?.forecast_savings || 0).toLocaleString()}</p><p className="text-xs opacity-60 mt-1">Based on last {forecast?.based_on_months || 0} month(s)</p></div>
      </div>
      <div className={cn("p-4 rounded-xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
        <h3 className="font-bold mb-2">Yearly Comparison (YoY)</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          {yearlyComparison.map(y => <div key={y.year} className={cn("p-3 rounded", darkMode ? "bg-slate-900" : "bg-slate-100")}><p className="font-bold">{y.year}</p><p>Income: {curr}{Number(y.income || 0).toLocaleString()}</p><p>Expense: {curr}{Number(y.expense || 0).toLocaleString()}</p><p>Savings: {curr}{Number(y.savings || 0).toLocaleString()}</p></div>)}
        </div>
      </div>
            <div className={cn("p-6 border rounded-2xl shadow-sm h-[400px]", darkMode ? "bg-slate-800 border-slate-700":"bg-white")}>
              <div className="mb-4 flex items-center justify-end">
                <select
                  value={trendView}
                  onChange={(e) => setTrendView(e.target.value)}
                  className={cn("h-9 px-3 rounded-lg border text-sm", darkMode ? "border-slate-700 bg-slate-900" : "border-slate-300 bg-white")}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <div className="h-[calc(100%-52px)]">
              {!lazyCharts && <div className="h-full flex items-center justify-center opacity-60">Loading chart...</div>}
              {lazyCharts && <ResponsiveContainer width="100%" height="100%">
                   <LineChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                       <CartesianGrid strokeDasharray="3 3" stroke={darkMode?"#334155":"#e2e8f0"}/>
                       <XAxis dataKey="period" stroke={darkMode?"#94a3b8":"#64748b"}/>
                       <YAxis stroke={darkMode?"#94a3b8":"#64748b"}/>
                       <ChartTooltip formatter={(value) => `${curr}${value}`} wrapperClassName={darkMode?"dark:bg-slate-800 border-slate-700":""}/>
                       <Line type="monotone" dataKey="income" stroke="#10b981" strokeWidth={3} />
                       <Line type="monotone" dataKey="expense" stroke="#f43f5e" strokeWidth={3} />
                   </LineChart>
               </ResponsiveContainer>}
              </div>
            </div>
        </div>
    )
}

function SubscriptionsView({ subs, categories, accounts, onRefresh, darkMode, curr }) {
  const emptySubForm = { name: '', amount: '', type: 'Expense', frequency: 'Monthly', account_id: '', category_id: '', next_date: new Date().toISOString().split('T')[0] };
   const [formData, setFormData] = useState({ name: '', amount: '', type: 'Expense', frequency: 'Monthly', account_id: '', category_id: '', next_date: new Date().toISOString().split('T')[0] });
  const [editingSubId, setEditingSubId] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (editingSubId) {
      await editSubscription(editingSubId, formData);
    } else {
      await addSubscription(formData);
    }
    setEditingSubId(null);
    setFormData(emptySubForm);
    onRefresh();
  };

  const startEdit = (sub) => {
    setEditingSubId(sub.id);
    setFormData({
      name: sub.name || '',
      amount: sub.amount ?? '',
      type: sub.type || 'Expense',
      frequency: sub.frequency || 'Monthly',
      account_id: sub.account_id ? String(sub.account_id) : '',
      category_id: sub.category_id ? String(sub.category_id) : '',
      next_date: sub.next_date || new Date().toISOString().split('T')[0]
    });
  };

  const cancelEdit = () => {
    setEditingSubId(null);
    setFormData(emptySubForm);
  };
   const inputClass = cn("p-2 border rounded outline-none flex-1", darkMode ? "bg-slate-900 border-slate-700":"bg-white border-slate-300");
   
   return (
       <div className="w-full space-y-6">
           <h2 className="text-2xl font-bold">Recurring Subscriptions</h2>
           <button onClick={async ()=>{ const r = await runRecurringAutomation(); alert(`Processed: ${r.data.processed}`); onRefresh(); }} className="bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-bold">Run Recurring Now</button>
            <form onSubmit={submit} className={cn("p-4 md:p-6 border rounded-2xl flex flex-col gap-4 shadow-sm", darkMode ? "bg-slate-800 border-slate-700":"bg-white")}>
              <div className="flex flex-col md:flex-row gap-4">
                  <input required className={inputClass} placeholder="Name (e.g. Netflix)" value={formData.name} onChange={e=>setFormData({...formData, name:e.target.value})} />
                  <input required type="number" step="0.01" className={inputClass} placeholder="Amount $" value={formData.amount} onChange={e=>setFormData({...formData, amount:parseFloat(e.target.value)})} />
                  <select className={inputClass} value={formData.type} onChange={e=>setFormData({...formData, type:e.target.value})}><option>Expense</option><option>Income</option></select>
                  <select className={inputClass} value={formData.frequency} onChange={e=>setFormData({...formData, frequency:e.target.value})}><option>Monthly</option><option>Yearly</option><option>Weekly</option></select>
               </div>
              <div className="flex flex-col md:flex-row gap-4">
                  <select required className={inputClass} value={formData.account_id} onChange={e=>setFormData({...formData, account_id:e.target.value})}><option value="">Account...</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>
                  <select required className={inputClass} value={formData.category_id} onChange={e=>setFormData({...formData, category_id:e.target.value})}><option value="">Category...</option>{categories.filter(c=>c.type===formData.type).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  <input required type="date" className={inputClass} value={formData.next_date} onChange={e=>setFormData({...formData, next_date:e.target.value})} />
               </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                 <button className="bg-indigo-500 text-white py-2 rounded font-bold flex-1">{editingSubId ? 'Update Subscription' : 'Add Subscription'}</button>
                 {editingSubId && <button type="button" onClick={cancelEdit} className="bg-slate-300 text-slate-800 py-2 px-4 rounded font-bold">Cancel</button>}
               </div>
           </form>
           
           <div className={cn("border rounded-2xl shadow-sm", darkMode ? "bg-slate-800 border-slate-700":"bg-white")}>
              {subs.map(s => (
                <div key={s.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border-b border-slate-100 dark:border-slate-700">
                      <div><div className="font-bold">{s.name} <span className="opacity-50 text-xs">({s.frequency})</span></div><div className="text-xs opacity-70">Next: {s.next_date} | {s.account_name} | {s.category_name}</div></div>
                    <div className="flex items-center gap-4 self-end sm:self-auto"><div className={cn("font-bold", s.type==='Income'?"text-emerald-500":"text-rose-500")}>{curr}{s.amount}</div><button onClick={()=>startEdit(s)}><Edit2 className="w-4 h-4 text-indigo-500"/></button><button onClick={async ()=>{ if (!doubleConfirmDelete('subscription')) return; await deleteSubscription(s.id);onRefresh();}}><Trash2 className="w-4 h-4 text-rose-500"/></button></div>
                  </div>
              ))}
           </div>
       </div>
   )
}

function WealthView({ investments, accounts, curr, onRefresh, darkMode }) {
  const [form, setForm] = useState({ id: null, name: '', type: 'Stock', current_value: '', cost_basis: '', date: new Date().toISOString().split('T')[0], notes: '' });
  const totalAssets = accounts.reduce((s, a) => s + Number(a.balance || 0), 0) + investments.reduce((s, i) => s + Number(i.current_value || 0), 0);
  const totalInvested = investments.reduce((s, i) => s + Number(i.cost_basis || 0), 0);

  const startEdit = (i) => {
    setForm({ id: i.id, name: i.name, type: i.type, current_value: i.current_value, cost_basis: i.cost_basis, date: i.date || new Date().toISOString().split('T')[0], notes: i.notes || '' });
  };

  const handleSub = async (e) => {
    e.preventDefault();
    if(form.id) {
      await editInvestment(form.id, form);
    } else {
      await addInvestment(form);
    }
    setForm({ id: null, name: '', type: 'Stock', current_value: '', cost_basis: '', date: new Date().toISOString().split('T')[0], notes: '' });
    onRefresh();
  };

  return (
    <div className="w-full space-y-6">
      <h2 className="text-2xl font-bold">Investments & Net Worth</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className={cn("p-5 rounded-2xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}><p className="opacity-70 text-sm">Net Worth</p><p className="text-2xl font-bold">{curr}{totalAssets.toLocaleString()}</p></div>
        <div className={cn("p-5 rounded-2xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}><p className="opacity-70 text-sm">Invested</p><p className="text-2xl font-bold">{curr}{totalInvested.toLocaleString()}</p></div>
        <div className={cn("p-5 rounded-2xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}><p className="opacity-70 text-sm">Unrealized P/L</p><p className={cn("text-2xl font-bold", (investments.reduce((s, i) => s + Number(i.current_value || 0), 0) - totalInvested) >= 0 ? "text-emerald-500" : "text-rose-500")}>{curr}{(investments.reduce((s, i) => s + Number(i.current_value || 0), 0) - totalInvested).toLocaleString()}</p></div>
      </div>

      <form onSubmit={handleSub} className={cn("p-6 rounded-2xl border grid grid-cols-1 md:grid-cols-6 gap-3 align-middle", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
        <input required placeholder="Asset Name" value={form.name} onChange={e=>setForm({...form, name:e.target.value})} className={cn("p-2 rounded border", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
        <select value={form.type} onChange={e=>setForm({...form, type:e.target.value})} className={cn("p-2 rounded border", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")}><option>Stock</option><option>Mutual Fund</option><option>Fixed Deposit</option><option>Gold</option><option>Crypto</option><option>Other</option></select>
        <input required type="number" step="0.01" placeholder="Invested Amount" value={form.cost_basis} onChange={e=>setForm({...form, cost_basis:e.target.value})} className={cn("p-2 rounded border", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
        <input required type="number" step="0.01" placeholder="Current Value" value={form.current_value} onChange={e=>setForm({...form, current_value:e.target.value})} className={cn("p-2 rounded border", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
        <input required type="date" value={form.date} onChange={e=>setForm({...form, date:e.target.value})} className={cn("p-2 rounded border", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
        <div className="flex gap-2">
            <button type="submit" className="bg-indigo-500 text-white rounded p-2 font-bold min-w-max flex-1">{form.id ? "Update" : "Add Asset"}</button>
            {form.id && <button type="button" onClick={() => setForm({ id: null, name: '', type: 'Stock', current_value: '', cost_basis: '', date: new Date().toISOString().split('T')[0], notes: '' })} className="bg-slate-500 text-white rounded p-2 font-bold min-w-max">Cancel</button>}
        </div>
      </form>

      <div className={cn("rounded-2xl border overflow-hidden", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
        {investments.map(i => <div key={i.id} className="p-4 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center"><div><p className="font-bold">{i.name} <span className="text-xs opacity-60">({i.type})</span></p><p className="text-xs opacity-70">{i.date && <span>{new Date(i.date).toLocaleDateString()} | </span>}Invested: {curr}{Number(i.cost_basis).toLocaleString()} | Current: {curr}{Number(i.current_value).toLocaleString()}</p></div><div className="flex items-center gap-2"><button onClick={()=>startEdit(i)} className="text-indigo-500"><Edit2 className="w-4 h-4"/></button><button onClick={async()=>{ if (!doubleConfirmDelete('investment')) return; await deleteInvestment(i.id); onRefresh();}} className="text-rose-500"><Trash2 className="w-4 h-4"/></button></div></div>)}
        {investments.length === 0 && <p className="p-6 opacity-60 text-center">No investments added.</p>}
      </div>
    </div>
  );
}

function GoalsView({ goals, goalUtilizationItems, goalUtilizationTotalDeposit, accounts, curr, onRefresh, darkMode }) {
  const [form, setForm] = useState({ id: null, title: '', target_amount: 0, due_date: '' });
  const [contrib, setContrib] = useState({});
  const [contribAccount, setContribAccount] = useState({});
  const [utilizeOpen, setUtilizeOpen] = useState({});
  const [utilizeType, setUtilizeType] = useState({});
  const [utilizeAssetType, setUtilizeAssetType] = useState({});
  const [utilizeAssetName, setUtilizeAssetName] = useState({});
  const [utilizeItemName, setUtilizeItemName] = useState({});
  const [goalNotice, setGoalNotice] = useState(null);

  const startEditGoal = (g) => {
    setForm({ id: g.id, title: g.title || '', target_amount: Number(g.target_amount || 0), due_date: g.due_date || '' });
  };

  const resetForm = () => {
    setForm({ id: null, title: '', target_amount: 0, due_date: '' });
  };

  const showGoalNotice = (message, type = 'success') => {
    setGoalNotice({ message, type });
    window.setTimeout(() => setGoalNotice(null), 2500);
  };

  return (
    <div className="w-full space-y-6">
      <h2 className="text-2xl font-bold">Saving Goals / Wishlist</h2>
      {goalNotice && (
        <div className={cn("fixed top-4 left-4 right-4 md:left-auto md:right-4 md:w-auto z-60 px-4 py-2 rounded-lg text-sm font-medium shadow-lg", goalNotice.type === 'error' ? "bg-rose-500 text-white" : "bg-emerald-500 text-white")}>
          {goalNotice.message}
        </div>
      )}
      <form onSubmit={async (e)=>{ e.preventDefault(); if (Number(form.target_amount || 0) <= 0) { showGoalNotice('Target amount must be greater than zero', 'error'); return; } try { if (form.id) { await editGoal(form.id, form); showGoalNotice('Goal updated'); } else { await addGoal(form); showGoalNotice('Goal added'); } resetForm(); onRefresh(); } catch (error) { showGoalNotice(error?.response?.data?.error || 'Unable to save goal', 'error'); } }} className={cn("p-6 rounded-2xl border grid grid-cols-1 md:grid-cols-5 gap-3", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
        <input required placeholder="Goal title" value={form.title} onChange={e=>setForm({...form, title:e.target.value})} className={cn("p-2 rounded border", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
        <input required type="number" step="0.01" min="0.01" placeholder="Target amount" value={form.target_amount} onChange={e=>setForm({...form, target_amount:Number(e.target.value)})} className={cn("p-2 rounded border", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
        <input type="date" value={form.due_date} onChange={e=>setForm({...form, due_date:e.target.value})} className={cn("p-2 rounded border", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
        <button className="bg-emerald-500 text-white rounded p-2 font-bold w-full">{form.id ? 'Update Goal' : 'Add Goal'}</button>
        {form.id ? <button type="button" onClick={resetForm} className="bg-slate-500 text-white rounded p-2 font-bold w-full">Cancel</button> : <div className="hidden md:block" />}
      </form>

      <div className="space-y-4">
        {goals.map(g => {
          const pct = Math.min((Number(g.saved_amount || 0) / Number(g.target_amount || 1)) * 100, 100);
          const contributionAmount = Number(contrib[g.id] || 0);
          const selectedAccountId = Number(contribAccount[g.id] || 0);
          const canContribute = contributionAmount > 0 && selectedAccountId > 0;
          const canWithdraw = contributionAmount > 0 && selectedAccountId > 0;
          const selectedUtilizeType = utilizeType[g.id] || '';
          const selectedAssetType = utilizeAssetType[g.id] || '';
          const selectedAssetName = (utilizeAssetName[g.id] || '').trim();
          const selectedItemName = (utilizeItemName[g.id] || '').trim();
          const canUtilize = g.status === 'Completed'
            && !!selectedUtilizeType
            && (
              (selectedUtilizeType === 'convert_assets' && !!selectedAssetType && !!selectedAssetName)
              || (selectedUtilizeType === 'buy_things' && !!selectedItemName)
            );
          return <div key={g.id} className={cn("p-4 rounded-2xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 mb-2"><h3 className="font-bold">{g.title}</h3><span className={cn("text-xs px-2 py-1 rounded w-fit", g.status === 'Completed' ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>{g.status}</span></div>
            <p className="text-sm opacity-70 mb-2">{curr}{Number(g.saved_amount).toLocaleString()} / {curr}{Number(g.target_amount).toLocaleString()} {g.due_date ? `| Due: ${g.due_date}` : ''}</p>
            <div className={cn("h-3 rounded-full overflow-hidden mb-3", darkMode ? "bg-slate-900" : "bg-slate-100")}><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }}></div></div>
            <div className="flex items-center gap-2 w-full flex-wrap">
              <input type="number" step="0.01" placeholder="Add savings" value={contrib[g.id] || ''} onChange={e=>setContrib({...contrib, [g.id]: e.target.value})} className={cn("h-9 px-3 rounded border w-full sm:w-48 text-sm", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
              <select value={contribAccount[g.id] || ''} onChange={e=>setContribAccount({...contribAccount, [g.id]: e.target.value})} className={cn("h-9 px-3 rounded border text-sm w-full sm:w-auto sm:min-w-56", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")}>
                <option value="">Select account</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({curr}{Number(a.balance || 0).toLocaleString()})</option>)}
              </select>
              <button
                onClick={async()=>{
                  if (!canContribute) return;
                  try {
                    await contributeGoal(g.id, contributionAmount, selectedAccountId);
                    setContrib({...contrib, [g.id]: ''});
                    setContribAccount({...contribAccount, [g.id]: ''});
                    showGoalNotice('Contribution added');
                    onRefresh();
                  } catch (error) {
                    showGoalNotice(error?.response?.data?.error || 'Contribution failed', 'error');
                  }
                }}
                disabled={!canContribute}
                className={cn("h-9 text-sm rounded px-3", canContribute ? "bg-indigo-500 text-white" : "bg-slate-300 text-slate-500 cursor-not-allowed")}
              >
                Contribute
              </button>
              <button
                onClick={async()=>{
                  if (!canWithdraw) return;
                  try {
                    await withdrawGoal(g.id, contributionAmount, selectedAccountId);
                    setContrib({...contrib, [g.id]: ''});
                    setContribAccount({...contribAccount, [g.id]: ''});
                    showGoalNotice('Withdrawal added');
                    onRefresh();
                  } catch (error) {
                    showGoalNotice(error?.response?.data?.error || 'Withdrawal failed', 'error');
                  }
                }}
                disabled={!canWithdraw}
                className={cn("h-9 text-sm rounded px-3", canWithdraw ? "bg-amber-500 text-white" : "bg-slate-300 text-slate-500 cursor-not-allowed")}
              >
                Withdraw
              </button>
              {g.status === 'Completed' && (
                <button
                  type="button"
                  onClick={() => setUtilizeOpen({ ...utilizeOpen, [g.id]: !utilizeOpen[g.id] })}
                  className={cn("h-9 text-sm rounded px-3", darkMode ? "bg-sky-600 text-white" : "bg-sky-500 text-white")}
                >
                  Utilize
                </button>
              )}
              <div className="flex items-center gap-3 sm:ml-auto">
                <button onClick={()=>startEditGoal(g)} className="text-sm text-indigo-500">Edit</button>
                <button onClick={async()=>{ if (!doubleConfirmDelete('goal')) return; await deleteGoal(g.id); onRefresh();}} className="text-sm text-rose-500">Delete</button>
              </div>
            </div>
            {g.status === 'Completed' && utilizeOpen[g.id] && (
              <div className={cn("mt-3 p-3 rounded-lg border flex flex-col md:flex-row md:items-center gap-2", darkMode ? "border-slate-700 bg-slate-900/40" : "border-slate-200 bg-slate-50")}>
                <select value={selectedUtilizeType} onChange={e=>setUtilizeType({ ...utilizeType, [g.id]: e.target.value })} className={cn("h-9 px-3 rounded border text-sm w-full md:w-auto md:min-w-52", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")}>
                  <option value="">Utilize as...</option>
                  <option value="convert_assets">Convert into assets</option>
                  <option value="buy_things">Buy things</option>
                </select>
                {selectedUtilizeType === 'convert_assets' && (
                  <>
                    <select value={selectedAssetType} onChange={e=>setUtilizeAssetType({ ...utilizeAssetType, [g.id]: e.target.value })} className={cn("h-9 px-3 rounded border text-sm w-full md:w-auto md:min-w-48", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")}>
                      <option value="">Select asset type</option>
                      <option value="Gold">Gold</option>
                      <option value="Stock">Stock</option>
                      <option value="Mutual Fund">Mutual Fund</option>
                      <option value="Fixed Deposit">Fixed Deposit</option>
                      <option value="Crypto">Crypto</option>
                      <option value="Other">Other</option>
                    </select>
                    <input value={utilizeAssetName[g.id] || ''} onChange={e=>setUtilizeAssetName({ ...utilizeAssetName, [g.id]: e.target.value })} placeholder="Asset name" className={cn("h-9 px-3 rounded border text-sm w-full md:w-auto md:min-w-52", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
                  </>
                )}
                {selectedUtilizeType === 'buy_things' && (
                  <input value={utilizeItemName[g.id] || ''} onChange={e=>setUtilizeItemName({ ...utilizeItemName, [g.id]: e.target.value })} placeholder="Item name" className={cn("h-9 px-3 rounded border text-sm w-full md:w-auto md:min-w-52", darkMode?"bg-slate-900 border-slate-700":"bg-white border-slate-300")} />
                )}
                <button
                  type="button"
                  disabled={!canUtilize}
                  onClick={async () => {
                    if (!canUtilize) return;
                    try {
                      await utilizeGoal(g.id, {
                        utilize_mode: selectedUtilizeType,
                        asset_type: selectedUtilizeType === 'convert_assets' ? selectedAssetType : null,
                        asset_name: selectedUtilizeType === 'convert_assets' ? selectedAssetName : null,
                        item_name: selectedUtilizeType === 'buy_things' ? selectedItemName : null
                      });
                      const label = selectedUtilizeType === 'convert_assets' ? 'convert into assets' : 'buy things';
                      setContrib({ ...contrib, [g.id]: '' });
                      setContribAccount({ ...contribAccount, [g.id]: '' });
                      setUtilizeType({ ...utilizeType, [g.id]: '' });
                      setUtilizeAssetType({ ...utilizeAssetType, [g.id]: '' });
                      setUtilizeAssetName({ ...utilizeAssetName, [g.id]: '' });
                      setUtilizeItemName({ ...utilizeItemName, [g.id]: '' });
                      setUtilizeOpen({ ...utilizeOpen, [g.id]: false });
                      showGoalNotice(`Utilized for ${label}`);
                      onRefresh();
                    } catch (error) {
                      showGoalNotice(error?.response?.data?.error || 'Utilize action failed', 'error');
                    }
                  }}
                  className={cn("h-9 text-sm rounded px-3 w-full md:w-auto", canUtilize ? "bg-emerald-500 text-white" : "bg-slate-300 text-slate-500 cursor-not-allowed")}
                >
                  Apply Utilize
                </button>
                <p className="text-xs opacity-70">Utilize uses full saved goal amount automatically.</p>
              </div>
            )}
          </div>
        })}
        {goals.length === 0 && <p className="opacity-60 text-center py-8">No goals created.</p>}
      </div>

      <div className={cn("p-4 rounded-2xl border", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-3">
          <h3 className="text-lg font-semibold">Utilization History</h3>
          <p className="text-sm font-medium">Total Utilized: {curr}{Number(goalUtilizationTotalDeposit || 0).toLocaleString()}</p>
        </div>
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {goalUtilizationItems.map(h => (
            <div key={h.id} className={cn("p-3 rounded-lg border text-sm", darkMode ? "border-slate-700 bg-slate-900/40" : "border-slate-200 bg-slate-50")}>
              <div className="flex justify-between gap-3">
                <div>
                  <p className="font-medium">{h.goal_title}</p>
                  <p className="opacity-70">
                    {h.utilize_mode === 'convert_assets' && `Converted into asset: ${h.asset_name || '-'}${h.asset_type ? ` (${h.asset_type})` : ''}`}
                    {h.utilize_mode === 'buy_things' && `Bought item: ${h.item_name || '-'}`}
                    {h.utilize_mode === 'add_amount' && `Deposited to account: ${h.resolved_account_name || h.account_name || '-'}`}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">{curr}{Number(h.amount || 0).toLocaleString()}</p>
                  <p className="text-xs opacity-60">{h.created_at ? new Date(h.created_at).toLocaleString() : ''}</p>
                </div>
              </div>
            </div>
          ))}
          {goalUtilizationItems.length === 0 && <p className="text-sm opacity-60 text-center py-4">No utilization history yet.</p>}
        </div>
      </div>
    </div>
  );
}

function PinLockScreen({ onVerify, darkMode, onLogout }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  return (
    <div className={cn("min-h-screen flex items-center justify-center", darkMode ? "bg-slate-900 text-slate-100" : "bg-slate-50")}>
      <div className={cn("p-8 rounded-2xl border shadow-xl w-full max-w-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
        <div className="flex justify-center mb-4"><div className="bg-indigo-500 p-3 rounded-xl"><Shield className="w-7 h-7 text-white" /></div></div>
        <h2 className="text-xl font-bold text-center mb-4">App Lock</h2>
        <p className="text-sm opacity-70 text-center mb-4">Enter your 4-digit PIN to continue</p>
        {error && <div className="bg-rose-50 text-rose-500 p-2 rounded mb-3 text-sm text-center">{error}</div>}
        <input type="password" maxLength={4} value={pin} onChange={e=>setPin(e.target.value)} className={cn("w-full p-3 rounded-lg border outline-none text-center text-xl tracking-widest", darkMode ? "bg-slate-900 border-slate-700" : "border-slate-300")} />
        <button onClick={async ()=>{ const result = await onVerify(pin); if (!result?.ok) setError(result?.message || 'Invalid PIN'); }} className="mt-4 w-full bg-emerald-500 text-white py-2 rounded-lg font-bold">Unlock</button>
        <button onClick={onLogout} className="mt-2 w-full text-rose-500 text-sm">Logout</button>
      </div>
    </div>
  );
}

function QuickAddModal({ accounts, categories, onClose, onSaved, darkMode, setOfflineQueueCount }) {
  const [form, setForm] = useState({ type: 'Expense', amount: '', account_id: '', category_id: '', date: new Date().toISOString().split('T')[0], description: '' });
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className={cn("w-full max-w-2xl rounded-2xl border p-5", darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200")}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold">Quick Add Transaction</h3>
          <button onClick={onClose} className="text-sm opacity-70">Close</button>
        </div>
        <form onSubmit={async (e)=>{ e.preventDefault(); const r = await addTransaction(form); if (r?.data?.queued) { alert('Saved in offline queue.'); setOfflineQueueCount(getOfflineQueueCount()); } await onSaved(); onClose(); }} className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <select value={form.type} onChange={e=>setForm({...form, type: e.target.value})} className={cn("p-2 rounded border", darkMode ? "bg-slate-900 border-slate-700" : "bg-white border-slate-300")}><option>Expense</option><option>Income</option></select>
          <input required type="number" step="0.01" placeholder="Amount" value={form.amount} onChange={e=>setForm({...form, amount: Number(e.target.value)})} className={cn("p-2 rounded border", darkMode ? "bg-slate-900 border-slate-700" : "bg-white border-slate-300")} />
          <select required value={form.account_id} onChange={e=>setForm({...form, account_id: Number(e.target.value)})} className={cn("p-2 rounded border", darkMode ? "bg-slate-900 border-slate-700" : "bg-white border-slate-300")}><option value="">Account...</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          <select required value={form.category_id} onChange={e=>setForm({...form, category_id: Number(e.target.value)})} className={cn("p-2 rounded border", darkMode ? "bg-slate-900 border-slate-700" : "bg-white border-slate-300")}><option value="">Category...</option>{categories.filter(c => c.type === form.type).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input required type="date" value={form.date} onChange={e=>setForm({...form, date: e.target.value})} className={cn("p-2 rounded border", darkMode ? "bg-slate-900 border-slate-700" : "bg-white border-slate-300")} />
          <input placeholder="Description" value={form.description} onChange={e=>setForm({...form, description: e.target.value})} className={cn("p-2 rounded border", darkMode ? "bg-slate-900 border-slate-700" : "bg-white border-slate-300")} />
          <button className="md:col-span-2 bg-emerald-500 text-white py-2 rounded-lg font-bold">Save</button>
        </form>
      </div>
    </div>
  );
}

function NotificationsView({ notifications, darkMode, onRefresh }) {
  const unread = notifications.filter(n => !n.is_read).length;
  return (
    <div className="w-full space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold">Notification Center</h2>
          <p className="text-sm opacity-70">Unread: {unread}</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={async()=>{ await markAllNotificationsRead(); onRefresh(); }} className="px-3 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium">Mark All Read</button>
          <button onClick={async()=>{ if (!doubleConfirmDelete('notifications')) return; await clearNotifications(); onRefresh(); }} className="px-3 py-2 rounded-lg bg-rose-500 text-white text-sm font-medium">Clear All</button>
        </div>
      </div>

      <div className={cn("rounded-2xl border overflow-hidden", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
        {notifications.map(n => (
          <div key={n.id} className={cn("p-4 border-b flex justify-between items-start gap-3", darkMode ? "border-slate-700" : "border-slate-100", !n.is_read && (darkMode ? "bg-slate-700/30" : "bg-indigo-50/40"))}>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className={cn("text-xs px-2 py-0.5 rounded-full", n.level === 'danger' ? "bg-rose-100 text-rose-700" : n.level === 'warning' ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700")}>{n.level}</span>
                <span className="text-xs opacity-60">{new Date(n.created_at).toLocaleString()}</span>
              </div>
              <p className="text-sm">{n.message}</p>
            </div>
            {!n.is_read && <button onClick={async()=>{ await markNotificationRead(n.id); onRefresh(); }} className="text-xs text-indigo-500 font-medium">Mark Read</button>}
          </div>
        ))}
        {notifications.length === 0 && <p className="p-6 text-center opacity-60">No notifications yet.</p>}
      </div>
    </div>
  );
}

function SettingsView({ accounts, categories, userProfile, refreshProfile, onRefresh, darkMode, snapshots, offlineQueueItems, setOfflineQueueItems, setOfflineQueueCount }) {
  const [profileData, setProfileData] = useState({ username: userProfile.username || '', avatar_url: userProfile.avatar_url || '', currency: userProfile.currency || '₹', monthly_budget: userProfile.monthly_budget || 0 });
  const [usernameStatus, setUsernameStatus] = useState({ checking: false, available: true, message: '' });
  const [pinReset, setPinReset] = useState({ username: userProfile.username || '', recovery_answer: '', new_pin: '' });

  const [accName, setAccName] = useState(''); const [accType, setAccType] = useState('Bank'); const [accBal, setAccBal] = useState('');
  const [catName, setCatName] = useState(''); const [catType, setCatType] = useState('Expense'); const [catBud, setCatBud] = useState('');
  const [editingAccId, setEditingAccId] = useState(null);
  const [editingCatId, setEditingCatId] = useState(null);
  const [categoryImpactMap, setCategoryImpactMap] = useState({});
  const [categoryImpactLoadingMap, setCategoryImpactLoadingMap] = useState({});
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const avatarInputRef = useRef(null);

  const currencyOptions = [
    { label: 'INR (₹)', value: '₹' },
    { label: 'USD ($)', value: '$' },
    { label: 'EUR (€)', value: '€' },
    { label: 'GBP (£)', value: '£' },
    { label: 'JPY (¥)', value: '¥' },
    { label: 'AED (د.إ)', value: 'د.إ' }
  ];

  useEffect(() => {
      setProfileData(prev => ({ ...prev, username: userProfile.username || '', avatar_url: userProfile.avatar_url || '', currency: userProfile.currency || '₹', monthly_budget: userProfile.monthly_budget || 0 }));
      setUsernameStatus({ checking: false, available: true, message: '' });
      setPinReset(prev => ({ ...prev, username: userProfile.username || '' }));
  }, [userProfile]);

  useEffect(() => {
    const nextUsername = String(profileData.username || '').trim();
    const currentUsername = String(userProfile.username || '').trim();

    if (!nextUsername) {
      setUsernameStatus({ checking: false, available: false, message: 'Username is required.' });
      return;
    }

    if (nextUsername.toLowerCase() === currentUsername.toLowerCase()) {
      setUsernameStatus({ checking: false, available: true, message: '' });
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setUsernameStatus({ checking: true, available: false, message: 'Checking username...' });
      try {
        const res = await checkUsernameAvailability(nextUsername);
        if (cancelled) return;
        setUsernameStatus({
          checking: false,
          available: !!res.data?.available,
          message: res.data?.available ? 'Username available.' : 'Username already exists.'
        });
      } catch (_) {
        if (cancelled) return;
        setUsernameStatus({ checking: false, available: false, message: 'Could not verify username right now.' });
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [profileData.username, userProfile.username]);

  const handleProfSubmit = async (e) => {
    e.preventDefault();
    if (usernameStatus.checking) {
      alert('Please wait. Username availability is being checked.');
      return;
    }
    if (!usernameStatus.available) {
      alert(usernameStatus.message || 'Please choose a different username.');
      return;
    }
    try {
      await updateProfile(profileData);
      alert('Updated');
      refreshProfile();
    } catch (e) {
      alert(e?.response?.data?.error || 'Profile update failed');
    }
  };
  const uploadAva = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const r = await uploadMedia(f);
      const nextAvatarUrl = r?.data?.url || '';
      if (!nextAvatarUrl) throw new Error('Upload failed');
      setProfileData((prev) => ({ ...prev, avatar_url: nextAvatarUrl }));
      await updateProfile({
        username: String(userProfile.username || profileData.username || '').trim(),
        avatar_url: nextAvatarUrl,
        currency: userProfile.currency || profileData.currency || '₹',
        monthly_budget: Number(userProfile.monthly_budget || profileData.monthly_budget || 0)
      });
      await refreshProfile();
      alert('Profile picture updated.');
    } catch (err) {
      alert(err?.response?.data?.error || 'Profile picture upload failed.');
    } finally {
      e.target.value = '';
    }
  };

  const removeAvatar = async () => {
    try {
      await updateProfile({
        username: String(userProfile.username || profileData.username || '').trim(),
        avatar_url: '',
        currency: userProfile.currency || profileData.currency || '₹',
        monthly_budget: Number(userProfile.monthly_budget || profileData.monthly_budget || 0)
      });
      setProfileData((prev) => ({ ...prev, avatar_url: '' }));
      setAvatarMenuOpen(false);
      await refreshProfile();
      alert('Profile picture removed.');
    } catch (err) {
      alert(err?.response?.data?.error || 'Could not remove profile picture.');
    }
  };
  
  const resetAccForm = () => { setEditingAccId(null); setAccName(''); setAccType('Bank'); setAccBal(''); };
  const resetCatForm = () => { setEditingCatId(null); setCatName(''); setCatType('Expense'); setCatBud(''); };

  const handleAddAcc = async (e) => {
    e.preventDefault();
    if (editingAccId) {
      await editAccount(editingAccId, { name: accName, type: accType });
    } else {
      const payload = { name: accName, type: accType, balance: Number(accBal || 0) };
      await addAccount(payload);
    }
    onRefresh();
    resetAccForm();
  }
  const handleAddCat = async (e) => {
    e.preventDefault();
    const payload = { name: catName, type: catType, monthly_budget: Number(catBud || 0) };
    if (editingCatId) await editCategory(editingCatId, payload);
    else await addCategory(payload);
    onRefresh();
    resetCatForm();
  }

  const startEditAcc = (a) => {
    setEditingAccId(a.id);
    setAccName(a.name || '');
    setAccType(a.type || 'Bank');
    setAccBal(String(Number(a.balance || 0)));
  };

  const handleDeleteAcc = async (a) => {
    try {
      const impactRes = await getAccountDeleteImpact(a.id);
      const txCount = Number(impactRes.data?.related_transaction_count || 0);
      const subCount = Number(impactRes.data?.related_subscription_count || 0);
      const txLabel = txCount === 1 ? 'transaction entry' : 'transaction entries';
      const subLine = subCount > 0 ? `\n${subCount} linked subscription${subCount === 1 ? '' : 's'} will also be deleted.` : '';
      const ok = window.confirm(`Delete account \"${a.name}\"?\n${txCount} related ${txLabel} will be deleted.${subLine}\nThis action cannot be undone.`);
      if (!ok) return;
      await deleteAccount(a.id);
      onRefresh();
    } catch (e) {
      alert(e?.response?.data?.error || 'Failed to delete account.');
    }
  };

  const startEditCat = (c) => {
    setEditingCatId(c.id);
    setCatName(c.name || '');
    setCatType(c.type || 'Expense');
    setCatBud(String(Number(c.monthly_budget || 0)));
  };

  const getOrLoadCategoryImpact = async (categoryId) => {
    if (categoryImpactMap[categoryId]) return categoryImpactMap[categoryId];
    if (categoryImpactLoadingMap[categoryId]) return null;
    try {
      setCategoryImpactLoadingMap((prev) => ({ ...prev, [categoryId]: true }));
      const impactRes = await getCategoryDeleteImpact(categoryId);
      const impact = {
        related_transaction_count: Number(impactRes.data?.related_transaction_count || 0),
        related_split_count: Number(impactRes.data?.related_split_count || 0),
        related_subscription_count: Number(impactRes.data?.related_subscription_count || 0)
      };
      setCategoryImpactMap((prev) => ({ ...prev, [categoryId]: impact }));
      return impact;
    } catch (_) {
      return null;
    } finally {
      setCategoryImpactLoadingMap((prev) => ({ ...prev, [categoryId]: false }));
    }
  };

  const handleDeleteCat = async (c) => {
    try {
      const cached = categoryImpactMap[c.id];
      const impact = cached || await getOrLoadCategoryImpact(c.id);
      const txCount = Number(impact?.related_transaction_count || 0);
      const splitCount = Number(impact?.related_split_count || 0);
      const subCount = Number(impact?.related_subscription_count || 0);
      const lines = [
        `Delete category \"${c.name}\"?`,
        `${txCount} transaction entr${txCount === 1 ? 'y' : 'ies'} will be moved to Other.`,
        `${splitCount} split entr${splitCount === 1 ? 'y' : 'ies'} will be moved to Other.`
      ];
      if (subCount > 0) lines.push(`${subCount} linked subscription${subCount === 1 ? '' : 's'} will be moved to Other.`);
      lines.push('This action cannot be undone.');

      const ok = window.confirm(lines.join('\n'));
      if (!ok) return;

      await deleteCategory(c.id);
      onRefresh();
    } catch (e) {
      alert(e?.response?.data?.error || 'Failed to delete category.');
    }
  };

  return (
      <div className="w-full space-y-8">
          <div className={cn("p-6 rounded-2xl border shadow-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
<h2 className="text-xl font-bold mb-4">User Profile & Settings</h2>
             <form onSubmit={handleProfSubmit} className="flex flex-col gap-4"> 
                  <div className="flex items-center gap-4 mb-2">
                    <div className="relative">
                      <button type="button" onClick={() => setAvatarMenuOpen(v => !v)} className="bg-emerald-500 w-12 h-12 rounded-xl text-white flex items-center justify-center overflow-hidden" title="Profile picture options">
                        {profileData.avatar_url ? <img src={profileData.avatar_url} alt="Profile" className="w-full h-full object-cover" /> : <User className="w-6 h-6" />}
                      </button>
                      {avatarMenuOpen && (
                        <div className={cn("absolute left-0 mt-2 w-52 rounded-xl border shadow-lg z-10", darkMode ? "bg-slate-900 border-slate-700" : "bg-white border-slate-200")}>
                          <button type="button" onClick={() => { setAvatarMenuOpen(false); avatarInputRef.current?.click(); }} className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">Set Profile Pic</button>
                          {!!String(profileData.avatar_url || '').trim() && (
                            <button type="button" onClick={removeAvatar} className="w-full text-left px-3 py-2 text-sm text-rose-500 hover:bg-slate-100 dark:hover:bg-slate-800">Remove Current Profile Pic</button>
                          )}
                        </div>
                      )}
                      <input ref={avatarInputRef} type="file" className="hidden" accept="image/*" onChange={uploadAva} />
                    </div>
                 </div>
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                     <div>
                       <input className={cn("w-full p-2 border rounded outline-none", darkMode ? "bg-slate-900 border-slate-700":"border-slate-300")} placeholder="Username" value={profileData.username || ''} onChange={e=>setProfileData({...profileData, username:e.target.value})} />
                       {usernameStatus.message && <p className={cn("mt-1 text-xs", usernameStatus.checking ? "text-amber-500" : usernameStatus.available ? "text-emerald-500" : "text-rose-500")}>{usernameStatus.message}</p>}
                     </div>
                     <select className={cn("p-2 border rounded outline-none", darkMode ? "bg-slate-900 border-slate-700":"border-slate-300")} value={profileData.currency || '₹'} onChange={e=>setProfileData({...profileData, currency:e.target.value})}>
                       {currencyOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                     </select>
                     <input className={cn("p-2 border rounded outline-none", darkMode ? "bg-slate-900 border-slate-700":"border-slate-300")} type="number" placeholder="Global Monthly Budget" value={profileData.monthly_budget || ''} onChange={e=>setProfileData({...profileData, monthly_budget:Number(e.target.value || 0)})} />
                 </div>
                 <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                   <button disabled={usernameStatus.checking || !usernameStatus.available} className={cn("text-white rounded p-2 font-bold w-full sm:w-48", usernameStatus.checking || !usernameStatus.available ? "bg-emerald-300 cursor-not-allowed" : "bg-emerald-500")}>Save Settings</button>
                 </div>
             </form>
          </div>

          <div className={cn("p-6 rounded-2xl border shadow-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
            <h2 className="text-xl font-bold mb-4">PIN Recovery</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
              <input className={cn("p-2 border rounded outline-none", darkMode ? "bg-slate-900 border-slate-700":"border-slate-300")} placeholder="Username" value={pinReset.username} onChange={e=>setPinReset({...pinReset, username:e.target.value})} />
              <input className={cn("p-2 border rounded outline-none", darkMode ? "bg-slate-900 border-slate-700":"border-slate-300")} type="password" placeholder="Recovery answer" value={pinReset.recovery_answer} onChange={e=>setPinReset({...pinReset, recovery_answer:e.target.value})} />
              <input className={cn("p-2 border rounded outline-none", darkMode ? "bg-slate-900 border-slate-700":"border-slate-300")} type="password" maxLength={4} placeholder="New PIN" value={pinReset.new_pin} onChange={e=>setPinReset({...pinReset, new_pin:e.target.value})} />
            </div>
            <button onClick={async()=>{ await resetPin(pinReset); alert('PIN reset successful'); setPinReset({...pinReset, recovery_answer:'', new_pin:''}); }} className="bg-amber-500 text-white rounded p-2 text-sm font-bold mb-4">Reset PIN with Recovery</button>
          </div>

          <div className={cn("p-6 rounded-2xl border shadow-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
            <h2 className="text-xl font-bold mb-4">Month-End Snapshots</h2>
            <button onClick={async()=>{ await closeMonthSnapshot(); alert('Month-end balances frozen.'); onRefresh(); }} className="bg-emerald-500 text-white rounded p-2 text-sm font-bold">Freeze Current Month</button>
            <div className="mt-4 space-y-2 max-h-44 overflow-auto">
              {snapshots.slice(0, 40).map(s => <div key={s.id} className={cn("p-2 rounded text-sm", darkMode ? "bg-slate-900" : "bg-slate-100")}>{s.snapshot_month} | {s.account_name}: {Number(s.closing_balance || 0).toFixed(2)}</div>)}
              {snapshots.length === 0 && <div className="text-sm opacity-60">No snapshots yet.</div>}
            </div>
          </div>

          <div className={cn("p-6 rounded-2xl border shadow-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
              <h2 className="text-xl font-bold">Offline Sync Queue</h2>
              <button onClick={() => { if (!doubleConfirmDelete('offline queue items')) return; clearOfflineQueue(); setOfflineQueueItems([]); setOfflineQueueCount(0); }} className="text-xs px-2 py-1 rounded bg-rose-500 text-white">Clear All</button>
            </div>
            <div className="space-y-2 max-h-52 overflow-auto">
              {offlineQueueItems.map(item => (
                <div key={item.local_id} className={cn("p-2 rounded text-xs", darkMode ? "bg-slate-900" : "bg-slate-100")}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{item.type.toUpperCase()} {item.id ? `#${item.id}` : ''}</span>
                      <div className="flex gap-2 flex-wrap justify-end">
                      <button onClick={() => { retryOfflineQueueItemNow(item.local_id); const q = getOfflineQueueItems(); setOfflineQueueItems(q); setOfflineQueueCount(q.length); }} className="px-2 py-0.5 rounded bg-amber-500 text-white">Retry</button>
                      <button onClick={() => { if (!doubleConfirmDelete('offline queue item')) return; const left = removeOfflineQueueItem(item.local_id); setOfflineQueueItems(getOfflineQueueItems()); setOfflineQueueCount(left); }} className="px-2 py-0.5 rounded bg-slate-600 text-white">Remove</button>
                    </div>
                  </div>
                  <div className="opacity-70 mt-1">Attempts: {item.attempts || 0} {item.next_retry_at ? `| Next: ${new Date(item.next_retry_at).toLocaleTimeString()}` : ''}</div>
                  {item.last_error && <div className="mt-1 text-rose-400">{item.last_error}</div>}
                </div>
              ))}
              {offlineQueueItems.length === 0 && <div className="text-sm opacity-60">No queued offline actions.</div>}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className={cn("p-6 rounded-2xl border shadow-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                  <h2 className="text-xl font-bold mb-4">Accounts</h2>
                  <form onSubmit={handleAddAcc} className="flex flex-col gap-3 mb-6">
                      <input required placeholder="Account Name (e.g. Chase)" value={accName} onChange={e=>setAccName(e.target.value)} className={cn("p-2 border rounded outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300")}/>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <select value={accType} onChange={e=>setAccType(e.target.value)} className={cn("p-2 border rounded w-full sm:w-1/2 outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300")}><option>Bank</option><option>Wallet</option><option>Cash</option></select>
                        <input disabled={!!editingAccId} type="number" placeholder="Opening Balance" value={accBal} onChange={e=>setAccBal(e.target.value)} className={cn("p-2 border rounded w-full sm:w-1/2 outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300", editingAccId && "opacity-60 cursor-not-allowed")}/>
                      </div>
                      {editingAccId && <p className="text-xs text-amber-500">Edit mode: account name and type can be changed. Opening balance cannot be changed.</p>}
                      <div className="flex items-center gap-2">
                        <button className="bg-emerald-500 text-white rounded p-2 flex-1">{editingAccId ? 'Update Account' : 'Add Account'}</button>
                        {editingAccId && <button type="button" onClick={resetAccForm} className={cn("rounded p-2 font-medium", darkMode ? "bg-slate-700 text-slate-100" : "bg-slate-300 text-slate-800")}>Cancel</button>}
                      </div>
                  </form>
                  <div className="flex flex-col gap-2 h-64 overflow-y-auto">
                            {accounts.map(a => <div key={a.id} className={cn("flex justify-between items-center gap-2 p-3 rounded", darkMode ? "bg-slate-900 text-slate-100" : "bg-slate-50 text-slate-900")}><span className="font-medium min-w-0 break-words">{a.name} <span className="opacity-50 text-xs">({a.type})</span></span><div className="flex items-center gap-3"><button onClick={()=>startEditAcc(a)} className="text-indigo-500 shrink-0"><Edit2 className="w-4 h-4"/></button><button onClick={()=>handleDeleteAcc(a)} className="text-rose-500 shrink-0"><Trash2 className="w-4 h-4"/></button></div></div>)}
                  </div>
              </div>

              <div className={cn("p-6 rounded-2xl border shadow-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                  <h2 className="text-xl font-bold mb-4">Categories</h2>
                  <form onSubmit={handleAddCat} className="flex flex-col gap-3 mb-6">
                      <input required placeholder="Category Name" value={catName} onChange={e=>setCatName(e.target.value)} className={cn("p-2 border rounded outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300")}/>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <select value={catType} onChange={e=>setCatType(e.target.value)} className={cn("p-2 border rounded w-full sm:w-1/2 outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300")}><option>Expense</option><option>Income</option></select>
                        <input type="number" placeholder="Monthly Budget" value={catBud} onChange={e=>setCatBud(e.target.value)} className={cn("p-2 border rounded w-full sm:w-1/2 outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300")}/>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="bg-emerald-500 text-white rounded p-2 flex-1">{editingCatId ? 'Update Category' : 'Add Category'}</button>
                        {editingCatId && <button type="button" onClick={resetCatForm} className={cn("rounded p-2 font-medium", darkMode ? "bg-slate-700 text-slate-100" : "bg-slate-300 text-slate-800")}>Cancel</button>}
                      </div>
                  </form>
                  <div className="flex flex-col gap-2 h-64 overflow-y-auto">
                        {categories.map(c => {
                          const impact = categoryImpactMap[c.id];
                          const loadingImpact = !!categoryImpactLoadingMap[c.id];
                          return (
                            <div key={c.id} className={cn("flex justify-between items-center gap-2 p-3 rounded", darkMode ? "bg-slate-900 text-slate-100" : "bg-slate-50 text-slate-900")}>
                              <div className="min-w-0">
                                <span className="font-medium min-w-0 break-words">{c.name} <span className="opacity-50 text-xs">({c.type} | Budget: {Number(c.monthly_budget || 0)})</span></span>
                                {loadingImpact && <div className="text-[11px] opacity-55 mt-0.5">Checking delete impact...</div>}
                                {impact && <div className="text-[11px] opacity-65 mt-0.5">Affects: {impact.related_transaction_count} txns, {impact.related_split_count} splits, {impact.related_subscription_count} subsc</div>}
                              </div>
                              <div className="flex items-center gap-3">
                                <button onClick={()=>startEditCat(c)} className="text-indigo-500 shrink-0"><Edit2 className="w-4 h-4"/></button>
                                <button onMouseEnter={() => getOrLoadCategoryImpact(c.id)} onFocus={() => getOrLoadCategoryImpact(c.id)} onClick={()=>handleDeleteCat(c)} className="text-rose-500 shrink-0"><Trash2 className="w-4 h-4"/></button>
                              </div>
                            </div>
                          );
                        })}
                  </div>
              </div>
          </div>
      </div>
  )
}

function DebtsView({ debts, onRefresh, darkMode, curr }) {
  const [formData, setFormData] = React.useState({ person_name: '', amount: '', type: 'I Owe', due_date: '' });

  const handleSettle = async (id) => { await settleDebt(id); onRefresh(); };
  const handleSubmit = async (e) => {
      e.preventDefault();
      await addDebt(formData);
      setFormData({ person_name: '', amount: '', type: 'I Owe', due_date: '' });
      onRefresh();
  };

  return (
      <div className="w-full space-y-6">
          <h2 className="text-2xl font-bold">Debt & Loan Tracker</h2>
          <form onSubmit={handleSubmit} className={cn("p-6 rounded-2xl border shadow-sm flex flex-col gap-4", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <input required placeholder="Person Name" value={formData.person_name} onChange={e=>setFormData({...formData, person_name: e.target.value})} className={cn("p-2 border rounded outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300")}/>
                  <input required type="number" placeholder="Amount" value={formData.amount} onChange={e=>setFormData({...formData, amount: parseFloat(e.target.value)})} className={cn("p-2 border rounded outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300")}/>
                  <select value={formData.type} onChange={e=>setFormData({...formData, type: e.target.value})} className={cn("p-2 border rounded outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300")}>
                      <option>I Owe</option><option>Owing to Me</option>
                  </select>
                  <input type="date" value={formData.due_date} onChange={e=>setFormData({...formData, due_date: e.target.value})} className={cn("p-2 border rounded outline-none", darkMode?"bg-slate-900 border-slate-700":"border-slate-300")}/>
              </div>
              <button className="bg-emerald-500 hover:bg-emerald-600 text-white font-medium rounded-lg p-3">Record Debt</button>
          </form>

          <div className="space-y-4">
              {debts.map(d => (
                  <div key={d.id} className={cn("p-4 rounded-xl border flex justify-between items-center shadow-sm", darkMode ? "bg-slate-800 border-slate-700" : "bg-white")}>
                      <div>
                          <div className="flex items-center gap-2">
                              <h3 className="font-bold text-lg">{d.person_name}</h3>
                              <span className={cn("text-xs px-2 py-1 rounded-full font-medium", d.type==='I Owe' ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700")}>{d.type}</span>
                              <span className={cn("text-xs px-2 py-1 rounded-full font-medium", d.status==='Settled' ? "bg-slate-100 text-slate-700" : "bg-amber-100 text-amber-700")}>{d.status}</span>
                          </div>
                          <p className="text-sm opacity-70 mt-1">Amount: {curr}{d.amount} {d.due_date && `| Due: ${d.due_date}`}</p>
                      </div>
                      {d.status === 'Pending' && <button onClick={()=>handleSettle(d.id)} className="flex gap-2 items-center text-sm bg-emerald-50 text-emerald-600 px-4 py-2 rounded-lg font-bold transition hover:bg-emerald-100"><CheckCircle2 className="w-4 h-4"/> Settle</button>}
                  </div>
              ))}
              {debts.length === 0 && <p className="opacity-50 text-center py-8">No debts recorded.</p>}
          </div>
      </div>
  );
}

function CalendarView({ transactions, darkMode, curr }) {
   const [currDate, setCurrDate] = useState(new Date());
  const monthStart = new Date(currDate.getFullYear(), currDate.getMonth(), 1);
  const gridStart = new Date(currDate.getFullYear(), currDate.getMonth(), 1 - monthStart.getDay());
  const calendarDays = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));

   const getLocalDateStr = (d) => {
       const offset = d.getTimezoneOffset();
       return new Date(d.getTime() - (offset * 60000)).toISOString().split('T')[0];
   };
   const todayStr = getLocalDateStr(new Date());

  return (
  <div className="w-full flex flex-col space-y-3 pb-2">
       <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 shrink-0">
             <h2 className="text-2xl font-bold">Calendar</h2>
         <div className="flex items-center gap-2 sm:gap-4">
                 <button onClick={()=>setCurrDate(new Date(currDate.setMonth(currDate.getMonth()-1)))} className="px-4 py-2 border rounded hover:bg-slate-50 dark:hover:bg-slate-800 transition">Prev</button>
            <span className="font-bold text-base sm:text-lg min-w-28 sm:min-w-32 text-center">{currDate.toLocaleString('default', { month: 'long', year: 'numeric' })}</span>
                 <button onClick={()=>setCurrDate(new Date(currDate.setMonth(currDate.getMonth()+1)))} className="px-4 py-2 border rounded hover:bg-slate-50 dark:hover:bg-slate-800 transition">Next</button>
             </div>
          </div>
           <div className="grid grid-cols-7 gap-1 lg:gap-2">
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=><div key={d} className="text-center text-[11px] sm:text-sm font-bold opacity-50 py-1">{d}</div>)}
           </div>
           <div className="grid grid-cols-7 gap-1 lg:gap-2">
             {calendarDays.map(d => {
                 const dStr = getLocalDateStr(d);
                 const isToday = dStr === todayStr;
                 const isCurrentMonth = d.getMonth() === currDate.getMonth();
                 const dayTxns = transactions.filter(t => t.date === dStr);
                 const income = dayTxns.filter(t=>t.transaction_type==='Income').reduce((a,c)=>a+c.amount,0);
                 const expense = dayTxns.filter(t=>t.transaction_type==='Expense').reduce((a,c)=>a+c.amount,0);
                 const transfer = dayTxns.filter(t=>t.transaction_type==='Transfer').reduce((a,c)=>a+c.amount,0);
                 return (
                     <div key={dStr} className={cn(
                       "p-1.5 border rounded-lg flex flex-col justify-start relative group min-h-[78px] sm:min-h-[90px]",
                         isToday
                           ? "border-indigo-500 ring-2 ring-indigo-500 bg-indigo-50 dark:bg-indigo-900/30"
                           : isCurrentMonth
                             ? (darkMode ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200 shadow-sm")
                             : (darkMode ? "bg-slate-900/60 border-slate-800" : "bg-slate-50 border-slate-200")
                     )}>
                         {/* Static View Summary */}
                         <div className={cn("text-right font-bold text-sm shrink-0 transition-opacity group-hover:opacity-0 flex justify-end items-center gap-1", isToday ? "text-indigo-600 dark:text-indigo-400" : isCurrentMonth ? "opacity-70" : "opacity-45")}>
                           {isToday && <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">Today</span>}
                           <span>{d.getDate()}</span>
                         </div>
                         <div className="text-[10px] leading-tight space-y-0.5 mt-1 overflow-hidden transition-opacity group-hover:opacity-0">
                             {income>0 && <div className="text-emerald-500 font-bold bg-emerald-50 dark:bg-emerald-500/10 px-1 rounded truncate">+{curr}{income}</div>}
                             {expense>0 && <div className="text-rose-500 font-bold bg-rose-50 dark:bg-rose-500/10 px-1 rounded truncate">-{curr}{expense}</div>}
                             {transfer>0 && <div className="text-blue-500 font-bold bg-blue-50 dark:bg-blue-500/10 px-1 rounded truncate inline-flex items-center gap-1"><ArrowLeftRight className="w-3 h-3 shrink-0" />{curr}{transfer}</div>}
                         </div>

                         {/* Hover View Absolute Overlay (Eliminates Jitter) */}
                         <div className={cn(
                           "hidden md:flex absolute -inset-2 z-50 flex-col rounded-xl shadow-2xl p-2 opacity-0 pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto transition-all duration-200 transform scale-95 md:group-hover:scale-100",
                             darkMode ? "bg-slate-700 border border-slate-600" : "bg-white border border-slate-200"
                         )}>
                             <div className={cn("text-right font-bold text-sm shrink-0 mb-1 pb-1 border-b flex justify-between items-center", darkMode ? "border-slate-600" : "border-slate-100")}>
                                 <span className="text-[10px] font-normal opacity-60 px-1">{dayTxns.length} entries</span>
                                 <span className={cn("flex items-center gap-1", isToday ? "text-indigo-600 dark:text-indigo-400" : "")}>
                                   {isToday && <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300">Today</span>}
                                   <span>{d.getDate()} <span className="text-[10px] font-normal opacity-60">{(d.toLocaleString('default', { month: 'short' }))}</span></span>
                                 </span>
                             </div>
                             <div className="flex flex-col text-[10px] leading-tight space-y-1 flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar max-h-[150px] pb-1 pr-1">
                                 {dayTxns.length === 0 && <div className="text-center opacity-50 italic py-2">No entries</div>}
                                 {dayTxns.map(t => (
                                   <div key={t.id} className={cn("px-1.5 py-1 rounded font-medium shrink-0", t.transaction_type==='Income' ? "text-emerald-700 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-900/30" : t.transaction_type==='Transfer' ? "text-blue-700 bg-blue-50 dark:text-blue-300 dark:bg-blue-900/30" : "text-rose-700 bg-rose-50 dark:text-rose-300 dark:bg-rose-900/30")} title={t.description || 'Transaction'}>
                                         <div className="font-bold flex justify-between gap-1 items-start">
                                             <span className="truncate opacity-80 font-normal">{t.description || "Entry"}</span>
                                       <span className="shrink-0 inline-flex items-center gap-1">{t.transaction_type==='Transfer' && <ArrowLeftRight className="w-3 h-3 shrink-0" />}{t.transaction_type==='Income'?'+':t.transaction_type==='Transfer'?'':'-'}{curr}{Math.abs(t.amount)}</span>
                                         </div>
                                     </div>
                                 ))}
                             </div>
                         </div>
                     </div>
                 )
             })}
          </div>
      </div>
   );
}