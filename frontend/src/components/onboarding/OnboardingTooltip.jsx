import React, { useEffect, useMemo, useState } from 'react';
import './Onboarding.css';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const resolveTarget = (targetSelector) => {
  if (!targetSelector) return null;
  try {
    return document.querySelector(targetSelector);
  } catch {
    return null;
  }
};

export default function OnboardingTooltip({
  targetSelector,
  text,
  placement = 'bottom',
  offset = 10,
}) {
  const [rect, setRect] = useState(null);

  useEffect(() => {
    let rafId = 0;

    const update = () => {
      const target = resolveTarget(targetSelector);
      if (!target) {
        setRect(null);
        return;
      }
      const next = target.getBoundingClientRect();
      setRect(next);
    };

    const tick = () => {
      update();
      rafId = window.requestAnimationFrame(tick);
    };

    tick();
    return () => window.cancelAnimationFrame(rafId);
  }, [targetSelector]);

  const style = useMemo(() => {
    if (!rect) return null;
    const viewportW = window.innerWidth || 0;
    const viewportH = window.innerHeight || 0;

    const bubbleW = 320;
    const bubbleH = 86;

    let top = 0;
    let left = 0;

    switch (placement) {
      case 'top':
        top = rect.top - offset - bubbleH;
        left = rect.left + rect.width / 2 - bubbleW / 2;
        break;
      case 'left':
        top = rect.top + rect.height / 2 - bubbleH / 2;
        left = rect.left - offset - bubbleW;
        break;
      case 'right':
        top = rect.top + rect.height / 2 - bubbleH / 2;
        left = rect.right + offset;
        break;
      case 'bottom':
      default:
        top = rect.bottom + offset;
        left = rect.left + rect.width / 2 - bubbleW / 2;
        break;
    }

    return {
      top: `${clamp(top, 8, Math.max(8, viewportH - bubbleH - 8))}px`,
      left: `${clamp(left, 8, Math.max(8, viewportW - bubbleW - 8))}px`,
      width: `${Math.min(bubbleW, Math.max(220, viewportW - 16))}px`,
    };
  }, [offset, placement, rect]);

  if (!style) return null;

  return (
    <div className="onboarding-tooltip onboarding-fade-in" style={style} aria-hidden="true">
      <div className="onboarding-tooltip__bubble">{text}</div>
    </div>
  );
}

