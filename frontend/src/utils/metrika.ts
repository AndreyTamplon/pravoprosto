// Yandex.Metrika helper.
//
// Базовый счётчик подключается в index.html (в <head>) и сам отправляет первый
// просмотр страницы при инициализации. SPA-навигация (react-router) не
// перезагружает страницу, поэтому последующие переходы нужно слать вручную через
// ym('hit', url) — этим занимается useMetrikaPageViews.
//
// В dev/e2e счётчик не подключается (см. гард по hostname в index.html), поэтому
// window.ym отсутствует и все вызовы здесь становятся no-op.

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

export const YM_COUNTER_ID = 109475323;

declare global {
  interface Window {
    ym?: (counterId: number, action: string, ...args: unknown[]) => void;
  }
}

/** Отправить просмотр страницы (no-op, если счётчик не подключён). */
export function ymHit(url: string): void {
  window.ym?.(YM_COUNTER_ID, 'hit', url);
}

/** Отправить достижение цели (no-op, если счётчик не подключён). */
export function ymReachGoal(goal: string, params?: Record<string, unknown>): void {
  window.ym?.(YM_COUNTER_ID, 'reachGoal', goal, params);
}

/**
 * Отслеживает SPA-переходы и шлёт ym('hit') на каждую смену URL.
 * Первый рендер пропускаем — этот просмотр уже учтён счётчиком при init.
 */
export function useMetrikaPageViews(): void {
  const location = useLocation();
  const isFirst = useRef(true);

  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    ymHit(location.pathname + location.search + location.hash);
  }, [location.pathname, location.search, location.hash]);
}
