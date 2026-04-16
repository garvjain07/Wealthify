const mongoose = require('mongoose');
const { models } = require('./mongoModels');

const CounterSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 }
  },
  { versionKey: false }
);

const Counter = mongoose.models.Counter || mongoose.model('Counter', CounterSchema);

const sequenceToModel = {
  users: 'User',
  accounts: 'Account',
  categories: 'Category',
  transactions: 'Transaction',
  transaction_splits: 'TransactionSplit',
  subscriptions: 'Subscription',
  debts: 'Debt',
  investments: 'Investment',
  goals: 'Goal',
  goal_utilization_history: 'GoalUtilizationHistory',
  notifications: 'Notification',
  recurring_runs: 'RecurringRun',
  action_history: 'ActionHistory',
  balance_snapshots: 'BalanceSnapshot',
  reconciliation_sessions: 'ReconciliationSession',
  saved_filters: 'SavedFilter',
  quality_issue_overrides: 'QualityIssueOverride'
};

async function getMaxIdForSequence(sequenceName) {
  const modelName = sequenceToModel[sequenceName];
  if (!modelName || !models[modelName]) return 0;
  const row = await models[modelName].findOne({}, { id: 1, _id: 0 }).sort({ id: -1 }).lean();
  return Number(row?.id || 0);
}

async function initializeMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/money-manager';
  await mongoose.connect(uri);
  return { mongoose, models };
}

async function getNextId(sequenceName) {
  let counter = await Counter.findById(sequenceName).lean();
  const maxId = await getMaxIdForSequence(sequenceName);

  if (!counter) {
    counter = await Counter.create({ _id: sequenceName, seq: maxId });
  } else if (Number(counter.seq || 0) < maxId) {
    await Counter.updateOne({ _id: sequenceName }, { $set: { seq: maxId } });
  }

  const next = await Counter.findOneAndUpdate(
    { _id: sequenceName },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return next.seq;
}

module.exports = { initializeMongo, getNextId, models };
