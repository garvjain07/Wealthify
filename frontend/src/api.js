import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';
const API_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, '');
const buildApiUrl = (path, query = '') => `${API_ORIGIN}${path}${query}`;

const api = axios.create({
    baseURL: API_BASE_URL
});

const OFFLINE_TX_QUEUE_KEY = 'mm_offline_tx_queue_v1';

const mkQueueId = () => `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const normalizeQueue = (queue) => (Array.isArray(queue) ? queue : []).map((item) => ({
    local_id: item.local_id || mkQueueId(),
    attempts: Number(item.attempts || 0),
    last_error: item.last_error || null,
    next_retry_at: item.next_retry_at || null,
    ...item
}));

const loadOfflineQueue = () => {
    try {
        const raw = localStorage.getItem(OFFLINE_TX_QUEUE_KEY);
        return normalizeQueue(raw ? JSON.parse(raw) : []);
    } catch (_) {
        return [];
    }
};

const saveOfflineQueue = (queue) => {
    localStorage.setItem(OFFLINE_TX_QUEUE_KEY, JSON.stringify(queue));
};

const enqueueOfflineTx = (entry) => {
    const queue = loadOfflineQueue();
    queue.push({
        local_id: mkQueueId(),
        ...entry,
        attempts: 0,
        last_error: null,
        next_retry_at: null,
        queued_at: new Date().toISOString()
    });
    saveOfflineQueue(queue);
};

const isOfflineError = (error) => !error?.response;

const replayQueuedOp = async (op) => {
    if (op.type === 'add') return api.post('/transactions', op.payload);
    if (op.type === 'edit') return api.put(`/transactions/${op.id}`, op.payload);
    if (op.type === 'delete') return api.delete(`/transactions/${op.id}`);
    return null;
};

api.interceptors.request.use(config => {
    const token = localStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
});

export const login = (data) => api.post('/login', data);
export const register = (data) => api.post('/register', data);
export const getProfile = () => api.get('/user/me');
export const checkUsernameAvailability = (username) => api.get('/user/username-available', { params: { username } });
export const updateProfile = (data) => api.put('/user/profile', data);
export const verifyPin = (pin) => api.post('/user/verify-pin', { pin });

export const getAccounts = () => api.get('/accounts');
export const addAccount = (data) => api.post('/accounts', data);
export const editAccount = (id, data) => api.put(`/accounts/${id}`, data);
export const getAccountDeleteImpact = (id) => api.get(`/accounts/${id}/delete-impact`);
export const deleteAccount = (id) => api.delete(`/accounts/${id}`);

export const getCategories = () => api.get('/categories');
export const addCategory = (data) => api.post('/categories', data);
export const editCategory = (id, data) => api.put(`/categories/${id}`, data);
export const getCategoryDeleteImpact = (id) => api.get(`/categories/${id}/delete-impact`);
export const deleteCategory = (id) => api.delete(`/categories/${id}`);

export const getTransactions = (params = {}) => api.get('/transactions', { params });
export const getTransactionQualityIssues = () => api.get('/transactions/quality-check');
export const markTransactionQualityIssueIgnored = (id, issue_code) => api.post(`/transactions/${id}/quality-ignore`, { issue_code });
export const addTransaction = async (data) => {
    try {
        return await api.post('/transactions', data);
    } catch (error) {
        if (isOfflineError(error)) {
            enqueueOfflineTx({ type: 'add', payload: data });
            return { data: { queued: true } };
        }
        throw error;
    }
};
export const editTransaction = async (id, data) => {
    try {
        return await api.put(`/transactions/${id}`, data);
    } catch (error) {
        if (isOfflineError(error)) {
            enqueueOfflineTx({ type: 'edit', id, payload: data });
            return { data: { queued: true } };
        }
        throw error;
    }
};
export const deleteTransaction = async (id) => {
    try {
        return await api.delete(`/transactions/${id}`);
    } catch (error) {
        if (isOfflineError(error)) {
            enqueueOfflineTx({ type: 'delete', id });
            return { data: { queued: true } };
        }
        throw error;
    }
};
export const undoLastTransactionAction = () => api.post('/transactions/undo-last');
export const bulkDeleteTransactions = (ids) => api.post('/transactions/bulk-delete', { ids });
export const bulkTagTransactions = (ids, tag) => api.post('/transactions/bulk-tag', { ids, tag });

export const getOfflineQueueCount = () => loadOfflineQueue().length;
export const getOfflineQueueItems = () => loadOfflineQueue();

export const removeOfflineQueueItem = (localId) => {
    const queue = loadOfflineQueue().filter((q) => q.local_id !== localId);
    saveOfflineQueue(queue);
    return queue.length;
};

export const clearOfflineQueue = () => {
    saveOfflineQueue([]);
    return 0;
};

export const retryOfflineQueueItemNow = (localId) => {
    const queue = loadOfflineQueue().map((q) => q.local_id === localId ? { ...q, next_retry_at: null } : q);
    saveOfflineQueue(queue);
    return queue.length;
};

export const syncOfflineTransactionQueue = async () => {
    const queue = loadOfflineQueue();
    let processed = 0;
    let failed = 0;
    const remaining = [];
    const now = Date.now();

    for (const op of queue) {
        const nextRetryAt = op.next_retry_at ? new Date(op.next_retry_at).getTime() : null;
        if (nextRetryAt && nextRetryAt > now) {
            remaining.push(op);
            continue;
        }
        try {
            await replayQueuedOp(op);
            processed += 1;
        } catch (error) {
            const attempts = Number(op.attempts || 0) + 1;
            const backoffMs = Math.min(5 * 60 * 1000, 15 * 1000 * (2 ** Math.max(0, attempts - 1)));
            const message = error?.response?.data?.error || error?.message || 'Sync failed';
            remaining.push({
                ...op,
                attempts,
                last_error: message,
                next_retry_at: new Date(Date.now() + backoffMs).toISOString()
            });
            failed += 1;
            if (isOfflineError(error)) break;
        }
    }
    saveOfflineQueue(remaining);
    return { processed, failed, remaining: remaining.length };
};

export const getSubscriptions = () => api.get('/subscriptions');
export const addSubscription = (data) => api.post('/subscriptions', data);        
export const editSubscription = (id, data) => api.put(`/subscriptions/${id}`, data);
export const deleteSubscription = (id) => api.delete(`/subscriptions/${id}`);     

export const getAnalytics = () => api.get('/analytics');
export const getForecast = () => api.get('/analytics/forecast');
export const getReminders = () => api.get('/reminders');
export const runRecurringAutomation = () => api.post('/automation/run-recurring');

export const getNotifications = () => api.get('/notifications');
export const markNotificationRead = (id) => api.put(`/notifications/${id}/read`);
export const deleteNotification = (id) => api.delete(`/notifications/${id}`);
export const markAllNotificationsRead = () => api.put('/notifications/read-all');
export const clearNotifications = () => api.delete('/notifications/clear');
export const getYearlyComparison = () => api.get('/reports/yearly-comparison');
export const downloadMonthlyPdf = (month) => {
    const token = localStorage.getItem('token');
    const q = month ? `&month=${encodeURIComponent(month)}` : '';
    window.open(buildApiUrl('/api/reports/monthly-pdf', `?token=${token}${q}`), '_blank');
};
export const downloadTaxExport = () => {
    const token = localStorage.getItem('token');
    window.open(buildApiUrl('/api/reports/tax-export', `?token=${token}`), '_blank');
};

export const uploadMedia = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' }});
};

export const importCSV = async (file) => {
    const formData = new FormData();
    formData.append('csv', file);
    return api.post('/import/csv', formData, { headers: { 'Content-Type': 'multipart/form-data' }});
};

export const exportCSV = () => {
    const token = localStorage.getItem('token');
    window.open(buildApiUrl('/api/export/csv', `?token=${token}`), '_blank');
};

export const updateCategoryBudget = (id, monthly_budget) => api.put(`/categories/${id}/budget`, { monthly_budget });
export const getDebts = () => api.get('/debts');
export const addDebt = (data) => api.post('/debts', data);
export const settleDebt = (id) => api.put(`/debts/${id}/settle`);

export const getInvestments = () => api.get('/investments');
export const addInvestment = (data) => api.post('/investments', data);
export const editInvestment = (id, data) => api.put(`/investments/${id}`, data);
export const deleteInvestment = (id) => api.delete(`/investments/${id}`);

export const getGoals = () => api.get('/goals');
export const getGoalUtilizationHistory = () => api.get('/goals/utilization-history');
export const addGoal = (data) => api.post('/goals', data);
export const editGoal = (id, data) => api.put(`/goals/${id}`, data);
export const contributeGoal = (id, amount, account_id) => api.put(`/goals/${id}/contribute`, { amount, account_id });
export const withdrawGoal = (id, amount, account_id) => api.put(`/goals/${id}/withdraw`, { amount, account_id });
export const utilizeGoal = (id, data) => api.post(`/goals/${id}/utilize`, data);
export const deleteGoal = (id) => api.delete(`/goals/${id}`);

export const downloadBackup = () => {
    const token = localStorage.getItem('token');
    window.open(buildApiUrl('/api/backup/db', `?token=${token}`), '_blank');
};

export const restoreBackup = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/backup/restore', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
};

export const getReconciliation = (accountId) => api.get(`/reconciliation/${accountId}`);
export const saveReconciliation = (accountId, statement_balance, notes) => api.post(`/reconciliation/${accountId}`, { statement_balance, notes });

export const closeMonthSnapshot = (month) => api.post('/snapshots/close-month', { month });
export const getSnapshots = () => api.get('/snapshots');

export const getSavedFilters = () => api.get('/filters');
export const saveSmartFilter = (name, filter) => api.post('/filters', { name, filter });
export const deleteSmartFilter = (id) => api.delete(`/filters/${id}`);

export const resetPin = (payload) => api.post('/user/reset-pin', payload);