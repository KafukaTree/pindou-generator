'use client';

import { useState, useEffect, useCallback } from 'react';
import { Brand } from '@/lib/colors';

export interface PatternHistoryItem {
  id: string;
  timestamp: number;
  previewUrl: string;
  settings: {
    gridSize: number;
    colorCount: number;
    brand: Brand;
  };
}

const MAX_HISTORY_ITEMS = 10;
const HISTORY_KEY = 'perler-bead-history';

export function useHistory() {
  const [history, setHistory] = useState<PatternHistoryItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);

  // Load history from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored) {
        setHistory(JSON.parse(stored));
      }
    } catch (error) {
      console.error('Failed to load history:', error);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  // Save history to localStorage
  const saveHistory = useCallback((items: PatternHistoryItem[]) => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
    } catch (error) {
      console.error('Failed to save history:', error);
    }
  }, []);

  // Add item to history
  const addToHistory = useCallback(
    (item: Omit<PatternHistoryItem, 'id' | 'timestamp'>) => {
      const newItem: PatternHistoryItem = {
        ...item,
        id: crypto.randomUUID(),
        timestamp: Date.now(),
      };

      setHistory((prev) => {
        // Check if identical item already exists (same settings)
        const exists = prev.some(
          (p) =>
            p.settings.gridSize === item.settings.gridSize &&
            p.settings.colorCount === item.settings.colorCount &&
            p.settings.brand === item.settings.brand &&
            p.previewUrl === item.previewUrl
        );

        if (exists) {
          return prev; // Don't add duplicates
        }

        const newHistory = [newItem, ...prev].slice(0, MAX_HISTORY_ITEMS);
        saveHistory(newHistory);
        return newHistory;
      });

      return newItem.id;
    },
    [saveHistory]
  );

  // Remove item from history
  const removeFromHistory = useCallback(
    (id: string) => {
      setHistory((prev) => {
        const newHistory = prev.filter((item) => item.id !== id);
        saveHistory(newHistory);
        return newHistory;
      });
    },
    [saveHistory]
  );

  // Clear all history
  const clearHistory = useCallback(() => {
    setHistory([]);
    localStorage.removeItem(HISTORY_KEY);
  }, []);

  // Get item by ID
  const getItem = useCallback(
    (id: string): PatternHistoryItem | undefined => {
      return history.find((item) => item.id === id);
    },
    [history]
  );

  return {
    history,
    isLoaded,
    addToHistory,
    removeFromHistory,
    clearHistory,
    getItem,
  };
}
