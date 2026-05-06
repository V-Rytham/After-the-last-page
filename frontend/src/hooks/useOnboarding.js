import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  completeOnboarding as completeOnboardingManager,
  getHighlightBookId,
  getStep,
  hasCompletedOnboarding,
  nextStep as nextStepManager,
} from '../onboardingManager';

const readSnapshot = () => ({
  step: getStep(),
  completed: hasCompletedOnboarding(),
  highlightBookId: getHighlightBookId(),
});

export default function useOnboarding() {
  const [snapshot, setSnapshot] = useState(() => readSnapshot());

  useEffect(() => {
    const sync = () => setSnapshot(readSnapshot());

    const handleCustom = () => sync();
    const handleStorage = (event) => {
      if (!event) return;
      if (event.key === 'hasCompletedOnboarding' || event.key === 'onboardingStep' || event.key === 'onboardingHighlightBookId') {
        sync();
      }
    };

    window.addEventListener('onboarding:change', handleCustom);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('onboarding:change', handleCustom);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const nextStep = useCallback(() => nextStepManager(), []);
  const completeOnboarding = useCallback(() => completeOnboardingManager(), []);

  return useMemo(() => ({
    step: snapshot.step,
    completed: snapshot.completed,
    highlightBookId: snapshot.highlightBookId,
    nextStep,
    completeOnboarding,
  }), [completeOnboarding, nextStep, snapshot.completed, snapshot.highlightBookId, snapshot.step]);
}

