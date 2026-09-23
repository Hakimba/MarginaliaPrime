import { useCallback, useEffect, useRef, useState } from 'react';

interface UseLongPressOptions {
  onTap?: () => void;
  onLongPress?: () => void;
  onContextMenu?: () => void;
  onCancel?: () => void;
  threshold?: number;
  moveThreshold?: number;
}

interface UseLongPressResult {
  pressing: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onPointerLeave: (e: React.PointerEvent) => void;
    onClick: (e: React.MouseEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
}

export const useLongPress = (
  {
    onTap,
    onLongPress,
    onContextMenu,
    onCancel,
    threshold = 500,
    moveThreshold = 10,
  }: UseLongPressOptions,
  deps: React.DependencyList,
): UseLongPressResult => {
  const [pressing, setPressing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const pointerId = useRef<number | null>(null);
  const hasPointerEventsRef = useRef(false);
  const pointerEventTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const isLongPressTriggered = useRef(false);

  const capturedBy = useRef<Element | null>(null);

  const releaseCapture = useCallback(() => {
    const element = capturedBy.current;
    capturedBy.current = null;
    if (!element || pointerId.current == null) return;
    try {
      element.releasePointerCapture(pointerId.current);
    } catch {
      // The pointer may already be gone; nothing to release.
    }
  }, []);

  const reset = useCallback(() => {
    releaseCapture();
    setPressing(false);
    isLongPressTriggered.current = false;
    startPosRef.current = null;
    pointerId.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
  }, [releaseCapture]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) {
        return;
      }

      hasPointerEventsRef.current = true;
      if (pointerEventTimeoutRef.current) {
        clearTimeout(pointerEventTimeoutRef.current);
      }

      pointerId.current = e.pointerId;
      startPosRef.current = { x: e.clientX, y: e.clientY };

      // Hold the pointer for the whole press. The press feedback shrinks the
      // item by 5%, so its edge can slide out from under a cursor that has not
      // moved; the browser then fires pointerleave, the press is cancelled and
      // the click is lost. Capture makes a press depend on the finger only.
      const element = e.currentTarget as Element;
      try {
        element.setPointerCapture(e.pointerId);
        capturedBy.current = element;
      } catch {
        capturedBy.current = null;
      }
      isLongPressTriggered.current = false;
      setPressing(true);

      timerRef.current = setTimeout(() => {
        if (startPosRef.current) {
          isLongPressTriggered.current = true;
          onLongPress?.();
          setPressing(false);
        }
      }, threshold);
    },
    [onLongPress, threshold],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId !== pointerId.current || !startPosRef.current) return;

      const deltaX = Math.abs(e.clientX - startPosRef.current.x);
      const deltaY = Math.abs(e.clientY - startPosRef.current.y);

      if (deltaX > moveThreshold || deltaY > moveThreshold) {
        onCancel?.();
        reset();
      }
    },
    [moveThreshold, onCancel, reset],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId !== pointerId.current) return;

      if (!isLongPressTriggered.current && startPosRef.current) {
        const deltaX = Math.abs(e.clientX - startPosRef.current.x);
        const deltaY = Math.abs(e.clientY - startPosRef.current.y);

        if (deltaX <= moveThreshold && deltaY <= moveThreshold) {
          onTap?.();
        }
      }

      reset();

      pointerEventTimeoutRef.current = setTimeout(() => {
        hasPointerEventsRef.current = false;
      }, 200);
    },
    [onTap, moveThreshold, reset],
  );

  const handleCancel = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerId !== pointerId.current) return;
      onCancel?.();
      reset();

      pointerEventTimeoutRef.current = setTimeout(() => {
        hasPointerEventsRef.current = false;
      }, 200);
    },
    [onCancel, reset],
  );

  /** With the pointer captured, leaving the element is not a cancellation. */
  const handleLeave = useCallback(
    (e: React.PointerEvent) => {
      if (capturedBy.current) return;
      handleCancel(e);
    },
    [handleCancel],
  );

  const handleClick = useCallback(() => {
    // This is only for aria activation, if the user has used pointer events, we ignore the click event
    if (!hasPointerEventsRef.current) {
      onTap?.();
    }
  }, [onTap]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (onContextMenu) {
        e.preventDefault();
        e.stopPropagation();
        setTimeout(() => {
          onContextMenu();
        }, 100);
      }
      reset();
    },
    [onContextMenu, reset],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return {
    pressing,
    handlers: {
      onPointerDown: handlePointerDown,
      onPointerUp: handlePointerUp,
      onPointerMove: handlePointerMove,
      onPointerCancel: handleCancel,
      onPointerLeave: handleLeave,
      onClick: handleClick,
      onContextMenu: handleContextMenu,
    },
  };
};
