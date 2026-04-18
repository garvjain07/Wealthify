const express = require('express');
const cors = require('cors');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Parser } = require('json2csv');
const { initializeMongo, getNextId, models } = require('./mongoDatabase');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();
const port = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET;
const BACKUP_DIR = path.join(__dirname, 'backups');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!JWT_SECRET) {
    console.error('Missing required env var: JWT_SECRET');
    process.exit(1);
}

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/', (req, res) => {
    res.json({
        service: 'Money Manager Backend',
        status: 'ok',
        docs: '/api'
    });
});

app.get('/api', (req, res) => {
    res.json({
        service: 'Money Manager API',
        status: 'ok',
        public_endpoints: ['/api/login', '/api/register', '/api/user/reset-pin']
    });
});

let mongoReady = false;

initializeMongo().then(() => {
    mongoReady = true;
    startBackgroundJobs();
    app.listen(port, () => {
        console.log(`Backend running on port ${port}`);
        console.log('MongoDB backend enabled');
    });
}).catch((err) => {
    console.error('MongoDB initialization failed:', err.message);
    process.exit(1);
});

const parseJSON = (str, fallback = null) => {
    try { return JSON.parse(str); } catch (_) { return fallback; }
};

const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getAllowedPaymentModes = (accountType, transactionType) => {
    const normalizedType = String(accountType || '').trim().toLowerCase();
    const normalizedTxn = String(transactionType || '').trim().toLowerCase();
    if (normalizedType === 'bank') {
        if (normalizedTxn === 'transfer') {
            return ['UPI', 'UPI LITE', 'RTGS', 'IMPS', 'NEFT', 'Check', 'Net Banking'];
        }
        if (normalizedTxn === 'income') {
            return ['Cash Deposit', 'Check', 'UPI', 'IMPS', 'NEFT', 'RTGS', 'Net Banking'];
        }
        if (normalizedTxn === 'expense') {
            return ['Cash Withdraw', 'Cash Withdrawal', 'Check', 'UPI', 'IMPS', 'NEFT', 'RTGS', 'Debit Card', 'Credit Card', 'Net Banking'];
        }
        return ['Check', 'UPI', 'IMPS', 'NEFT', 'RTGS', 'Net Banking'];
    }
    if (normalizedType === 'wallet') {
        if (normalizedTxn === 'transfer') {
            return ['UPI', 'UPI LITE', 'Wallet Transfer'];
        }
        if (normalizedTxn === 'income') {
            return ['UPI', 'UPI LITE', 'Wallet Transfer'];
        }
        if (normalizedTxn === 'expense') {
            return ['UPI', 'UPI LITE', 'Wallet Transfer', 'Card', 'Other'];
        }
        return ['UPI', 'UPI LITE', 'Wallet Transfer', 'Card', 'Other'];
    }
    return [];
};

const normalizePaymentMeta = (accountType, transactionType, paymentMode, paymentApp) => {
    const normalizedType = String(accountType || '').trim().toLowerCase();
    if (!['bank', 'wallet'].includes(normalizedType)) {
        return { payment_mode: null, payment_app: null };
    }
    const mode = String(paymentMode || '').trim();
    const app = String(paymentApp || '').trim();
    const allowedModes = getAllowedPaymentModes(accountType, transactionType);
    if (mode && !allowedModes.includes(mode)) {
        throw new Error(`Invalid payment mode for ${accountType} ${transactionType || 'transaction'}.`);
    }
    return {
        payment_mode: mode || null,
        payment_app: app || null
    };
};

const adjustMongoAccountBalance = async (accountId, delta) => {
    await models.Account.updateOne({ id: Number(accountId) }, { $inc: { balance: Number(delta || 0) } });
};

const createOpeningBalanceTransaction = async (userId, accountId, openingBalance) => {
    const amount = Number(openingBalance || 0);
    if (amount <= 0) return;

    const txId = await getNextId('transactions');
    await models.Transaction.create({
        id: txId,
        user_id: userId,
        account_id: accountId,
        amount,
        date: new Date().toISOString().split('T')[0],
        description: 'Opening Balance',
        transaction_type: 'Income',
        tag: 'OpeningBalance',
        created_at: new Date().toISOString()
    });
};

const buildMongoUserBackupPayload = async (userId) => {
    const userTransactions = await models.Transaction.find({ user_id: userId }, { _id: 0 }).lean();
    const txIds = userTransactions.map((t) => t.id);
    const subscriptionRows = await models.Subscription.find({ user_id: userId }, { _id: 0 }).lean();
    const subIds = subscriptionRows.map((s) => s.id);

    return {
        users: await models.User.find({ id: userId }, { _id: 0 }).lean(),
        accounts: await models.Account.find({ user_id: userId }, { _id: 0 }).lean(),
        categories: await models.Category.find({ user_id: userId }, { _id: 0 }).lean(),
        transactions: userTransactions,
        transaction_splits: txIds.length ? await models.TransactionSplit.find({ transaction_id: { $in: txIds } }, { _id: 0 }).lean() : [],
        subscriptions: subscriptionRows,
        debts: await models.Debt.find({ user_id: userId }, { _id: 0 }).lean(),
        investments: await models.Investment.find({ user_id: userId }, { _id: 0 }).lean(),
        goals: await models.Goal.find({ user_id: userId }, { _id: 0 }).lean(),
        goal_utilization_history: await models.GoalUtilizationHistory.find({ user_id: userId }, { _id: 0 }).lean(),
        notifications: await models.Notification.find({ user_id: userId }, { _id: 0 }).lean(),
        recurring_runs: subIds.length ? await models.RecurringRun.find({ subscription_id: { $in: subIds } }, { _id: 0 }).lean() : [],
        action_history: await models.ActionHistory.find({ user_id: userId }, { _id: 0 }).lean(),
        balance_snapshots: await models.BalanceSnapshot.find({ user_id: userId }, { _id: 0 }).lean(),
        reconciliation_sessions: await models.ReconciliationSession.find({ user_id: userId }, { _id: 0 }).lean(),
        saved_filters: await models.SavedFilter.find({ user_id: userId }, { _id: 0 }).lean(),
        quality_issue_overrides: await models.QualityIssueOverride.find({ user_id: userId }, { _id: 0 }).lean()
    };
};

const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

const shouldSendByAlertLevel = (alertLevel, level) => {
    if (alertLevel === 'critical') return level === 'danger';
    return true;
};

const getEmailTransporter = () => {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
};

const saveAction = async (userId, actionType, entityType, entityId, oldData, newData) => {
    const id = await getNextId('action_history');
    await models.ActionHistory.create({
        id,
        user_id: userId,
        action_type: actionType,
        entity_type: entityType,
        entity_id: entityId || null,
        old_data: oldData ? JSON.stringify(oldData) : null,
        new_data: newData ? JSON.stringify(newData) : null,
        created_at: new Date().toISOString()
    });
};

const runAutoBackupForUser = async (user) => {
    if (!user.backup_frequency || user.backup_frequency === 'manual') return false;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const last = user.last_backup_at ? new Date(user.last_backup_at) : null;
    const daysSince = last ? Math.floor((now - last) / (1000 * 60 * 60 * 24)) : 999;
    const due = (user.backup_frequency === 'daily' && daysSince >= 1) || (user.backup_frequency === 'weekly' && daysSince >= 7);
    if (!due) return false;
    const out = path.join(BACKUP_DIR, `user-${user.id}-${Date.now()}.json`);
    const payload = await buildMongoUserBackupPayload(user.id);
    fs.writeFileSync(out, JSON.stringify(payload, null, 2));
    await models.User.updateOne({ id: user.id }, { $set: { last_backup_at: today } });
    await addNotificationIfMissingToday(user.id, 'backup', 'info', `Auto backup completed (${user.backup_frequency})`);
    return true;
};

const startBackgroundJobs = () => {
    setInterval(async () => {
        if (!mongoReady) return;
        try {
            const users = await models.User.find({}, { id: 1, backup_frequency: 1, last_backup_at: 1, _id: 0 }).lean();
            for (const user of users) {
                await runAutoBackupForUser(user);
            }
        } catch (_) {}
    }, 60 * 60 * 1000);
};

const isDueByFrequency = (nextDate, frequency, now) => {
    const d = new Date(nextDate);
    if (Number.isNaN(d.getTime())) return false;
    const n = new Date(now);
    return d <= n;
};

const nextDateFromFrequency = (nextDate, frequency) => {
    const d = new Date(nextDate);
    if (frequency === 'Weekly') d.setDate(d.getDate() + 7);
    else if (frequency === 'Yearly') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
    return d.toISOString().split('T')[0];
};

const addNotificationIfMissingToday = async (userId, type, level, message) => {
    const profile = await models.User.findOne({ id: userId }, { alert_level: 1, recovery_email: 1, _id: 0 }).lean();
    if (!shouldSendByAlertLevel(profile?.alert_level || 'all', level)) return;

    const existing = await models.Notification.findOne({
        user_id: userId,
        type,
        message,
        created_at: { $regex: `^${new Date().toISOString().split('T')[0]}` }
      }, { id: 1, _id: 0 }).lean();
    if (!existing) {
        const id = await getNextId('notifications');
        await models.Notification.create({ id, user_id: userId, type, level, message, is_read: 0, created_at: new Date().toISOString() });
        const transporter = getEmailTransporter();
        if (transporter && profile?.recovery_email && (type === 'subscription' || type === 'budget')) {
            try {
                await transporter.sendMail({
                    from: process.env.SMTP_FROM || process.env.SMTP_USER,
                    to: profile.recovery_email,
                    subject: `[Money Manager] ${type} alert`,
                    text: message
                });
            } catch (_) {}
        }
    }
};

const runRecurringAutomationForUser = async (userId) => {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const subs = await models.Subscription.find({ user_id: userId }, { _id: 0 }).lean();
    let processed = 0;

    for (const s of subs) {
        if (!isDueByFrequency(s.next_date, s.frequency, now)) continue;
        const alreadyRan = await models.RecurringRun.findOne({ subscription_id: s.id, run_date: today }, { id: 1, _id: 0 }).lean();
        if (alreadyRan) continue;

        try {
            const desc = `[AUTO:${s.name}] Recurring ${s.type}`;
            const next = nextDateFromFrequency(s.next_date, s.frequency);

            const txId = await getNextId('transactions');
            await models.Transaction.create({
                id: txId,
                user_id: userId,
                account_id: s.account_id,
                category_id: s.category_id,
                amount: s.amount,
                date: today,
                description: desc,
                transaction_type: s.type,
                receipt_url: null,
                tag: '#auto-recurring',
                created_at: new Date().toISOString()
            });
            await adjustMongoAccountBalance(s.account_id, s.type === 'Income' ? s.amount : -s.amount);
            await models.Subscription.updateOne({ id: s.id }, { $set: { next_date: next } });
            const rrId = await getNextId('recurring_runs');
            await models.RecurringRun.create({ id: rrId, user_id: userId, subscription_id: s.id, run_date: today });
            processed += 1;

            await addNotificationIfMissingToday(userId, 'recurring', 'info', `${s.name} auto-posted (${s.type})`);
        } catch (_) {}
    }
    return processed;
};

const isProtectedSystemTransaction = (tx) => {
    const tag = String(tx?.tag || '').trim().toLowerCase();
    const desc = String(tx?.description || '').trim();
    if (['goalcontribution', 'goalwithdraw', 'goalutilizedeposit', 'openingbalance', '#auto-recurring', 'auto-recurring', 'autorecurring'].includes(tag)) return true;
    if (desc === 'Opening Balance') return true;
    if (desc.startsWith('[AUTO:')) return true;
    return false;
};

const parseGoalTxnInfo = (tx) => {
    const tag = String(tx?.tag || '').trim().toLowerCase();
    const desc = String(tx?.description || '').trim();
    const contributionPrefix = 'Goal Contribution:';
    const withdrawalPrefix = 'Goal Withdrawal:';

    if (tag === 'goalcontribution' || desc.startsWith(contributionPrefix)) {
        return { title: String(desc.replace(contributionPrefix, '')).trim(), delta: -Number(tx?.amount || 0) };
    }
    if (tag === 'goalwithdraw' || desc.startsWith(withdrawalPrefix)) {
        return { title: String(desc.replace(withdrawalPrefix, '')).trim(), delta: Number(tx?.amount || 0) };
    }
    return null;
};

const applyGoalAdjustmentsForDeletedTransactions = async (userId, txRows = []) => {
    if (!Array.isArray(txRows) || txRows.length === 0) return 0;

    const deltaByTitle = new Map();
    for (const tx of txRows) {
        const info = parseGoalTxnInfo(tx);
        if (!info?.title || !Number.isFinite(info.delta) || info.delta === 0) continue;
        deltaByTitle.set(info.title.toLowerCase(), (deltaByTitle.get(info.title.toLowerCase()) || 0) + info.delta);
    }
    if (deltaByTitle.size === 0) return 0;

    const goals = await models.Goal.find({ user_id: userId }, { _id: 0, id: 1, title: 1, saved_amount: 1, target_amount: 1, status: 1 }).lean();
    let updated = 0;
    for (const goal of goals) {
        const status = String(goal.status || '').trim().toLowerCase();
        if (status && status !== 'active') continue;

        const delta = Number(deltaByTitle.get(String(goal.title || '').toLowerCase()) || 0);
        if (!delta) continue;

        const nextSaved = Math.max(0, Number(goal.saved_amount || 0) + delta);
        const nextStatus = nextSaved >= Number(goal.target_amount || 0) ? 'Completed' : 'Active';
        await models.Goal.updateOne({ id: goal.id, user_id: userId }, { $set: { saved_amount: nextSaved, status: nextStatus } });
        updated += 1;
    }

    return updated;
};


// --- AUTH ---
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    try {
        const exists = await models.User.findOne({ username }).lean();
        if (exists) return res.status(400).json({ error: 'Username already exists.' });

        const hash = await bcrypt.hash(password, 10);
        const user_id = await getNextId('users');
        await models.User.create({ id: user_id, username, password: hash });

        const defaultCategories = [
            { name: 'Salary', type: 'Income', monthly_budget: 0 },
            { name: 'Groceries', type: 'Expense', monthly_budget: 500 },
            { name: 'Rent', type: 'Expense', monthly_budget: 1000 }
        ];
        for (const c of defaultCategories) {
            const id = await getNextId('categories');
            await models.Category.create({ id, user_id, ...c });
        }
        const mainAccountId = await getNextId('accounts');
        await models.Account.create({ id: mainAccountId, user_id, name: 'Main Bank', type: 'Bank', balance: 1000 });
        await createOpeningBalanceTransaction(user_id, mainAccountId, 1000);

        const token = jwt.sign({ id: user_id, username }, JWT_SECRET);
        return res.json({ token, username });
    } catch (e) { res.status(400).json({ error: "Username already exists." }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await models.User.findOne({ username }).lean();
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username, avatar_url: user.avatar_url });
});

const authenticateToken = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1] || req.query.token;
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};
app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && req.path !== '/api/login' && req.path !== '/api/register' && req.path !== '/api/user/reset-pin' && !req.path.startsWith('/api/uploads')) {
        return authenticateToken(req, res, next);
    }
    next();
});

// --- PROFILE ---
app.get('/api/user/me', async (req, res) => {
    const user = await models.User.findOne({ id: req.user.id }).lean();
    if (!user) return res.json({});
    res.json({
        id: user.id,
        username: user.username,
        avatar_url: user.avatar_url,
        currency: user.currency,
        monthly_budget: user.monthly_budget,
        has_pin: !!user.pin_hash,
        alert_level: user.alert_level || 'all',
        backup_frequency: user.backup_frequency || 'manual',
        recovery_question: user.recovery_question || '',
        recovery_email: user.recovery_email || '',
        pin_locked_until: user.pin_locked_until || null
    });
});

app.get('/api/user/username-available', async (req, res) => {
    const requested = String(req.query.username || '').trim();
    if (!requested) return res.status(400).json({ available: false, error: 'Username is required.' });

    const current = await models.User.findOne({ id: req.user.id }, { username: 1, _id: 0 }).lean();
    if (current?.username && current.username.toLowerCase() === requested.toLowerCase()) {
        return res.json({ available: true });
    }

    const found = await models.User.findOne({
        id: { $ne: req.user.id },
        username: { $regex: `^${escapeRegExp(requested)}$`, $options: 'i' }
    }, { id: 1, _id: 0 }).lean();

    return res.json({ available: !found });
});

app.put('/api/user/profile', async (req, res) => {
    const { username, avatar_url, password, currency, monthly_budget, pin, alert_level, backup_frequency, recovery_question, recovery_answer, recovery_email } = req.body;
    try {
        const nextUsername = String(username || '').trim();
        if (!nextUsername) return res.status(400).json({ error: 'Username is required.' });

        const duplicateUser = await models.User.findOne({
            id: { $ne: req.user.id },
            username: { $regex: `^${escapeRegExp(nextUsername)}$`, $options: 'i' }
        }, { id: 1, _id: 0 }).lean();
        if (duplicateUser) return res.status(400).json({ error: 'Username already exists.' });

        const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
        const recoveryAnswerHash = recovery_answer ? await bcrypt.hash(recovery_answer, 10) : null;
        const update = {
            username: nextUsername,
            avatar_url: avatar_url || '',
            currency: currency || '$',
            monthly_budget: Number(monthly_budget || 0)
        };
        if (alert_level) update.alert_level = alert_level;
        if (backup_frequency) update.backup_frequency = backup_frequency;
        if (password) update.password = await bcrypt.hash(password, 10);
        if (pinHash) update.pin_hash = pinHash;
        if (recovery_question) update.recovery_question = recovery_question;
        if (recoveryAnswerHash) update.recovery_answer_hash = recoveryAnswerHash;
        if (recovery_email) update.recovery_email = recovery_email;
        await models.User.updateOne({ id: req.user.id }, { $set: update });
        return res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/user/verify-pin', async (req, res) => {
    const { pin } = req.body;
    const user = await models.User.findOne({ id: req.user.id }, { pin_hash: 1, pin_attempts: 1, pin_locked_until: 1, _id: 0 }).lean();
    if (!user || !user.pin_hash) return res.json({ valid: true });
    if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
        return res.status(423).json({ valid: false, error: 'PIN temporarily locked. Try later.' });
    }
    const valid = await bcrypt.compare(String(pin || ''), user.pin_hash);
    if (valid) {
        await models.User.updateOne({ id: req.user.id }, { $set: { pin_attempts: 0, pin_locked_until: null } });
        return res.json({ valid: true });
    }

    const attempts = Number(user.pin_attempts || 0) + 1;
    if (attempts >= 5) {
        const lockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        await models.User.updateOne({ id: req.user.id }, { $set: { pin_attempts: 0, pin_locked_until: lockUntil } });
        return res.status(423).json({ valid: false, error: 'Too many wrong attempts. Locked for 15 minutes.' });
    }
    await models.User.updateOne({ id: req.user.id }, { $set: { pin_attempts: attempts } });
    return res.json({ valid: false, attempts_left: 5 - attempts });
});

app.post('/api/user/reset-pin', async (req, res) => {
    const { username, recovery_answer, new_pin } = req.body;
    const user = await models.User.findOne({ username }, { id: 1, recovery_answer_hash: 1, _id: 0 }).lean();
    if (!user || !user.recovery_answer_hash) return res.status(400).json({ error: 'Recovery setup not found.' });
    const ok = await bcrypt.compare(String(recovery_answer || ''), user.recovery_answer_hash);
    if (!ok) return res.status(400).json({ error: 'Recovery verification failed.' });
    const hash = await bcrypt.hash(String(new_pin || ''), 10);
    await models.User.updateOne({ id: user.id }, { $set: { pin_hash: hash, pin_attempts: 0, pin_locked_until: null } });
    res.json({ success: true });
});

// --- BASIC ENTITIES (ACCOUNTS/CATEGORIES/TRANSACTIONS) ---
app.get('/api/accounts', async (req, res) => {
    const rows = await models.Account.find({ user_id: req.user.id }, { _id: 0 }).lean();
    return res.json(rows.map((r) => ({ ...r, is_owner: 1 })));
});
app.post('/api/accounts', async (req, res) => {
    const { name, type, balance } = req.body;
    try {
        const accountId = await getNextId('accounts');
        const initBalance = Number(balance || 0);
        await models.Account.create({ id: accountId, user_id: req.user.id, name, type, balance: initBalance });
        await createOpeningBalanceTransaction(req.user.id, accountId, initBalance);
        return res.status(201).json({ id: accountId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to create account.' });
    }
});
app.get('/api/accounts/:id/delete-impact', async (req, res) => {
    const accountId = Number(req.params.id);
    if (!Number.isInteger(accountId) || accountId <= 0) return res.status(400).json({ error: 'Invalid account id.' });

    const ownedAccount = await models.Account.findOne({ id: accountId, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
    if (!ownedAccount) return res.status(404).json({ error: 'Account not found.' });

    const [relatedTxCount, relatedSubscriptionCount] = await Promise.all([
        models.Transaction.countDocuments({ user_id: req.user.id, $or: [{ account_id: accountId }, { to_account_id: accountId }] }),
        models.Subscription.countDocuments({ user_id: req.user.id, account_id: accountId })
    ]);

    return res.json({
        account_id: accountId,
        related_transaction_count: Number(relatedTxCount || 0),
        related_subscription_count: Number(relatedSubscriptionCount || 0)
    });
});
app.delete('/api/accounts/:id', async (req, res) => {
    try {
        const accountId = Number(req.params.id);
        if (!Number.isInteger(accountId) || accountId <= 0) return res.status(400).json({ error: 'Invalid account id.' });

        const ownedAccount = await models.Account.findOne({ id: accountId, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
        if (!ownedAccount) return res.status(404).json({ error: 'Account not found.' });

        const relatedTxns = await models.Transaction.find(
            { user_id: req.user.id, $or: [{ account_id: accountId }, { to_account_id: accountId }] },
            { _id: 0, id: 1, amount: 1, transaction_type: 1, account_id: 1, to_account_id: 1, description: 1, tag: 1 }
        ).lean();

        for (const tx of relatedTxns) {
            if (tx.transaction_type !== 'Transfer') continue;
            const sourceId = Number(tx.account_id);
            const targetId = Number(tx.to_account_id);
            const amt = Number(tx.amount || 0);

            if (sourceId === accountId && Number.isInteger(targetId) && targetId > 0 && targetId !== accountId) {
                await adjustMongoAccountBalance(targetId, -amt);
            } else if (targetId === accountId && Number.isInteger(sourceId) && sourceId > 0 && sourceId !== accountId) {
                await adjustMongoAccountBalance(sourceId, amt);
            }
        }

        const relatedTxIds = relatedTxns.map((t) => t.id);
        const updatedGoals = await applyGoalAdjustmentsForDeletedTransactions(req.user.id, relatedTxns);
        if (relatedTxIds.length) {
            await models.TransactionSplit.deleteMany({ transaction_id: { $in: relatedTxIds } });
            await models.Transaction.deleteMany({ user_id: req.user.id, id: { $in: relatedTxIds } });
        }

        const deleteSubscriptions = await models.Subscription.deleteMany({ user_id: req.user.id, account_id: accountId });
        await models.Account.deleteOne({ id: accountId, user_id: req.user.id });

        return res.json({
            success: true,
            deleted_transactions: relatedTxIds.length,
            deleted_subscriptions: Number(deleteSubscriptions?.deletedCount || 0),
            adjusted_goals: updatedGoals
        });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to delete account.' });
    }
});
app.put('/api/accounts/:id', async (req, res) => {
    const { name, type } = req.body;
    const accountId = Number(req.params.id);
    const safeName = String(name || '').trim();
    const safeType = String(type || '').trim();
    if (!safeName) return res.status(400).json({ error: 'Account name is required.' });
    if (!safeType) return res.status(400).json({ error: 'Account type is required.' });
    await models.Account.updateOne(
        { id: accountId, user_id: req.user.id },
        { $set: { name: safeName, type: safeType } }
    );
    return res.json({ success: true });
});


app.get('/api/categories', async (req, res) => {
    const rows = await models.Category.find({ user_id: req.user.id }, { _id: 0 }).lean();
    return res.json(rows);
});
app.post('/api/categories', async (req, res) => {
    const { name, type, monthly_budget } = req.body;
    const id = await getNextId('categories');
    await models.Category.create({ id, user_id: req.user.id, name, type, monthly_budget: monthly_budget || 0 });
    return res.status(201).json({ id });
});
app.get('/api/categories/:id/delete-impact', async (req, res) => {
    const categoryId = Number(req.params.id);
    if (!Number.isInteger(categoryId) || categoryId <= 0) return res.status(400).json({ error: 'Invalid category id.' });

    const ownedCategory = await models.Category.findOne({ id: categoryId, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
    if (!ownedCategory) return res.status(404).json({ error: 'Category not found.' });

    const [relatedTxCount, relatedSplitCount, relatedSubscriptionCount] = await Promise.all([
        models.Transaction.countDocuments({ user_id: req.user.id, category_id: categoryId }),
        models.TransactionSplit.countDocuments({ category_id: categoryId }),
        models.Subscription.countDocuments({ user_id: req.user.id, category_id: categoryId })
    ]);

    return res.json({
        category_id: categoryId,
        related_transaction_count: Number(relatedTxCount || 0),
        related_split_count: Number(relatedSplitCount || 0),
        related_subscription_count: Number(relatedSubscriptionCount || 0)
    });
});
app.delete('/api/categories/:id', async (req, res) => {
    try {
        const categoryId = Number(req.params.id);
        if (!Number.isInteger(categoryId) || categoryId <= 0) return res.status(400).json({ error: 'Invalid category id.' });

        const oldCategory = await models.Category.findOne({ id: categoryId, user_id: req.user.id }, { _id: 0 }).lean();
        if (!oldCategory) return res.status(404).json({ error: 'Category not found.' });

        let otherCategory = await models.Category.findOne(
            { user_id: req.user.id, type: oldCategory.type, name: /^other$/i },
            { id: 1, _id: 0 }
        ).lean();

        if (!otherCategory || Number(otherCategory.id) === categoryId) {
            const otherId = await getNextId('categories');
            await models.Category.create({ id: otherId, user_id: req.user.id, name: 'Other', type: oldCategory.type, monthly_budget: 0 });
            otherCategory = { id: otherId };
        }

        const replacementId = Number(otherCategory.id);
        await Promise.all([
            models.Transaction.updateMany({ user_id: req.user.id, category_id: categoryId }, { $set: { category_id: replacementId } }),
            models.TransactionSplit.updateMany({ category_id: categoryId }, { $set: { category_id: replacementId } }),
            models.Subscription.updateMany({ user_id: req.user.id, category_id: categoryId }, { $set: { category_id: replacementId } })
        ]);

        await models.Category.deleteOne({ id: categoryId, user_id: req.user.id });
        return res.json({ success: true, replaced_with: replacementId });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to delete category.' });
    }
});
app.put('/api/categories/:id', async (req, res) => {
    const { name, type, monthly_budget } = req.body;
    const categoryId = Number(req.params.id);
    const safeBudget = Number(monthly_budget || 0);
    await models.Category.updateOne(
        { id: categoryId, user_id: req.user.id },
        { $set: { name, type, monthly_budget: safeBudget } }
    );
    return res.json({ success: true });
});

app.get('/api/transactions', async (req, res) => {
    const page = Math.max(Number(req.query.page || 1), 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize || 100), 1), 200);
    const offset = (page - 1) * pageSize;
    const search = String(req.query.q || '').trim();
    const tag = String(req.query.tag || '').trim();
    const category = String(req.query.category || '').trim();
    const fromDate = String(req.query.fromDate || '').trim();
    const toDate = String(req.query.toDate || '').trim();

    const [txRows, accounts, categories] = await Promise.all([
        models.Transaction.find({ user_id: req.user.id }, { _id: 0 }).lean(),
        models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
        models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
    ]);

    const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const searchLower = search.toLowerCase();
    const tagLower = tag.toLowerCase();
    const categoryLower = category.toLowerCase();

    const filtered = txRows.filter((t) => {
        const accountName = String(accountMap.get(t.account_id) || '').toLowerCase();
        const categoryName = String(categoryMap.get(t.category_id) || '').toLowerCase();
        const desc = String(t.description || '').toLowerCase();
        const txTag = String(t.tag || '').toLowerCase();

        if (search && !(desc.includes(searchLower) || txTag.includes(searchLower) || categoryName.includes(searchLower) || accountName.includes(searchLower))) return false;
        if (tag && !txTag.includes(tagLower)) return false;
        if (category && !categoryName.includes(categoryLower)) return false;
        if (fromDate && String(t.date || '') < fromDate) return false;
        if (toDate && String(t.date || '') > toDate) return false;
        return true;
    }).sort((a, b) => {
        if (a.date === b.date) return Number(b.id) - Number(a.id);
        return String(b.date).localeCompare(String(a.date));
    });

    const pageItems = filtered.slice(offset, offset + pageSize);
    const txIds = pageItems.map((t) => t.id);
    const splitRows = txIds.length
        ? await models.TransactionSplit.find({ transaction_id: { $in: txIds } }, { _id: 0 }).lean()
        : [];
    const splitMap = splitRows.reduce((acc, row) => {
        const category_name = categoryMap.get(row.category_id) || null;
        acc[row.transaction_id] = acc[row.transaction_id] || [];
        acc[row.transaction_id].push({ ...row, category_name });
        return acc;
    }, {});

    return res.json({
        items: pageItems.map((t) => ({
            ...t,
            account_name: accountMap.get(t.account_id) || null,
            to_account_name: accountMap.get(t.to_account_id) || null,
            category_name: categoryMap.get(t.category_id) || null,
            splits: splitMap[t.id] || []
        })),
        page,
        pageSize,
        total: filtered.length
    });
});

app.get('/api/transactions/quality-check', async (req, res) => {
    const [txRows, accounts, categories, overrides] = await Promise.all([
        models.Transaction.find({ user_id: req.user.id }, { _id: 0 }).lean(),
        models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
        models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
        models.QualityIssueOverride.find({ user_id: req.user.id }, { transaction_id: 1, issue_code: 1, _id: 0 }).lean()
    ]);

    const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const txns = txRows
        .map((t) => ({ ...t, account_name: accountMap.get(t.account_id) || null, category_name: categoryMap.get(t.category_id) || null }))
        .sort((a, b) => (a.date === b.date ? Number(b.id) - Number(a.id) : String(b.date).localeCompare(String(a.date))));

    const expenseRows = txns.filter(t => t.transaction_type === 'Expense');
    const incomeRows = txns.filter(t => t.transaction_type === 'Income');
    const avgExpense = expenseRows.length ? expenseRows.reduce((s, r) => s + Number(r.amount || 0), 0) / expenseRows.length : 0;
    const avgIncome = incomeRows.length ? incomeRows.reduce((s, r) => s + Number(r.amount || 0), 0) / incomeRows.length : 0;
    const highExpenseThreshold = Math.max(10000, avgExpense * 3);
    const highIncomeThreshold = Math.max(20000, avgIncome * 3);

    const duplicateCount = new Map();
    for (const t of txns) {
        const key = `${t.account_id}|${t.transaction_type}|${t.date}|${Number(t.amount)}|${String(t.description || '').toLowerCase()}`;
        duplicateCount.set(key, (duplicateCount.get(key) || 0) + 1);
    }
    const dupKeys = new Set([...duplicateCount.entries()].filter(([, cnt]) => cnt > 1).map(([k]) => k));
    const ignoredKeys = new Set(overrides.map(r => `${r.transaction_id}|${r.issue_code}`));
    const isIgnored = (transactionId, issueCode) => ignoredKeys.has(`${transactionId}|${issueCode}`);

    const now = new Date();
    const maxFuture = new Date(now);
    maxFuture.setDate(maxFuture.getDate() + 1);
    const minPast = new Date(now);
    minPast.setFullYear(minPast.getFullYear() - 10);

    const issues = [];
    for (const t of txns) {
        if (isProtectedSystemTransaction(t)) continue;

        const itemIssues = [];
        const amount = Number(t.amount || 0);
        if (t.transaction_type === 'Expense' && amount >= highExpenseThreshold && !isIgnored(t.id, 'high_expense_amount')) {
            itemIssues.push(`Very high expense amount (${amount.toFixed(2)})`);
        }
        if (t.transaction_type === 'Income' && amount >= highIncomeThreshold && !isIgnored(t.id, 'high_income_amount')) {
            itemIssues.push(`Very high income amount (${amount.toFixed(2)})`);
        }

        const dt = new Date(t.date);
        if ((Number.isNaN(dt.getTime()) || dt > maxFuture || dt < minPast) && !isIgnored(t.id, 'suspicious_date')) {
            itemIssues.push('Suspicious transaction date');
        }

        const dKey = `${t.account_id}|${t.transaction_type}|${t.date}|${Number(t.amount)}|${String(t.description || '').toLowerCase()}`;
        if (dupKeys.has(dKey) && !isIgnored(t.id, 'possible_duplicate')) {
            itemIssues.push('Possible duplicate transaction');
        }

        if (itemIssues.length) {
            issues.push({
                transaction_id: t.id,
                amount: amount,
                date: t.date,
                description: t.description,
                transaction_type: t.transaction_type,
                account_name: t.account_name,
                category_name: t.category_name,
                issues: itemIssues
            });
        }
    }

    res.json({
        count: issues.length,
        thresholds: {
            high_expense: Number(highExpenseThreshold.toFixed(2)),
            high_income: Number(highIncomeThreshold.toFixed(2))
        },
        items: issues
    });
});

app.post('/api/transactions/:id/quality-ignore', async (req, res) => {
    const txId = Number(req.params.id);
    const issueCode = String(req.body?.issue_code || '');
    const allowedIssueCodes = new Set(['possible_duplicate', 'suspicious_date', 'high_expense_amount', 'high_income_amount']);

    if (!Number.isInteger(txId) || txId <= 0) {
        return res.status(400).json({ error: 'Invalid transaction id' });
    }
    if (!allowedIssueCodes.has(issueCode)) {
        return res.status(400).json({ error: 'Invalid issue code' });
    }

    const owned = await models.Transaction.findOne({ id: txId, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
    if (!owned) {
        return res.status(404).json({ error: 'Transaction not found' });
    }

    const existing = await models.QualityIssueOverride.findOne({ user_id: req.user.id, transaction_id: txId, issue_code: issueCode }, { id: 1, _id: 0 }).lean();
    if (!existing) {
        const id = await getNextId('quality_issue_overrides');
        await models.QualityIssueOverride.create({ id, user_id: req.user.id, transaction_id: txId, issue_code: issueCode, created_at: new Date().toISOString() });
    }
    return res.json({ ok: true, transaction_id: txId, issue_code: issueCode });
});

app.post('/api/transactions', async (req, res) => {
    const { account_id, to_account_id, category_id, amount, date, description, type, receipt_url, tag, split_items, payment_mode, payment_app } = req.body;
    try {
        const sourceId = Number(account_id);
        const ownedSource = await models.Account.findOne({ id: sourceId, user_id: req.user.id }, { id: 1, type: 1, _id: 0 }).lean();
        if (!ownedSource) return res.status(403).json({ error: 'No permission on account' });
        const paymentMeta = normalizePaymentMeta(ownedSource.type, type, payment_mode, payment_app);

        const amt = Number(amount || 0);
        let iId;
        if (type === 'Transfer') {
            const targetId = Number(to_account_id);
            if (sourceId === targetId) return res.status(400).json({ error: 'Source and destination account cannot be the same for transfer.' });
            const ownedTarget = await models.Account.findOne({ id: targetId, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
            if (!ownedTarget) return res.status(403).json({ error: 'No permission on destination account' });
            iId = await getNextId('transactions');
            await models.Transaction.create({
                id: iId,
                user_id: req.user.id,
                account_id: sourceId,
                to_account_id: targetId,
                amount: amt,
                date,
                description,
                transaction_type: type,
                receipt_url,
                payment_mode: paymentMeta.payment_mode,
                payment_app: paymentMeta.payment_app,
                tag: tag || null,
                created_at: new Date().toISOString(),
                category_id: null
            });
            await adjustMongoAccountBalance(sourceId, -amt);
            await adjustMongoAccountBalance(targetId, amt);
        } else if (Array.isArray(split_items) && split_items.length > 0) {
            const totalAmount = split_items.reduce((s, it) => s + Number(it.amount || 0), 0);
            iId = await getNextId('transactions');
            await models.Transaction.create({
                id: iId,
                user_id: req.user.id,
                account_id: sourceId,
                category_id: null,
                amount: totalAmount,
                date,
                description,
                transaction_type: type,
                receipt_url,
                payment_mode: paymentMeta.payment_mode,
                payment_app: paymentMeta.payment_app,
                tag: tag || null,
                created_at: new Date().toISOString()
            });
            for (const it of split_items) {
                const splitId = await getNextId('transaction_splits');
                await models.TransactionSplit.create({ id: splitId, transaction_id: iId, category_id: it.category_id || null, amount: Number(it.amount || 0), tag: it.tag || null });
            }
            await adjustMongoAccountBalance(sourceId, type === 'Income' ? totalAmount : -totalAmount);
        } else {
            iId = await getNextId('transactions');
            await models.Transaction.create({
                id: iId,
                user_id: req.user.id,
                account_id: sourceId,
                category_id: category_id || null,
                amount: amt,
                date,
                description,
                transaction_type: type,
                receipt_url,
                payment_mode: paymentMeta.payment_mode,
                payment_app: paymentMeta.payment_app,
                tag: tag || null,
                created_at: new Date().toISOString(),
                to_account_id: null
            });
            await adjustMongoAccountBalance(sourceId, type === 'Income' ? amt : -amt);
        }

        const created = await models.Transaction.findOne({ id: iId }, { _id: 0 }).lean();
        await saveAction(req.user.id, 'create', 'transaction', iId, null, created);
        return res.status(201).json({ id: iId });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/transactions/:id', async (req, res) => {
    try {
        const txId = Number(req.params.id);
        const oldTx = await models.Transaction.findOne({ id: txId, user_id: req.user.id }, { _id: 0 }).lean();
        if (!oldTx) throw new Error('Transaction not found');
        if (isProtectedSystemTransaction(oldTx)) throw new Error('System-generated transactions cannot be deleted');

        if (oldTx.transaction_type === 'Transfer') {
            await adjustMongoAccountBalance(oldTx.account_id, Number(oldTx.amount || 0));
            await adjustMongoAccountBalance(oldTx.to_account_id, -Number(oldTx.amount || 0));
        } else {
            await adjustMongoAccountBalance(oldTx.account_id, oldTx.transaction_type === 'Income' ? -Number(oldTx.amount || 0) : Number(oldTx.amount || 0));
        }

        await saveAction(req.user.id, 'delete', 'transaction', oldTx.id, oldTx, null);
        await models.TransactionSplit.deleteMany({ transaction_id: txId });
        await models.Transaction.deleteOne({ id: txId, user_id: req.user.id });
        return res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/transactions/:id', async (req, res) => {
    const { account_id, to_account_id, category_id, amount, date, description, type, receipt_url, tag, split_items, payment_mode, payment_app } = req.body;
    try {
        const txId = Number(req.params.id);
        const oldTx = await models.Transaction.findOne({ id: txId, user_id: req.user.id }, { _id: 0 }).lean();
        if (!oldTx) throw new Error('Transaction not found');
        if (isProtectedSystemTransaction(oldTx)) throw new Error('System-generated transactions cannot be edited');
        const oldSplits = await models.TransactionSplit.find({ transaction_id: txId }, { _id: 0 }).lean();

        const sourceId = Number(account_id);
        const ownedSource = await models.Account.findOne({ id: sourceId, user_id: req.user.id }, { id: 1, type: 1, _id: 0 }).lean();
        if (!ownedSource) throw new Error('No permission on account');
        const paymentMeta = normalizePaymentMeta(ownedSource.type, type, payment_mode, payment_app);
        if (type === 'Transfer') {
            const targetId = Number(to_account_id);
            if (sourceId === targetId) throw new Error('Source and destination account cannot be the same for transfer.');
            const ownedTarget = await models.Account.findOne({ id: targetId, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
            if (!ownedTarget) throw new Error('No permission on destination account');
        }

        if (oldTx.transaction_type === 'Transfer') {
            await adjustMongoAccountBalance(oldTx.account_id, Number(oldTx.amount || 0));
            await adjustMongoAccountBalance(oldTx.to_account_id, -Number(oldTx.amount || 0));
        } else {
            await adjustMongoAccountBalance(oldTx.account_id, oldTx.transaction_type === 'Income' ? -Number(oldTx.amount || 0) : Number(oldTx.amount || 0));
        }

        await models.TransactionSplit.deleteMany({ transaction_id: txId });
        const amt = Number(amount || 0);
        let payload;
        if (type === 'Transfer') {
            payload = {
                account_id: sourceId,
                to_account_id: Number(to_account_id),
                category_id: null,
                amount: amt,
                date,
                description,
                transaction_type: type,
                receipt_url,
                payment_mode: paymentMeta.payment_mode,
                payment_app: paymentMeta.payment_app,
                tag: tag || null
            };
            await adjustMongoAccountBalance(sourceId, -amt);
            await adjustMongoAccountBalance(Number(to_account_id), amt);
        } else if (Array.isArray(split_items) && split_items.length > 0) {
            const totalAmount = split_items.reduce((s, it) => s + Number(it.amount || 0), 0);
            payload = {
                account_id: sourceId,
                to_account_id: null,
                category_id: null,
                amount: totalAmount,
                date,
                description,
                transaction_type: type,
                receipt_url,
                payment_mode: paymentMeta.payment_mode,
                payment_app: paymentMeta.payment_app,
                tag: tag || null
            };
            for (const it of split_items) {
                const splitId = await getNextId('transaction_splits');
                await models.TransactionSplit.create({ id: splitId, transaction_id: txId, category_id: it.category_id || null, amount: Number(it.amount || 0), tag: it.tag || null });
            }
            await adjustMongoAccountBalance(sourceId, type === 'Income' ? totalAmount : -totalAmount);
        } else {
            payload = {
                account_id: sourceId,
                to_account_id: null,
                category_id: category_id || null,
                amount: amt,
                date,
                description,
                transaction_type: type,
                receipt_url,
                payment_mode: paymentMeta.payment_mode,
                payment_app: paymentMeta.payment_app,
                tag: tag || null
            };
            await adjustMongoAccountBalance(sourceId, type === 'Income' ? amt : -amt);
        }

        await models.Transaction.updateOne({ id: txId, user_id: req.user.id }, { $set: payload });
        const newTx = await models.Transaction.findOne({ id: txId }, { _id: 0 }).lean();
        const newSplits = await models.TransactionSplit.find({ transaction_id: txId }, { _id: 0 }).lean();
        await saveAction(req.user.id, 'update', 'transaction', oldTx.id, { ...oldTx, splits: oldSplits }, { ...newTx, splits: newSplits });
        return res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/transactions/bulk-delete', async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.json({ success: true, count: 0 });

    let count = 0;
    for (const id of ids.map(Number)) {
        const tx = await models.Transaction.findOne({ id, user_id: req.user.id }, { _id: 0 }).lean();
        if (!tx) continue;
        if (isProtectedSystemTransaction(tx)) continue;
        if (tx.transaction_type === 'Transfer') {
            await adjustMongoAccountBalance(tx.account_id, Number(tx.amount || 0));
            await adjustMongoAccountBalance(tx.to_account_id, -Number(tx.amount || 0));
        } else {
            await adjustMongoAccountBalance(tx.account_id, tx.transaction_type === 'Income' ? -Number(tx.amount || 0) : Number(tx.amount || 0));
        }
        await saveAction(req.user.id, 'delete', 'transaction', tx.id, tx, null);
        await models.TransactionSplit.deleteMany({ transaction_id: id });
        await models.Transaction.deleteOne({ id, user_id: req.user.id });
        count += 1;
    }
    return res.json({ success: true, count });
});

app.post('/api/transactions/bulk-tag', async (req, res) => {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const tag = String(req.body.tag || '').trim();
    if (!ids.length) return res.json({ success: true, count: 0 });

    let count = 0;
    for (const id of ids.map(Number)) {
        const oldTx = await models.Transaction.findOne({ id, user_id: req.user.id }, { _id: 0 }).lean();
        if (!oldTx) continue;
        if (isProtectedSystemTransaction(oldTx)) continue;
        await models.Transaction.updateOne({ id, user_id: req.user.id }, { $set: { tag: tag || null } });
        const newTx = await models.Transaction.findOne({ id }, { _id: 0 }).lean();
        await saveAction(req.user.id, 'update', 'transaction', oldTx.id, oldTx, newTx);
        count += 1;
    }
    return res.json({ success: true, count });
});

app.post('/api/transactions/undo-last', async (req, res) => {
    const last = await models.ActionHistory.findOne({ user_id: req.user.id, entity_type: 'transaction' }, { _id: 0 }).sort({ id: -1 }).lean();
    if (!last) return res.status(404).json({ error: 'No undo action available.' });

    const oldData = parseJSON(last.old_data, null);
    const newData = parseJSON(last.new_data, null);
    try {
        if (last.action_type === 'delete' && oldData) {
            await models.Transaction.updateOne(
                { id: oldData.id },
                {
                    $set: {
                        id: oldData.id,
                        user_id: oldData.user_id,
                        amount: oldData.amount,
                        date: oldData.date,
                        description: oldData.description,
                        transaction_type: oldData.transaction_type,
                        category_id: oldData.category_id,
                        account_id: oldData.account_id,
                        to_account_id: oldData.to_account_id,
                        receipt_url: oldData.receipt_url,
                        payment_mode: oldData.payment_mode || null,
                        payment_app: oldData.payment_app || null,
                        created_at: oldData.created_at,
                        tag: oldData.tag || null
                    }
                },
                { upsert: true }
            );
            if (oldData.transaction_type === 'Transfer') {
                await adjustMongoAccountBalance(oldData.account_id, -Number(oldData.amount || 0));
                await adjustMongoAccountBalance(oldData.to_account_id, Number(oldData.amount || 0));
            } else {
                await adjustMongoAccountBalance(oldData.account_id, oldData.transaction_type === 'Income' ? Number(oldData.amount || 0) : -Number(oldData.amount || 0));
            }
        } else if (last.action_type === 'update' && oldData) {
            if (newData?.transaction_type === 'Transfer') {
                await adjustMongoAccountBalance(newData.account_id, Number(newData.amount || 0));
                await adjustMongoAccountBalance(newData.to_account_id, -Number(newData.amount || 0));
            } else if (newData) {
                await adjustMongoAccountBalance(newData.account_id, newData.transaction_type === 'Income' ? -Number(newData.amount || 0) : Number(newData.amount || 0));
            }

            await models.Transaction.updateOne(
                { id: oldData.id, user_id: req.user.id },
                {
                    $set: {
                        amount: oldData.amount,
                        date: oldData.date,
                        description: oldData.description,
                        transaction_type: oldData.transaction_type,
                        category_id: oldData.category_id,
                        account_id: oldData.account_id,
                        to_account_id: oldData.to_account_id,
                        receipt_url: oldData.receipt_url,
                        payment_mode: oldData.payment_mode || null,
                        payment_app: oldData.payment_app || null,
                        tag: oldData.tag || null
                    }
                }
            );
            await models.TransactionSplit.deleteMany({ transaction_id: oldData.id });
            for (const s of (oldData.splits || [])) {
                const sid = await getNextId('transaction_splits');
                await models.TransactionSplit.create({ id: sid, transaction_id: oldData.id, category_id: s.category_id || null, amount: s.amount, tag: s.tag || null });
            }
            if (oldData.transaction_type === 'Transfer') {
                await adjustMongoAccountBalance(oldData.account_id, -Number(oldData.amount || 0));
                await adjustMongoAccountBalance(oldData.to_account_id, Number(oldData.amount || 0));
            } else {
                await adjustMongoAccountBalance(oldData.account_id, oldData.transaction_type === 'Income' ? Number(oldData.amount || 0) : -Number(oldData.amount || 0));
            }
        }

        await models.ActionHistory.deleteOne({ id: last.id });
        return res.json({ success: true });
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
});

// --- SUBSCRIPTIONS ---
app.get('/api/subscriptions', async (req, res) => {
    const [subs, accounts, categories] = await Promise.all([
        models.Subscription.find({ user_id: req.user.id }, { _id: 0 }).lean(),
        models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
        models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
    ]);
    const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    return res.json(subs.map((s) => ({ ...s, account_name: accountMap.get(s.account_id) || null, category_name: categoryMap.get(s.category_id) || null })));
});
app.post('/api/subscriptions', async (req, res) => {
    const { account_id, category_id, name, amount, type, frequency, next_date } = req.body;
    const id = await getNextId('subscriptions');
    await models.Subscription.create({ id, user_id: req.user.id, account_id, category_id, name, amount, type, frequency, next_date });
    return res.json({ id });
});
app.put('/api/subscriptions/:id', async (req, res) => {
    const { account_id, category_id, name, amount, type, frequency, next_date } = req.body;
    await models.Subscription.updateOne(
        { id: Number(req.params.id), user_id: req.user.id },
        { $set: { account_id, category_id, name, amount, type, frequency, next_date } }
    );
    return res.json({ success: true });
});
app.delete('/api/subscriptions/:id', async (req, res) => {
    await models.Subscription.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
    return res.json({ success: true });
});

// --- ANALYTICS ---
app.get('/api/analytics', async (req, res) => {
    const rows = await models.Transaction.find({ user_id: req.user.id, transaction_type: { $ne: 'Transfer' } }, { _id: 0, date: 1, amount: 1, transaction_type: 1 }).lean();
    const monthMap = new Map();
    for (const r of rows) {
        const month = String(r.date || '').slice(0, 7);
        if (!monthMap.has(month)) monthMap.set(month, { month, income: 0, expense: 0 });
        const item = monthMap.get(month);
        if (r.transaction_type === 'Income') item.income += Number(r.amount || 0);
        if (r.transaction_type === 'Expense') item.expense += Number(r.amount || 0);
    }
    return res.json([...monthMap.values()].sort((a, b) => String(a.month).localeCompare(String(b.month))).slice(-12));
});

app.get('/api/analytics/forecast', async (req, res) => {
    const rows = await models.Transaction.find({ user_id: req.user.id, transaction_type: { $ne: 'Transfer' } }, { _id: 0, date: 1, amount: 1, transaction_type: 1 }).lean();
    const monthMap = new Map();
    for (const r of rows) {
        const month = String(r.date || '').slice(0, 7);
        if (!monthMap.has(month)) monthMap.set(month, { month, income: 0, expense: 0 });
        const item = monthMap.get(month);
        if (r.transaction_type === 'Income') item.income += Number(r.amount || 0);
        if (r.transaction_type === 'Expense') item.expense += Number(r.amount || 0);
    }
    const monthly = [...monthMap.values()].sort((a, b) => String(b.month).localeCompare(String(a.month))).slice(0, 3);
    if (!monthly.length) return res.json({ forecast_income: 0, forecast_expense: 0, forecast_savings: 0, based_on_months: 0 });
    const avgIncome = monthly.reduce((s, m) => s + Number(m.income || 0), 0) / monthly.length;
    const avgExpense = monthly.reduce((s, m) => s + Number(m.expense || 0), 0) / monthly.length;
    return res.json({
        forecast_income: Number(avgIncome.toFixed(2)),
        forecast_expense: Number(avgExpense.toFixed(2)),
        forecast_savings: Number((avgIncome - avgExpense).toFixed(2)),
        based_on_months: monthly.length
    });
});

app.get('/api/reminders', async (req, res) => {
    await runRecurringAutomationForUser(req.user.id);
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const monthPrefix = `${yyyy}-${mm}`;
    const reminders = [];

    const profile = await models.User.findOne({ id: req.user.id }, { currency: 1, monthly_budget: 1, _id: 0 }).lean();
    const curr = profile?.currency || '$';

    const totalExpenseRow = { total: (await models.Transaction.find({ user_id: req.user.id, transaction_type: 'Expense', date: { $regex: `^${escapeRegExp(monthPrefix)}` } }, { amount: 1, _id: 0 }).lean()).reduce((s, r) => s + Number(r.amount || 0), 0) };
    const totalExpense = Number(totalExpenseRow?.total || 0);
    const globalBudget = Number(profile?.monthly_budget || 0);

    if (globalBudget > 0) {
        const pct = (totalExpense / globalBudget) * 100;
        if (pct >= 100) reminders.push({ type: 'budget', level: 'danger', message: `Global budget exceeded: ${curr}${totalExpense.toFixed(0)} / ${curr}${globalBudget.toFixed(0)}` });
        else if (pct >= 80) reminders.push({ type: 'budget', level: 'warning', message: `Global budget at ${pct.toFixed(0)}%` });
    }

    const catBudgets = await models.Category.find({ user_id: req.user.id, type: 'Expense', monthly_budget: { $gt: 0 } }, { _id: 0, id: 1, name: 1, monthly_budget: 1 }).lean();
    for (const c of catBudgets) {
        const row = { total: (await models.Transaction.find({ user_id: req.user.id, category_id: c.id, transaction_type: 'Expense', date: { $regex: `^${escapeRegExp(monthPrefix)}` } }, { amount: 1, _id: 0 }).lean()).reduce((s, r) => s + Number(r.amount || 0), 0) };
        const spent = Number(row?.total || 0);
        const pct = (spent / Number(c.monthly_budget)) * 100;
        if (pct >= 100) reminders.push({ type: 'category_budget', level: 'danger', message: `${c.name} budget exceeded` });
        else if (pct >= 80) reminders.push({ type: 'category_budget', level: 'warning', message: `${c.name} budget at ${pct.toFixed(0)}%` });
    }

    const subs = await models.Subscription.find({ user_id: req.user.id }, { _id: 0, name: 1, next_date: 1 }).lean();
    for (const s of subs) {
        const d = new Date(s.next_date);
        const diff = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
        if (diff >= 0 && diff <= 3) reminders.push({ type: 'subscription', level: diff === 0 ? 'danger' : 'info', message: `${s.name} due in ${diff} day(s)` });
    }

    for (const r of reminders) {
        await addNotificationIfMissingToday(req.user.id, r.type, r.level, r.message);
    }

    res.json(reminders);
});

app.post('/api/automation/run-recurring', async (req, res) => {
    const processed = await runRecurringAutomationForUser(req.user.id);
    res.json({ success: true, processed });
});

app.get('/api/notifications', async (req, res) => {
    const rows = await models.Notification.find({ user_id: req.user.id }, { _id: 0 }).sort({ created_at: -1, id: -1 }).limit(100).lean();
    return res.json(rows);
});

app.put('/api/notifications/:id/read', async (req, res) => {
    await models.Notification.updateOne({ id: Number(req.params.id), user_id: req.user.id }, { $set: { is_read: 1 } });
    return res.json({ success: true });
});

app.put('/api/notifications/read-all', async (req, res) => {
    await models.Notification.updateMany({ user_id: req.user.id }, { $set: { is_read: 1 } });
    return res.json({ success: true });
});

app.delete('/api/notifications/clear', async (req, res) => {
    await models.Notification.deleteMany({ user_id: req.user.id });
    return res.json({ success: true });
});

// --- UPLOADS & IMPORT/EXPORT ---
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ url: `http://localhost:3001/uploads/${req.file.filename}` });
});

app.get('/api/export/csv', async (req, res) => {
    const [txRows, accounts, categories] = await Promise.all([
        models.Transaction.find({ user_id: req.user.id }, { _id: 0 }).sort({ date: -1, id: -1 }).lean(),
        models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean(),
        models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
    ]);
    const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const data = txRows.map((t) => ({
        date: t.date,
        transaction_type: t.transaction_type,
        amount: t.amount,
        description: t.description,
        account_name: accountMap.get(t.account_id) || null,
        category_name: categoryMap.get(t.category_id) || null
    }));
    const parser = new Parser({ fields: ['date', 'transaction_type', 'amount', 'description', 'account_name', 'category_name'] });
    res.attachment('transactions.csv');
    return res.send(parser.parse(data));
});

app.post('/api/import/csv', upload.single('csv'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const results = [];
    fs.createReadStream(req.file.path).pipe(csv())
      .on('data', (d) => results.push(d))
      .on('end', async () => {
          try {
              let inserted = 0;
              let skippedDuplicates = 0;

              for (const row of results) {
                  let acc = await models.Account.findOne({ name: row.account_name, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
                  if (!acc && row.account_name) {
                      const accId = await getNextId('accounts');
                      await models.Account.create({ id: accId, user_id: req.user.id, name: row.account_name, type: 'Bank', balance: 0 });
                      acc = { id: accId };
                  }

                  let cat = await models.Category.findOne({ name: row.category_name, user_id: req.user.id }, { id: 1, _id: 0 }).lean();
                  if (!cat && row.category_name && row.transaction_type !== 'Transfer') {
                      const catId = await getNextId('categories');
                      await models.Category.create({ id: catId, user_id: req.user.id, name: row.category_name, type: row.transaction_type, monthly_budget: 0 });
                      cat = { id: catId };
                  }

                  if (acc && row.amount) {
                      const amount = parseFloat(row.amount);
                      if (Number.isNaN(amount)) continue;
                      const dup = await models.Transaction.findOne({
                          user_id: req.user.id,
                          account_id: acc.id,
                          date: row.date,
                          amount,
                          transaction_type: row.transaction_type,
                          description: { $regex: `^${escapeRegExp(row.description || '')}$`, $options: 'i' }
                      }, { id: 1, _id: 0 }).lean();
                      if (dup) {
                          skippedDuplicates += 1;
                          continue;
                      }

                      const txId = await getNextId('transactions');
                      await models.Transaction.create({
                          id: txId,
                          user_id: req.user.id,
                          account_id: acc.id,
                          category_id: cat ? cat.id : null,
                          amount,
                          date: row.date,
                          description: row.description,
                          transaction_type: row.transaction_type,
                          to_account_id: null,
                          receipt_url: null,
                          tag: null,
                          created_at: new Date().toISOString()
                      });
                      const balanceChange = row.transaction_type === 'Income' ? amount : -amount;
                      await adjustMongoAccountBalance(acc.id, balanceChange);
                      inserted += 1;
                  }
              }

              return res.json({ success: true, count: inserted, total_rows: results.length, skipped_duplicates: skippedDuplicates });
          } catch (e) {
              return res.status(400).json({ error: e.message });
          }
      });
});

app.put('/api/categories/:id/budget', authenticateToken, async (req, res) => {
    const { monthly_budget } = req.body;
    await models.Category.updateOne({ id: Number(req.params.id), user_id: req.user.id }, { $set: { monthly_budget } });
    return res.json({ success: true });
});

app.get('/api/debts', authenticateToken, async (req, res) => {
    const rows = await models.Debt.find({ user_id: req.user.id }, { _id: 0 }).lean();
    return res.json(rows);
});

app.post('/api/debts', authenticateToken, async (req, res) => {
    const { person_name, amount, type, due_date } = req.body;
    const id = await getNextId('debts');
    await models.Debt.create({ id, user_id: req.user.id, person_name, amount, type, due_date, status: 'Pending' });
    return res.json({ success: true, id });
});

app.put('/api/debts/:id/settle', authenticateToken, async (req, res) => {
    await models.Debt.updateOne({ id: Number(req.params.id), user_id: req.user.id }, { $set: { status: 'Settled' } });
    return res.json({ success: true });
});

app.get('/api/investments', async (req, res) => {
    const rows = await models.Investment.find({ user_id: req.user.id }, { _id: 0 }).sort({ id: -1 }).lean();
    return res.json(rows);
});

app.post('/api/investments', async (req, res) => {
    const { name, type, current_value, cost_basis, date, notes } = req.body;
    const nowIso = new Date().toISOString();
    let investmentDate = date;
    if (!investmentDate) {
        investmentDate = nowIso.split('T')[0];
    }
    const id = await getNextId('investments');
    await models.Investment.create({
        id,
        user_id: req.user.id,
        name,
        type,
        current_value: current_value || 0,
        cost_basis: cost_basis || 0,
        date: investmentDate,
        notes: notes || null,
        created_at: nowIso,
        updated_at: nowIso
    });
    return res.status(201).json({ id });
});

app.put('/api/investments/:id', async (req, res) => {
    const { name, type, current_value, cost_basis, date, notes } = req.body;
    const nowIso = new Date().toISOString();
    let investmentDate = date;
    if (!investmentDate) {
        investmentDate = nowIso.split('T')[0];
    }
    await models.Investment.updateOne(
        { id: Number(req.params.id), user_id: req.user.id },
        { $set: { name, type, current_value: current_value || 0, cost_basis: cost_basis || 0, date: investmentDate, notes: notes || null, updated_at: nowIso } }
    );
    return res.json({ success: true });
});

app.delete('/api/investments/:id', async (req, res) => {
    await models.Investment.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
    return res.json({ success: true });
});

app.get('/api/goals', async (req, res) => {
    const rows = await models.Goal.find({ user_id: req.user.id }, { _id: 0 }).sort({ id: -1 }).lean();
    return res.json(rows);
});

app.get('/api/goals/utilization-history', async (req, res) => {
    const rows = await models.GoalUtilizationHistory.find({ user_id: req.user.id }, { _id: 0 }).sort({ id: -1 }).lean();
    const accountIds = [...new Set(rows.map((r) => r.account_id).filter(Boolean))];
    const accounts = accountIds.length
        ? await models.Account.find({ id: { $in: accountIds } }, { id: 1, name: 1, _id: 0 }).lean()
        : [];
    const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
    const mappedRows = rows.map((r) => ({ ...r, resolved_account_name: r.account_name || accountMap.get(r.account_id) || null }));
    const total_utilized = mappedRows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
    return res.json({ items: mappedRows, total_utilized: Number(total_utilized || 0) });
});

app.post('/api/goals', async (req, res) => {
    const { title, target_amount, due_date } = req.body;
    const targetAmount = Number(target_amount || 0);
    if (targetAmount <= 0) return res.status(400).json({ error: 'Target amount must be greater than zero' });
    const nowIso = new Date().toISOString();
    const id = await getNextId('goals');
    await models.Goal.create({ id, user_id: req.user.id, title, target_amount: targetAmount, saved_amount: 0, due_date: due_date || null, status: 'Active', created_at: nowIso, updated_at: nowIso });
    return res.status(201).json({ id });
});

app.put('/api/goals/:id', async (req, res) => {
    const { title, target_amount, due_date } = req.body;
    const targetAmount = Number(target_amount || 0);
    if (targetAmount <= 0) return res.status(400).json({ error: 'Target amount must be greater than zero' });
    const goal = await models.Goal.findOne({ id: Number(req.params.id), user_id: req.user.id });
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    goal.title = title;
    goal.target_amount = targetAmount;
    goal.due_date = due_date || null;
    goal.status = Number(goal.saved_amount || 0) >= targetAmount ? 'Completed' : 'Active';
    goal.updated_at = new Date().toISOString();
    await goal.save();
    return res.json({ success: true });
});

app.put('/api/goals/:id/contribute', async (req, res) => {
    const { amount, account_id } = req.body;
    const contributeAmount = Number(amount || 0);
    if (contributeAmount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });

    const goal = await models.Goal.findOne({ id: Number(req.params.id), user_id: req.user.id });
    if (!goal) return res.status(404).json({ error: 'Goal not found' });

    const account = await models.Account.findOne({ id: Number(account_id), user_id: req.user.id });
    if (!account) return res.status(403).json({ error: 'No permission on account' });
    if (Number(account.balance || 0) < contributeAmount) return res.status(400).json({ error: 'Insufficient account balance' });

    goal.saved_amount = Number(goal.saved_amount || 0) + contributeAmount;
    goal.status = Number(goal.saved_amount || 0) >= Number(goal.target_amount || 0) ? 'Completed' : 'Active';
    goal.updated_at = new Date().toISOString();
    account.balance = Number(account.balance || 0) - contributeAmount;
    await goal.save();
    await account.save();

    const txId = await getNextId('transactions');
    await models.Transaction.create({
        id: txId,
        user_id: req.user.id,
        account_id: Number(account_id),
        category_id: null,
        amount: contributeAmount,
        date: new Date().toISOString().split('T')[0],
        description: `Goal Contribution: ${goal.title}`,
        transaction_type: 'Expense',
        tag: 'GoalContribution',
        created_at: new Date().toISOString()
    });
    return res.json({ success: true });
});

app.put('/api/goals/:id/withdraw', async (req, res) => {
    const { amount, account_id } = req.body;
    const withdrawAmount = Number(amount || 0);
    if (withdrawAmount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });

    const goal = await models.Goal.findOne({ id: Number(req.params.id), user_id: req.user.id });
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    if (Number(goal.saved_amount || 0) < withdrawAmount) return res.status(400).json({ error: 'Insufficient goal balance' });

    const account = await models.Account.findOne({ id: Number(account_id), user_id: req.user.id });
    if (!account) return res.status(403).json({ error: 'No permission on account' });

    goal.saved_amount = Number(goal.saved_amount || 0) - withdrawAmount;
    goal.status = Number(goal.saved_amount || 0) >= Number(goal.target_amount || 0) ? 'Completed' : 'Active';
    goal.updated_at = new Date().toISOString();
    account.balance = Number(account.balance || 0) + withdrawAmount;
    await goal.save();
    await account.save();

    const txId = await getNextId('transactions');
    await models.Transaction.create({
        id: txId,
        user_id: req.user.id,
        account_id: Number(account_id),
        category_id: null,
        amount: withdrawAmount,
        date: new Date().toISOString().split('T')[0],
        description: `Goal Withdrawal: ${goal.title}`,
        transaction_type: 'Income',
        tag: 'GoalWithdraw',
        created_at: new Date().toISOString()
    });
    return res.json({ success: true });
});

app.post('/api/goals/:id/utilize', async (req, res) => {
    const { utilize_mode, asset_type, asset_name, item_name } = req.body;
    const mode = String(utilize_mode || '').trim();
    const allowedModes = new Set(['convert_assets', 'buy_things']);

    if (!allowedModes.has(mode)) return res.status(400).json({ error: 'Invalid utilize mode' });

    const goal = await models.Goal.findOne({ id: Number(req.params.id), user_id: req.user.id }).lean();
    if (!goal) return res.status(404).json({ error: 'Goal not found' });
    const utilizeAmount = Number(goal.saved_amount || 0);
    if (utilizeAmount <= 0) return res.status(400).json({ error: 'Goal has no usable balance' });

    if (mode === 'convert_assets' && !String(asset_type || '').trim()) {
        return res.status(400).json({ error: 'Asset type is required' });
    }
    if (mode === 'convert_assets' && !String(asset_name || '').trim()) {
        return res.status(400).json({ error: 'Asset name is required' });
    }
    if (mode === 'buy_things' && !String(item_name || '').trim()) {
        return res.status(400).json({ error: 'Item name is required' });
    }

    try {
        if (mode === 'convert_assets') {
            const invId = await getNextId('investments');
            await models.Investment.create({
                id: invId,
                user_id: req.user.id,
                name: String(asset_name).trim(),
                type: String(asset_type),
                current_value: utilizeAmount,
                cost_basis: utilizeAmount,
                date: new Date().toISOString().split('T')[0],
                notes: `Created from goal utilization: ${goal.title}`,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            });
        }

        const histId = await getNextId('goal_utilization_history');
        await models.GoalUtilizationHistory.create({
            id: histId,
            user_id: req.user.id,
            goal_id: goal.id,
            goal_title: goal.title,
            utilize_mode: mode,
            amount: utilizeAmount,
            asset_type: asset_type ? String(asset_type) : null,
            asset_name: asset_name ? String(asset_name).trim() : null,
            item_name: item_name ? String(item_name) : null,
            account_id: null,
            account_name: null,
            created_at: new Date().toISOString()
        });

        await models.Goal.deleteOne({ id: goal.id, user_id: req.user.id });
        return res.json({ success: true });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Failed to utilize goal' });
    }
});

app.delete('/api/goals/:id', async (req, res) => {
    await models.Goal.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
    return res.json({ success: true });
});

app.get('/api/reconciliation/:accountId', async (req, res) => {
    const account = await models.Account.findOne({ id: Number(req.params.accountId), user_id: req.user.id }, { id: 1, name: 1, balance: 1, _id: 0 }).lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const txns = await models.Transaction.find({ user_id: req.user.id }, { _id: 0, amount: 1, transaction_type: 1, account_id: 1, to_account_id: 1 }).lean();
    const ledgerBalance = txns.reduce((sum, t) => {
        const amt = Number(t.amount || 0);
        if (t.transaction_type === 'Income' && t.account_id === account.id) return sum + amt;
        if (t.transaction_type === 'Expense' && t.account_id === account.id) return sum - amt;
        if (t.transaction_type === 'Transfer' && t.account_id === account.id) return sum - amt;
        if (t.transaction_type === 'Transfer' && t.to_account_id === account.id) return sum + amt;
        return sum;
    }, 0);
    return res.json({
        account_id: account.id,
        account_name: account.name,
        account_balance: Number(account.balance || 0),
        ledger_balance: Number(ledgerBalance || 0),
        difference: Number(account.balance || 0) - Number(ledgerBalance || 0)
    });
});

app.post('/api/reconciliation/:accountId', async (req, res) => {
    const statementBalance = Number(req.body.statement_balance || 0);
    const notes = req.body.notes || null;
    const account = await models.Account.findOne({ id: Number(req.params.accountId), user_id: req.user.id }, { id: 1, name: 1, balance: 1, _id: 0 }).lean();
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const diff = statementBalance - Number(account.balance || 0);
    const id = await getNextId('reconciliation_sessions');
    await models.ReconciliationSession.create({
        id,
        user_id: req.user.id,
        account_id: account.id,
        statement_balance: statementBalance,
        app_balance: Number(account.balance || 0),
        difference: diff,
        notes,
        created_at: new Date().toISOString()
    });
    return res.json({ success: true, difference: diff });
});

app.post('/api/snapshots/close-month', async (req, res) => {
    const key = String(req.body.month || monthKey()).slice(0, 7);
    const accounts = await models.Account.find({ user_id: req.user.id }, { id: 1, balance: 1, _id: 0 }).lean();
    for (const acc of accounts) {
        await models.BalanceSnapshot.updateOne(
            { user_id: req.user.id, snapshot_month: key, account_id: acc.id },
            { $set: { closing_balance: Number(acc.balance || 0), created_at: new Date().toISOString() }, $setOnInsert: { id: await getNextId('balance_snapshots') } },
            { upsert: true }
        );
    }
    return res.json({ success: true, month: key, count: accounts.length });
});

app.get('/api/snapshots', async (req, res) => {
    const [rows, accounts] = await Promise.all([
        models.BalanceSnapshot.find({ user_id: req.user.id }, { _id: 0 }).sort({ snapshot_month: -1, account_id: 1 }).lean(),
        models.Account.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
    ]);
    const accountMap = new Map(accounts.map((a) => [a.id, a.name]));
    return res.json(rows.map((r) => ({ ...r, account_name: accountMap.get(r.account_id) || null })));
});

app.get('/api/filters', async (req, res) => {
    const rows = await models.SavedFilter.find({ user_id: req.user.id }, { _id: 0 }).sort({ id: -1 }).lean();
    return res.json(rows.map(r => ({ ...r, filter: parseJSON(r.filter_json, {}) })));
});

app.post('/api/filters', async (req, res) => {
    const name = String(req.body.name || '').trim();
    const filter = req.body.filter || {};
    if (!name) return res.status(400).json({ error: 'Filter name is required.' });
    const id = await getNextId('saved_filters');
    await models.SavedFilter.create({ id, user_id: req.user.id, name, filter_json: JSON.stringify(filter), created_at: new Date().toISOString() });
    return res.json({ id });
});

app.delete('/api/filters/:id', async (req, res) => {
    await models.SavedFilter.deleteOne({ id: Number(req.params.id), user_id: req.user.id });
    return res.json({ success: true });
});

app.get('/api/reports/yearly-comparison', async (req, res) => {
    const rows = await models.Transaction.find({ user_id: req.user.id, transaction_type: { $ne: 'Transfer' } }, { _id: 0, date: 1, amount: 1, transaction_type: 1 }).lean();
    const yearMap = new Map();
    for (const r of rows) {
        const year = String(r.date || '').slice(0, 4);
        if (!yearMap.has(year)) yearMap.set(year, { year, income: 0, expense: 0 });
        const item = yearMap.get(year);
        if (r.transaction_type === 'Income') item.income += Number(r.amount || 0);
        if (r.transaction_type === 'Expense') item.expense += Number(r.amount || 0);
    }
    return res.json([...yearMap.values()].sort((a, b) => String(a.year).localeCompare(String(b.year))).map((r) => ({ ...r, savings: Number(r.income || 0) - Number(r.expense || 0) })));
});

app.get('/api/reports/tax-export', async (req, res) => {
    const [txRows, categories] = await Promise.all([
        models.Transaction.find({ user_id: req.user.id, transaction_type: { $ne: 'Transfer' } }, { _id: 0, date: 1, description: 1, amount: 1, transaction_type: 1, category_id: 1 }).sort({ date: -1, id: -1 }).lean(),
        models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
    ]);
    const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
    const rows = txRows.map((t) => {
        const category_name = categoryMap.get(t.category_id) || null;
        const tax_group = category_name === 'Salary' || category_name === 'Bonus'
            ? 'INCOME_TAXABLE'
            : category_name === 'Rent' || category_name === 'Utilities'
                ? 'HOME_EXPENSE'
                : category_name === 'Medical' || category_name === 'Insurance'
                    ? 'HEALTH_EXPENSE'
                    : category_name === 'Education'
                        ? 'EDUCATION_EXPENSE'
                        : 'GENERAL';
        return {
            date: t.date,
            description: t.description,
            amount: t.amount,
            transaction_type: t.transaction_type,
            category_name,
            tax_group
        };
    });
    const parser = new Parser({ fields: ['date', 'description', 'amount', 'transaction_type', 'category_name', 'tax_group'] });
    res.attachment('tax-ready-export.csv');
    return res.send(parser.parse(rows));
});

app.get('/api/reports/monthly-pdf', async (req, res) => {
    const m = String(req.query.month || monthKey()).slice(0, 7);
    const [txRows, categories] = await Promise.all([
        models.Transaction.find({ user_id: req.user.id, date: { $regex: `^${escapeRegExp(m)}` } }, { _id: 0, amount: 1, transaction_type: 1, category_id: 1 }).lean(),
        models.Category.find({ user_id: req.user.id }, { id: 1, name: 1, _id: 0 }).lean()
    ]);
    const categoryMap = new Map(categories.map((c) => [c.id, c.name || 'Uncategorized']));
    let incomeTotal = 0;
    let expenseTotal = 0;
    const catTotals = new Map();
    for (const t of txRows) {
        const amt = Number(t.amount || 0);
        if (t.transaction_type === 'Income') incomeTotal += amt;
        if (t.transaction_type === 'Expense') {
            expenseTotal += amt;
            const catName = categoryMap.get(t.category_id) || 'Uncategorized';
            catTotals.set(catName, (catTotals.get(catName) || 0) + amt);
        }
    }
    const summary = { income: incomeTotal, expense: expenseTotal };
    const topCats = [...catTotals.entries()]
        .map(([category, total]) => ({ category, total }))
        .sort((a, b) => Number(b.total) - Number(a.total))
        .slice(0, 5);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=monthly-report-${m}.pdf`);
    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    const income = Number(summary?.income || 0);
    const expense = Number(summary?.expense || 0);
    const savings = income - expense;

    doc.fontSize(20).text('Money Manager Monthly Report', { align: 'left' });
    doc.moveDown(0.5).fontSize(12).text(`Month: ${m}`);
    doc.moveDown(1);
    doc.fontSize(14).text(`Income: ${income.toFixed(2)}`);
    doc.fontSize(14).text(`Expense: ${expense.toFixed(2)}`);
    doc.fontSize(14).text(`Net Savings: ${savings.toFixed(2)}`);
    doc.moveDown(1).fontSize(14).text('Top Categories');
    if (!topCats.length) {
        doc.fontSize(12).text('No expense data for this month.');
    } else {
        topCats.forEach((c, idx) => doc.fontSize(12).text(`${idx + 1}. ${c.category || 'Uncategorized'} - ${Number(c.total || 0).toFixed(2)}`));
    }
    doc.end();
});

app.get('/api/backup/db', async (req, res) => {
    const backup = await buildMongoUserBackupPayload(req.user.id);
    res.header('Content-Type', 'application/json');
    res.attachment(`money-manager-backup-${Date.now()}.json`);
    return res.send(JSON.stringify(backup, null, 2));
});

app.post('/api/backup/restore', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No backup file uploaded' });
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (ext !== '.json') return res.status(400).json({ error: 'Please upload .json backup file.' });
    try {
        const payload = JSON.parse(fs.readFileSync(req.file.path, 'utf8'));
        const userId = req.user.id;
        const txIds = (await models.Transaction.find({ user_id: userId }, { id: 1, _id: 0 }).lean()).map((t) => t.id);
        const subIds = (await models.Subscription.find({ user_id: userId }, { id: 1, _id: 0 }).lean()).map((s) => s.id);

        if (txIds.length) await models.TransactionSplit.deleteMany({ transaction_id: { $in: txIds } });
        if (subIds.length) await models.RecurringRun.deleteMany({ subscription_id: { $in: subIds } });

        await Promise.all([
            models.Account.deleteMany({ user_id: userId }),
            models.Category.deleteMany({ user_id: userId }),
            models.Transaction.deleteMany({ user_id: userId }),
            models.Subscription.deleteMany({ user_id: userId }),
            models.Debt.deleteMany({ user_id: userId }),
            models.Investment.deleteMany({ user_id: userId }),
            models.Goal.deleteMany({ user_id: userId }),
            models.GoalUtilizationHistory.deleteMany({ user_id: userId }),
            models.Notification.deleteMany({ user_id: userId }),
            models.ActionHistory.deleteMany({ user_id: userId }),
            models.BalanceSnapshot.deleteMany({ user_id: userId }),
            models.ReconciliationSession.deleteMany({ user_id: userId }),
            models.SavedFilter.deleteMany({ user_id: userId }),
            models.QualityIssueOverride.deleteMany({ user_id: userId })
        ]);

        const safeInsert = async (Model, key) => {
            const rows = Array.isArray(payload?.[key]) ? payload[key] : [];
            if (!rows.length) return;
            await Model.insertMany(rows, { ordered: false });
        };

        const userRows = Array.isArray(payload?.users) ? payload.users.filter((u) => Number(u.id) === Number(userId)) : [];
        if (userRows.length) {
            await models.User.deleteOne({ id: userId });
            await models.User.insertMany(userRows, { ordered: false });
        }

        await safeInsert(models.Account, 'accounts');
        await safeInsert(models.Category, 'categories');
        await safeInsert(models.Transaction, 'transactions');
        await safeInsert(models.TransactionSplit, 'transaction_splits');
        await safeInsert(models.Subscription, 'subscriptions');
        await safeInsert(models.Debt, 'debts');
        await safeInsert(models.Investment, 'investments');
        await safeInsert(models.Goal, 'goals');
        await safeInsert(models.GoalUtilizationHistory, 'goal_utilization_history');
        await safeInsert(models.Notification, 'notifications');
        await safeInsert(models.RecurringRun, 'recurring_runs');
        await safeInsert(models.ActionHistory, 'action_history');
        await safeInsert(models.BalanceSnapshot, 'balance_snapshots');
        await safeInsert(models.ReconciliationSession, 'reconciliation_sessions');
        await safeInsert(models.SavedFilter, 'saved_filters');
        await safeInsert(models.QualityIssueOverride, 'quality_issue_overrides');

        res.json({ success: true, message: 'MongoDB backup restored successfully.' });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});