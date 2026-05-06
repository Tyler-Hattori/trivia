import { FIELD_SCHEMA } from './settings.js';

export const state = {
    QUIZ_SETTINGS: window.QUIZ_SETTINGS || {
      count: 0,
      order: 'random',
      fields: [...FIELD_SCHEMA]
    },
    ACTIVE_FIELDS: window.ACTIVE_FIELDS || [...FIELD_SCHEMA],
    token: localStorage.getItem('gh_pat') || '',
    active: null,
    data: [],
    queue: [],
    current: null,
    submitted: false,
    streak: 0,
    bestStreak: 0,
    answered: 0,
    perfect: 0,
    totalFieldsAttempted: 0,
    totalFieldsCorrect: 0,
    yearErrors: [],
    bestAcc: 0,
    bestRmse: Infinity,
    fieldStats: {},
    activeFilters: new Set()
};