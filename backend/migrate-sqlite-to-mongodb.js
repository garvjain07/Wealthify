const path = require('path');
const mongoose = require('mongoose');
const { models } = require('./mongoModels');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'database.sqlite');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/money-manager';

const tableToModel = {
  users: models.User,
  accounts: models.Account,
  categories: models.Category,
  transactions: models.Transaction,
  transaction_splits: models.TransactionSplit,
  subscriptions: models.Subscription,
  debts: models.Debt,
  investments: models.Investment,
  goals: models.Goal,
  goal_utilization_history: models.GoalUtilizationHistory,
  notifications: models.Notification,
  recurring_runs: models.RecurringRun,
  action_history: models.ActionHistory,
  balance_snapshots: models.BalanceSnapshot,
  reconciliation_sessions: models.ReconciliationSession,
  saved_filters: models.SavedFilter,
  quality_issue_overrides: models.QualityIssueOverride
};

async function migrateTable(db, tableName, model) {
  const rows = await db.all(`SELECT * FROM ${tableName}`);
  await model.deleteMany({});
  if (rows.length) {
    await model.insertMany(rows, { ordered: false });
  }
  console.log(`${tableName}: ${rows.length} row(s) migrated`);
}

async function run() {
  let sqlite3;
  let open;
  try {
    sqlite3 = require('sqlite3');
    ({ open } = require('sqlite'));
  } catch (_) {
    throw new Error('SQLite migration dependencies are not installed. Run: npm --prefix backend install sqlite sqlite3');
  }

  const sqliteDb = await open({
    filename: SQLITE_PATH,
    driver: sqlite3.Database
  });

  try {
    await mongoose.connect(MONGO_URI);
    console.log(`Connected to MongoDB: ${MONGO_URI}`);

    for (const [tableName, model] of Object.entries(tableToModel)) {
      await migrateTable(sqliteDb, tableName, model);
    }

    console.log('SQLite to MongoDB migration completed successfully.');
  } finally {
    await sqliteDb.close();
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});