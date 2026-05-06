import { log } from './utils/logger';

const COMPLETED_KEY = 'hasCompletedOnboarding';
const STEP_KEY = 'onboardingStep';
const HIGHLIGHT_BOOK_KEY = 'onboardingHighlightBookId';

const clampStep = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(4, Math.floor(numeric)));
};

const readBoolean = (key) => String(window.localStorage.getItem(key) || '').toLowerCase() === 'true';

const readStep = () => clampStep(window.localStorage.getItem(STEP_KEY));

const readHighlightBookId = () => String(window.localStorage.getItem(HIGHLIGHT_BOOK_KEY) || '').trim();

const emitChange = () => {
  const detail = {
    step: readStep(),
    completed: readBoolean(COMPLETED_KEY),
    highlightBookId: readHighlightBookId(),
  };
  window.dispatchEvent(new CustomEvent('onboarding:change', { detail }));
};

const setStep = (nextStep) => {
  const step = clampStep(nextStep);
  window.localStorage.setItem(STEP_KEY, String(step));
  log('Onboarding Step:', step);
  emitChange();
  return step;
};

export const hasCompletedOnboarding = () => readBoolean(COMPLETED_KEY);

export const getStep = () => readStep();

export const getHighlightBookId = () => readHighlightBookId();

export const setHighlightBookId = (bookId) => {
  const next = String(bookId || '').trim();
  if (!next) return '';
  window.localStorage.setItem(HIGHLIGHT_BOOK_KEY, next);
  emitChange();
  return next;
};

export const nextStep = () => {
  if (hasCompletedOnboarding()) return getStep();
  const current = getStep();
  return setStep(current + 1);
};

export const completeOnboarding = () => {
  window.localStorage.setItem(COMPLETED_KEY, 'true');
  setStep(4);
  emitChange();
};

